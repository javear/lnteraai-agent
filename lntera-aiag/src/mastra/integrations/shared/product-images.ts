import { uploadShopeeImage } from '../shopee/product-write';
import { uploadTiktokImage } from '../tiktok/product-write';
import { getTiktokClient } from '../tiktok/client';
import type { Platform } from './types';

const DEFAULT_MIME = 'image/jpeg';

/**
 * Per-platform image size limits. Shopee allows up to 8 MB, TikTok 5 MB.
 * The guards live in the platform-specific uploaders, but we also short-circuit
 * here so the agent gets a clearer error and we never download a 200 MB file
 * just to reject it.
 */
const PLATFORM_MAX_BYTES: Record<Platform, number> = {
  shopee: 8 * 1024 * 1024,
  tiktok: 5 * 1024 * 1024,
};

function pickMimeFromContentType(contentType: string | null): string {
  if (!contentType) return DEFAULT_MIME;
  const semi = contentType.indexOf(';');
  const mime = (semi >= 0 ? contentType.slice(0, semi) : contentType).trim().toLowerCase();
  if (!mime.startsWith('image/')) return DEFAULT_MIME;
  return mime;
}

function pickFilenameFromUrl(url: string, mime: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').filter(Boolean).pop() ?? '';
    if (path && /\.[a-z0-9]{2,4}$/i.test(path)) return path;
  } catch {
    // ignore parse errors
  }
  const ext = mime.split('/')[1] ?? 'jpg';
  return `upload.${ext}`;
}

async function downloadBytes(
  url: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; mime: string; filename: string }> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Image download failed (${res.status}) for ${url}`);
  }
  const lenHeader = res.headers.get('content-length');
  if (lenHeader) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > maxBytes) {
      throw new Error(`Image too large (${len} bytes; limit ${maxBytes}) for ${url}`);
    }
  }
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Image too large (${buffer.byteLength} bytes; limit ${maxBytes}) for ${url}`);
  }
  const mime = pickMimeFromContentType(res.headers.get('content-type'));
  const filename = pickFilenameFromUrl(url, mime);
  return { buffer, mime, filename };
}

export interface UploadProductImageResult {
  /** Shopee `image_id` (for Shopee). */
  imageId?: string;
  /** TikTok image `uri` (for TikTok). */
  uri?: string;
  /** CDN URL when the platform returns one (TikTok). */
  url?: string;
  /** The platform we uploaded to. */
  platform: Platform;
}

export interface UploadProductImageArgs {
  platform: Platform;
  shopId: string;
  url: string;
  /** Required for TikTok. Shopee derives auth from shopId only. */
  shopCipher?: string;
}

/**
 * Download an image URL (typically a Discord attachment URL or any public
 * CDN link) and upload it to the right marketplace media endpoint, returning
 * the identifier the seller APIs expect.
 *
 * Discord attachments expire if the bot reuses the URL hours later, so callers
 * should upload images eagerly (when the user posts them) rather than waiting
 * until publish time.
 */
export async function uploadProductImageFromUrl(
  args: UploadProductImageArgs,
): Promise<UploadProductImageResult> {
  const limit = PLATFORM_MAX_BYTES[args.platform];
  const { buffer, mime, filename } = await downloadBytes(args.url, limit);

  if (args.platform === 'shopee') {
    const imageId = await uploadShopeeImage(args.shopId, buffer, mime, filename);
    return { platform: 'shopee', imageId };
  }
  const client = await getTiktokClient(args.shopId);
  const { uri, url } = await uploadTiktokImage(client, buffer, mime, filename);
  return { platform: 'tiktok', uri, url };
}
