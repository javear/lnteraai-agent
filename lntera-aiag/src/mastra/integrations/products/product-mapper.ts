// Maps a cross-platform NormalizedProductDetail into the internal tenant_products write shape
// (product + SKUs + per-warehouse inventory) and composes the embedding text. Does NOT embed
// (the repo embeds). Marketplace is the source of truth for synced products, so the repo
// full-replaces SKUs/inventory on update.
import type { NormalizedProductDetail } from '../shared/products';
import { buildEmbeddingText } from '../embeddings/product-embedding-text';

export interface TenantProductSkuWrite {
  sellerSku: string | null;
  label: string | null;
  attributes: unknown;
  price: number | null;
  currency: string | null;
  imageUrl: string | null;
  externalSkuId: string | null;
  position: number;
  inventory: Array<{ externalWarehouseId: string | null; quantity: number }>;
}

export interface TenantProductWrite {
  tenantId: string;
  sourceOrigin: 'internal' | 'marketplace';
  sourcePlatform: string | null;
  sourceConnectionId: string | null;
  title: string;
  brand: string | null;
  uom: string | null;
  status: string;
  currency: string | null;
  description: string | null;
  categoryId: string | null;
  brandId: string | null;
  imageUrls: string[] | null;
  attributes: unknown;
  dimensions: unknown;
  weightGrams: number | null;
  raw: unknown;
  embeddingSourceText: string;
  skus: TenantProductSkuWrite[];
}

function mapStatus(s: NormalizedProductDetail['status']): string {
  if (s === 'active') return 'active';
  if (s === 'inactive') return 'inactive';
  return 'unknown';
}

export function normalizedToTenantProduct(
  detail: NormalizedProductDetail,
  ctx: { tenantId: string; connectionId?: string | null; uom?: string | null; brand?: string | null },
): TenantProductWrite {
  const currency = detail.variants.find((v) => v.currency)?.currency ?? null;

  const skus: TenantProductSkuWrite[] = detail.variants.map((v, i) => ({
    sellerSku: v.sellerSku ?? null,
    label: v.label ?? null,
    attributes: v.attributes ?? [],
    price: v.price ?? null,
    currency: v.currency ?? null,
    imageUrl: v.imageUrl ?? null,
    externalSkuId: v.skuId ?? null,
    position: i,
    inventory:
      v.inventoryByWarehouse && v.inventoryByWarehouse.length > 0
        ? v.inventoryByWarehouse.map((w) => ({
            externalWarehouseId: w.warehouseId ?? null,
            quantity: Number(w.quantity) || 0,
          }))
        : [{ externalWarehouseId: null, quantity: Number(v.stock ?? 0) || 0 }],
  }));

  return {
    tenantId: ctx.tenantId,
    sourceOrigin: 'marketplace',
    sourcePlatform: detail.platform,
    sourceConnectionId: ctx.connectionId ?? null,
    title: detail.title,
    brand: ctx.brand ?? null,
    uom: ctx.uom ?? null,
    status: mapStatus(detail.status),
    currency,
    description: detail.description ?? null,
    categoryId: detail.categoryId ?? null,
    brandId: detail.brandId ?? null,
    imageUrls: detail.imageUrls ?? null,
    attributes: detail.attributes ?? [],
    dimensions: detail.dimensionsCm ?? null,
    weightGrams: detail.weightGrams ?? null,
    raw: detail.raw ?? null,
    embeddingSourceText: buildEmbeddingText(detail, { uom: ctx.uom, brand: ctx.brand }),
    skus,
  };
}
