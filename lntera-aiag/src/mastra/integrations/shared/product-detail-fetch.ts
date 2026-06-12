// Fetch a NormalizedProductDetail straight from a stored MarketplaceConnection (what the webhook +
// resync paths hold), without re-resolving the connection from tenant tool context. TikTok needs a
// shop_cipher: resync passes the specific cipher it's iterating; otherwise we resolve it.
import type { MarketplaceConnection } from './types';
import type { NormalizedProductDetail } from './products';
import { resolveTiktokShopCipher } from './marketplace-auth';
import { getShopeeClient } from '../shopee/client';
import { getTiktokClient } from '../tiktok/client';
import { getShopeeProductDetail } from '../shopee/product-write';
import { getTiktokProductDetail } from '../tiktok/product-write';

export async function fetchNormalizedProductDetail(args: {
  connection: MarketplaceConnection;
  productId: string;
  /** TikTok only: the exact cipher to use (resync iterates ciphers). Resolved from the connection when absent. */
  shopCipher?: string | null;
  /** Optional hint (tool shopId / event shop) for resolving the right TikTok cipher. */
  shopIdHint?: string | null;
}): Promise<NormalizedProductDetail | null> {
  const { connection, productId } = args;

  if (connection.platform === 'shopee') {
    const client = await getShopeeClient(connection.external_shop_id);
    return getShopeeProductDetail(client, productId);
  }

  if (connection.platform === 'tiktok') {
    const cipher = args.shopCipher?.trim() || resolveTiktokShopCipher(connection, args.shopIdHint);
    if (!cipher) {
      throw new Error(`No TikTok shop_cipher resolved for connection ${connection.id}.`);
    }
    const client = await getTiktokClient(connection.external_shop_id);
    return getTiktokProductDetail(client, productId, cipher);
  }

  throw new Error(`Unsupported platform for product detail fetch: ${connection.platform}`);
}
