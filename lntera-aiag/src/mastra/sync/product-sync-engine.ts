// Resync a tenant's marketplace catalog into tenant_products: list every product (Shopee by offset,
// TikTok by per-cipher page_token), fetch its detail, and run it through the ingest router. Bounded
// by maxItems with a resumable cursor (checked at PAGE boundaries, so the cap is soft by up to one
// page). Notices are returned for the CALLER to dispatch at end-of-run (lets the coalescer batch).
import type { MarketplaceConnection, Platform } from '../integrations/shared/types';
import { listConnectionsByTenant } from '../integrations/shared/supabase';
import { getShopeeClient } from '../integrations/shopee/client';
import { getTiktokClient } from '../integrations/tiktok/client';
import { searchShopeeProducts } from '../integrations/shopee/products';
import { searchTiktokProducts } from '../integrations/tiktok/products';
import { listTiktokShopCiphers } from '../integrations/shared/marketplace-auth';
import { fetchNormalizedProductDetail } from '../integrations/shared/product-detail-fetch';
import {
  ingestMarketplaceProduct,
  type IngestResult,
  type ProductSyncNotice,
} from '../integrations/products/ingest-marketplace-product';

export interface ResyncSummary {
  status: 'all_synced' | 'processed' | 'no_connection' | 'partial_error';
  scanned: number;
  autoCreated: number;
  autoMapped: number;
  awaitingReview: number;
  alreadyMapped: number;
  errors: Array<{ productId?: string; message: string }>;
  notices: ProductSyncNotice[];
  nextCursor: string | null;
}

export interface ResyncOptions {
  tenantId: string;
  platform?: Platform;
  connectionId?: string;
  maxItems?: number;
  pageSize?: number;
  cursor?: string | null;
}

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_PAGE_SIZE = 50;

interface PageSource {
  id: string;
  connection: MarketplaceConnection;
  kind: 'shopee' | 'tiktok';
  cipher?: string;
}

interface ResyncCursor {
  done: string[];
  pos: Record<string, string | number>;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function decodeResyncCursor(cursor: string | null | undefined): ResyncCursor {
  if (!cursor) return { done: [], pos: {} };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      return { done: Array.isArray(parsed.done) ? parsed.done : [], pos: parsed.pos ?? {} };
    }
  } catch {
    /* start fresh on a malformed cursor */
  }
  return { done: [], pos: {} };
}

function encodeResyncCursor(c: ResyncCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function buildSources(connections: MarketplaceConnection[]): PageSource[] {
  const sources: PageSource[] = [];
  for (const conn of connections) {
    if (conn.platform === 'shopee') {
      sources.push({ id: conn.id, connection: conn, kind: 'shopee' });
    } else if (conn.platform === 'tiktok') {
      const ciphers = listTiktokShopCiphers(conn);
      if (ciphers.length === 0) {
        // Surface as a per-source error later by emitting a single cipher-less source.
        sources.push({ id: conn.id, connection: conn, kind: 'tiktok' });
      } else {
        for (const cipher of ciphers) {
          sources.push({ id: `${conn.id}|${cipher}`, connection: conn, kind: 'tiktok', cipher });
        }
      }
    }
  }
  return sources;
}

async function listSourcePage(
  src: PageSource,
  pageCursor: string | number | undefined,
  pageSize: number,
): Promise<{ productIds: string[]; hasMore: boolean; next: string | number | null }> {
  if (src.kind === 'shopee') {
    const client = await getShopeeClient(src.connection.external_shop_id);
    const offset = typeof pageCursor === 'number' ? pageCursor : 0;
    const page = await searchShopeeProducts(client, { pageSize, offset, includeRaw: false });
    return {
      productIds: page.products.map((p) => p.productId),
      hasMore: page.hasMore,
      next: typeof page.nextOffset === 'number' ? page.nextOffset : null,
    };
  }
  if (!src.cipher) {
    throw new Error('TikTok connection is missing shop_cipher. Reconnect TikTok with authorized shops scope.');
  }
  const client = await getTiktokClient(src.connection.external_shop_id);
  const pageToken = typeof pageCursor === 'string' ? pageCursor : undefined;
  const page = await searchTiktokProducts(client, {
    pageSize,
    pageToken,
    shopCipher: src.cipher,
    includeRaw: false,
  });
  return {
    productIds: page.products.map((p) => p.productId),
    hasMore: page.hasMore,
    next: page.nextPageToken ?? null,
  };
}

export async function resyncMarketplaceProducts(opts: ResyncOptions): Promise<ResyncSummary> {
  const tenantId = opts.tenantId;
  const maxItems = Math.max(1, opts.maxItems ?? DEFAULT_MAX_ITEMS);
  const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? DEFAULT_PAGE_SIZE));

  let connections = await listConnectionsByTenant(tenantId, opts.platform ? [opts.platform] : undefined);
  if (opts.connectionId) connections = connections.filter((c) => c.id === opts.connectionId);

  const empty: ResyncSummary = {
    status: 'no_connection',
    scanned: 0,
    autoCreated: 0,
    autoMapped: 0,
    awaitingReview: 0,
    alreadyMapped: 0,
    errors: [],
    notices: [],
    nextCursor: null,
  };
  if (connections.length === 0) return empty;

  const sources = buildSources(connections);
  const cursor = decodeResyncCursor(opts.cursor);
  const done = new Set(cursor.done);

  let scanned = 0;
  let autoCreated = 0;
  let autoMapped = 0;
  let awaitingReview = 0;
  let alreadyMapped = 0;
  const errors: ResyncSummary['errors'] = [];
  const notices: ProductSyncNotice[] = [];
  let capped = false;

  const tally = (r: IngestResult) => {
    switch (r.decision) {
      case 'auto_created':
        autoCreated += 1;
        break;
      case 'auto_mapped':
        autoMapped += 1;
        break;
      case 'suggest_map':
      case 'suggest_medium':
      case 'unmatched':
        awaitingReview += 1;
        break;
      case 'already_decided':
        alreadyMapped += 1;
        break;
    }
    if (r.notice) notices.push(r.notice);
  };

  outer: for (const src of sources) {
    if (done.has(src.id)) continue;
    let pageCursor: string | number | undefined = cursor.pos[src.id];

    while (true) {
      let page: Awaited<ReturnType<typeof listSourcePage>>;
      try {
        page = await listSourcePage(src, pageCursor, pageSize);
      } catch (e) {
        errors.push({ message: `list ${src.kind} (${src.id}): ${describeError(e)}` });
        done.add(src.id);
        delete cursor.pos[src.id];
        break;
      }

      for (const productId of page.productIds) {
        try {
          const detail = await fetchNormalizedProductDetail({
            connection: src.connection,
            productId,
            shopCipher: src.cipher ?? null,
          });
          if (!detail) {
            errors.push({ productId, message: 'product detail not found' });
            scanned += 1;
            continue;
          }
          const result = await ingestMarketplaceProduct({
            tenantId,
            connection: src.connection,
            detail,
            trigger: 'resync',
          });
          tally(result);
        } catch (e) {
          errors.push({ productId, message: describeError(e) });
        }
        scanned += 1;
      }

      if (!page.hasMore || page.next == null) {
        done.add(src.id);
        delete cursor.pos[src.id];
        break;
      }
      pageCursor = page.next;
      cursor.pos[src.id] = page.next;
      if (scanned >= maxItems) {
        capped = true;
        break outer;
      }
    }
  }

  const remaining = sources.some((s) => !done.has(s.id));
  const nextCursor = capped && remaining ? encodeResyncCursor({ done: [...done], pos: cursor.pos }) : null;

  let status: ResyncSummary['status'];
  if (errors.length > 0 && scanned > 0) status = 'partial_error';
  else if (errors.length > 0 && scanned === 0) status = 'partial_error';
  else if (scanned > 0 && autoCreated === 0 && autoMapped === 0 && awaitingReview === 0)
    status = 'all_synced';
  else status = 'processed';

  return {
    status,
    scanned,
    autoCreated,
    autoMapped,
    awaitingReview,
    alreadyMapped,
    errors,
    notices,
    nextCursor,
  };
}
