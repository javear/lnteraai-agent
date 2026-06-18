// Cross-platform DEMAND signal from order line-items (works for Shopee + TikTok, unlike the
// product `soldCount` field which TikTok never exposes). Aggregates ordered quantity per SKU/name
// over the prefetched window and joins to current stock by SKU (the reliable key). Unmatched stock
// stays null (unknown) rather than guessed. Cancelled orders are excluded from demand.
import type { PrefetchedData } from './types';

export interface DemandStockRow {
  name: string;
  sku?: string;
  demand: number;
  /** Current available stock for the matched SKU; null when stock is unknown (no SKU match). */
  stock: number | null;
}

export interface DemandStock {
  rows: DemandStockRow[]; // sorted by demand desc
  hasDemand: boolean;
}

export function buildDemandStock(data: PrefetchedData): DemandStock {
  // Demand by key (prefer seller SKU; fall back to item name).
  const demandByKey = new Map<string, { name: string; sku?: string; demand: number }>();
  for (const order of data.orders) {
    if (order.status === 'cancelled') continue;
    for (const item of order.items ?? []) {
      const sku = item.sku?.trim() || undefined;
      const name = (item.name?.trim() || sku || '').slice(0, 80);
      if (!sku && !name) continue;
      const key = (sku || name).toLowerCase();
      const cur = demandByKey.get(key) ?? { name: name || sku || key, sku, demand: 0 };
      cur.demand += Number(item.quantity) || 0;
      if (!cur.sku && sku) cur.sku = sku;
      if (!cur.name && name) cur.name = name;
      demandByKey.set(key, cur);
    }
  }

  // Stock by seller SKU (reliable join). Prefer the SKU-level quantity; else the product summary.
  const stockBySku = new Map<string, number>();
  for (const product of data.products) {
    const summary = typeof product.totalAvailableStock === 'number' ? product.totalAvailableStock : null;
    for (const sku of product.skus ?? []) {
      const key = sku.sellerSku?.trim().toLowerCase();
      if (!key) continue;
      const qty = typeof sku.quantity === 'number' ? sku.quantity : summary;
      if (qty != null) stockBySku.set(key, qty);
    }
  }

  const rows: DemandStockRow[] = [];
  for (const d of demandByKey.values()) {
    const stock = d.sku ? (stockBySku.get(d.sku.toLowerCase()) ?? null) : null;
    rows.push({ name: d.name, sku: d.sku, demand: d.demand, stock });
  }
  rows.sort((a, b) => b.demand - a.demand);
  return { rows, hasDemand: demandByKey.size > 0 };
}
