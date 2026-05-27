import type { TiktokClient } from './client';
import type { ShippingLabelResult } from '../shared/shipping-labels';
import { resolveTiktokPackageIdsToShip } from './fulfillment';

/** GET /fulfillment/202309/packages/{package_id}/shipping_documents (Partner Fulfillment 202309). */
function shippingDocumentsPath(packageId: string): string {
  const id = encodeURIComponent(packageId.trim());
  return `/fulfillment/202309/packages/${id}/shipping_documents`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function extractTiktokLabelDetails(data: unknown): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  const urls: string[] = [];

  const walk = (obj: unknown, depth: number) => {
    if (depth > 8 || obj == null) return;
    if (typeof obj === 'string') {
      if (obj.startsWith('http://') || obj.startsWith('https://')) urls.push(obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (const x of obj) walk(x, depth + 1);
      return;
    }
    const r = asRecord(obj);
    if (!r) return;
    for (const [k, v] of Object.entries(r)) {
      const lk = k.toLowerCase();
      if (
        (lk.includes('url') || lk.includes('link') || lk.endsWith('uri')) &&
        typeof v === 'string' &&
        v.startsWith('http')
      ) {
        urls.push(v);
      }
      if ((lk.includes('base64') || lk === 'content' || lk === 'file') && typeof v === 'string' && v.length > 40) {
        doc[k] = v.length > 2000 ? `${v.slice(0, 80)}… (${v.length} chars)` : v;
      }
      walk(v, depth + 1);
    }
  };

  walk(data, 0);
  const uniq = Array.from(new Set(urls));
  if (uniq.length > 0) doc.download_urls = uniq;
  if (Object.keys(doc).length === 0) doc.envelope = data;
  return doc;
}

/** TikTok `GET .../shipping_documents`: `document_size` query must be one of these (Partner API rejects numeric 0). */
export type TiktokShippingDocumentSize = 'A5' | 'A6';

const DEFAULT_TIKTOK_SHIPPING_DOCUMENT_SIZE: TiktokShippingDocumentSize = 'A6';

export interface TiktokShippingLabelOptions {
  documentType?: string;
  /** Label paper size — API accepts only **A5** or **A6**; omit to use `A6`. */
  documentSize?: TiktokShippingDocumentSize;
  embedDocument?: boolean;
  includeRaw?: boolean;
}

const EMBED_MAX_CHARS = 1_000_000;

/**
 * TikTok Shop: fetch shipping document(s) for an order or package id
 * (`GET .../packages/{id}/shipping_documents`).
 */
export async function fetchTiktokShippingLabels(
  client: TiktokClient,
  id: string,
  shopCipher: string,
  options: TiktokShippingLabelOptions = {},
): Promise<ShippingLabelResult> {
  const trimmed = id.trim();
  if (!trimmed) {
    return { id, platform: 'tiktok', success: false, message: 'Empty order/package id.' };
  }

  const documentType = (options.documentType ?? 'SHIPPING_LABEL').trim();
  const docSize =
    options.documentSize === 'A5' || options.documentSize === 'A6'
      ? options.documentSize
      : DEFAULT_TIKTOK_SHIPPING_DOCUMENT_SIZE;
  const embedDocument = options.embedDocument === true;

  try {
    const resolved = await resolveTiktokPackageIdsToShip(client, trimmed, shopCipher);
    if (!resolved.ok) {
      return { id: trimmed, platform: 'tiktok', success: false, message: resolved.message };
    }
    const packageIds = resolved.packageIds;

    const labels: Record<string, unknown>[] = [];
    const raws: unknown[] = [];

    for (const pkgId of packageIds) {
      const path = shippingDocumentsPath(pkgId);
      const res = await client.get<unknown>(path, {
        shopCipher,
        query: {
          document_type: documentType,
          document_size: String(docSize),
        },
      });
      raws.push(res);

      const env = res as { data?: unknown; code?: number; message?: string };
      const extracted = extractTiktokLabelDetails(env.data ?? res);
      extracted.package_id = pkgId;
      extracted.document_type = documentType;
      extracted.document_size = docSize;

      if (embedDocument && typeof env.data === 'object' && env.data) {
        const raw = JSON.stringify(env.data);
        if (raw.length <= EMBED_MAX_CHARS) {
          extracted.embedded_json = raw;
        }
      }

      labels.push(extracted);
    }

    const details = {
      marketplace: 'tiktok',
      order_or_package_id: trimmed,
      document_type: documentType,
      document_size: docSize,
      labels,
    };

    return {
      id: trimmed,
      platform: 'tiktok',
      success: true,
      message:
        packageIds.length > 1
          ? `TikTok shipping documents retrieved for ${packageIds.length} packages.`
          : 'TikTok shipping document retrieved.',
      details,
      packageRefs: packageIds,
      raw: options.includeRaw ? { responses: raws } : undefined,
    };
  } catch (err) {
    return {
      id: trimmed,
      platform: 'tiktok',
      success: false,
      message: (err as Error).message,
    };
  }
}
