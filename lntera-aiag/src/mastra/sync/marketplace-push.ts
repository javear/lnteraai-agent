// Push one target store's stock OR price for a product (internal → store leg of bidirectional sync).
// Reuses the proven per-platform write primitives + the TikTok cipher loop. Per-SKU updates carry the
// store's external sku id (Shopee model_id / TikTok sku.id) and the already-transformed value.
import type { MarketplaceConnection } from '../integrations/shared/types';
import { tryTiktokShopCipherLoop } from '../integrations/shared/tiktok-shop-scope';
import { getShopeeClient } from '../integrations/shopee/client';
import { getTiktokClient } from '../integrations/tiktok/client';
import { updateShopeeStock, updateShopeePrices, type ShopeeModelUpdate } from '../integrations/shopee/product-write';
import {
  getTiktokProductDetail,
  updateTiktokInventory,
  updateTiktokPrices,
  type TiktokSkuInventoryUpdate,
  type TiktokSkuPriceUpdate,
} from '../integrations/tiktok/product-write';

export interface PushSkuUpdate {
  externalSkuId: string | null;
  value: number;
}

export interface PushResult {
  ok: boolean;
  reason?: string;
}

/** Push transformed stock/price values to a single store. Never throws — returns {ok:false,reason}. */
export async function pushToStore(args: {
  connection: MarketplaceConnection;
  attribute: 'stock' | 'price';
  externalProductId: string;
  updates: PushSkuUpdate[];
}): Promise<PushResult> {
  const { connection, attribute, externalProductId, updates } = args;
  if (updates.length === 0) return { ok: false, reason: 'no_updates' };

  try {
    if (connection.platform === 'shopee') {
      const client = await getShopeeClient(connection.external_shop_id);
      const models: ShopeeModelUpdate[] = updates.map((u) => ({
        modelId: u.externalSkuId ? Number(u.externalSkuId) : 0,
        ...(attribute === 'stock' ? { stock: u.value } : { price: u.value }),
      }));
      if (attribute === 'stock') await updateShopeeStock(client, externalProductId, models);
      else await updateShopeePrices(client, externalProductId, models);
      return { ok: true };
    }

    if (connection.platform === 'tiktok') {
      const attempt = await tryTiktokShopCipherLoop({
        conns: [connection],
        shopIdHint: connection.external_shop_id,
        getClient: (c) => getTiktokClient(c.external_shop_id),
        run: async ({ client, shopCipher }) => {
          if (attribute === 'stock') {
            const inv: TiktokSkuInventoryUpdate[] = updates
              .filter((u) => u.externalSkuId)
              .map((u) => ({ skuId: u.externalSkuId as string, quantity: u.value }));
            if (inv.length === 0) throw new Error('No TikTok sku ids to update.');
            await updateTiktokInventory(client, externalProductId, inv, shopCipher);
            return inv.length;
          }
          // Price needs the SKU's existing price fields (sale/tax-exclusive + currency) for write-back.
          const detail = await getTiktokProductDetail(client, externalProductId, shopCipher);
          if (!detail) throw new Error('TikTok product not found for this shop.');
          const byId = new Map(detail.variants.map((v) => [v.skuId, v]));
          const prices: TiktokSkuPriceUpdate[] = [];
          for (const u of updates) {
            if (!u.externalSkuId) continue;
            const v = byId.get(u.externalSkuId);
            if (!v?.currency?.trim()) continue;
            prices.push({
              skuId: u.externalSkuId,
              price: u.value,
              currency: v.currency.trim(),
              existingPrice: v.tiktokPriceFields
                ? {
                    sale_price: v.tiktokPriceFields.salePrice,
                    tax_exclusive_price: v.tiktokPriceFields.taxExclusivePrice,
                    currency: v.currency,
                  }
                : { currency: v.currency },
            });
          }
          if (prices.length === 0) throw new Error('No TikTok price updates resolved.');
          await updateTiktokPrices(client, externalProductId, prices, shopCipher);
          return prices.length;
        },
      });
      if ('error' in attempt) return { ok: false, reason: attempt.error };
      return { ok: true };
    }

    return { ok: false, reason: `unsupported_platform:${connection.platform}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
