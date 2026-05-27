import type { TiktokClient } from '../tiktok/client';
import type { MarketplaceConnection } from './types';
import {
  findTiktokConnectionForToolShopId,
  listTiktokShopCiphers,
  resolveTiktokToolShop,
  tiktokCipherPriorityList,
} from './marketplace-auth';

/** Composite cursor key separator — shared by search-orders and search-products. */
export const TIKTOK_CURSOR_SEP = '\u001f';

export interface TiktokSearchSlice {
  conn: MarketplaceConnection;
  cursorKey: string;
  cipher: string;
  /** When multi-cipher, first slice for this conn accepts legacy `byShop[open_id]` cursors. */
  useLegacyOpenIdCursor: boolean;
}

/**
 * Expand tenant TikTok connections into per-`shop_cipher` search slices.
 * Mirrors `search-orders` / `search-products` TikTok pagination.
 */
export function buildTiktokSearchSlices(conns: MarketplaceConnection[]): TiktokSearchSlice[] {
  const out: TiktokSearchSlice[] = [];
  for (const conn of conns) {
    const ciphers = listTiktokShopCiphers(conn);
    if (ciphers.length === 0) {
      throw new Error(
        'TikTok connection is missing shop_cipher. Reconnect TikTok and ensure authorized shops scope is granted.',
      );
    }
    if (ciphers.length === 1) {
      out.push({
        conn,
        cursorKey: conn.external_shop_id,
        cipher: ciphers[0],
        useLegacyOpenIdCursor: true,
      });
    } else {
      for (let j = 0; j < ciphers.length; j++) {
        const cipher = ciphers[j];
        out.push({
          conn,
          cursorKey: `${conn.external_shop_id}${TIKTOK_CURSOR_SEP}${cipher}`,
          cipher,
          useLegacyOpenIdCursor: j === 0,
        });
      }
    }
  }
  return out;
}

/**
 * Match order action tools (`confirm-order-fulfillment`, `create-fulfillment-package`):
 * when `shopId` is set, resolve one connection; otherwise search all tenant connections.
 */
export function pickTiktokConnectionsForTool(
  conns: MarketplaceConnection[],
  shopId?: string | null,
): MarketplaceConnection[] {
  const sid = shopId?.trim();
  if (sid) {
    const match = findTiktokConnectionForToolShopId(conns, sid);
    return match ? [match] : [];
  }
  return conns;
}

/** Prefer actionable errors over misleading 36009003 / 12052900 from wrong-shop attempts. */
function tiktokShopErrorPriority(message: string): number {
  if (/code=105005\b/.test(message)) return 100;
  if (/code=12052048\b|Can't edit other sellers/i.test(message)) return 90;
  if (/code=106011\b|Invalid shop_cipher/i.test(message)) return 80;
  if (/code=36009003\b|Inner Code: 12052900/.test(message)) return 10;
  return 50;
}

function pickHigherPriorityTiktokError(current: string, next: string): string {
  return tiktokShopErrorPriority(next) > tiktokShopErrorPriority(current) ? next : current;
}

/** Non-retryable business validation failure inside a cipher attempt. */
export class TiktokToolError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'TiktokToolError';
  }
}

export type TiktokShopCipherHit<T> = {
  value: T;
  conn: MarketplaceConnection;
  shopCipher: string;
};

/**
 * Run a TikTok operation for one shop. When `shopIdHint` is set, resolves that shop only
 * (no connection/cipher loop). Without `shopIdHint`, tries each connection × cipher (order tools).
 */
export async function tryTiktokShopCipherLoop<T>(args: {
  conns: MarketplaceConnection[];
  shopIdHint?: string | null;
  getClient: (conn: MarketplaceConnection) => Promise<TiktokClient>;
  run: (ctx: {
    conn: MarketplaceConnection;
    client: TiktokClient;
    shopCipher: string;
  }) => Promise<T>;
}): Promise<TiktokShopCipherHit<T> | { error: string }> {
  const sid = args.shopIdHint?.trim();
  if (sid) {
    const resolved = resolveTiktokToolShop(args.conns, sid);
    if ('error' in resolved) return { error: resolved.error };
    const client = await args.getClient(resolved.conn);
    try {
      const value = await args.run({
        conn: resolved.conn,
        client,
        shopCipher: resolved.shopCipher,
      });
      return { value, conn: resolved.conn, shopCipher: resolved.shopCipher };
    } catch (e) {
      if (e instanceof TiktokToolError) return { error: e.message };
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const targets = pickTiktokConnectionsForTool(args.conns, null);
  if (targets.length === 0) {
    return { error: 'No TikTok connection found for tenant.' };
  }

  let lastErr = 'TikTok operation failed for all connected shops.';
  for (const conn of targets) {
    const ciphers = tiktokCipherPriorityList(conn, null);
    if (ciphers.length === 0) {
      lastErr =
        'TikTok connection is missing shop_cipher. Reconnect TikTok and grant authorized-shops scope.';
      continue;
    }
    const client = await args.getClient(conn);
    for (const shopCipher of ciphers) {
      try {
        const value = await args.run({ conn, client, shopCipher });
        return { value, conn, shopCipher };
      } catch (e) {
        if (e instanceof TiktokToolError) {
          return { error: e.message };
        }
        const msg = e instanceof Error ? e.message : String(e);
        lastErr = pickHigherPriorityTiktokError(lastErr, msg);
      }
    }
  }

  return { error: lastErr };
}
