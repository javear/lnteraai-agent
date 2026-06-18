// The dynamic insight registry. Each provider is a deterministic function over the prefetched data
// (orders + optional products) producing a summary + metrics + a ChartSpec. Adding a new insight =
// add one provider object here. All numbers are exact; the LLM only narrates them downstream.
import type { InsightProvider, InsightResult, PrefetchedData } from './types';
import { buildDemandStock } from './demand';

const UNSHIPPED = new Set(['pending', 'processing', 'processed']);
const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  processing: 'To process',
  processed: 'Ready to ship',
};

function windowDays(data: PrefetchedData): number {
  return Math.max(1, Math.round((data.windowTo - data.windowFrom) / 86400));
}
function short(s: string, n = 22): string {
  const t = (s || '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t || '(unnamed)';
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// 1 ─ Orders awaiting action (unprocessed) ───────────────────────────────────────────────────────
const ordersUnprocessed: InsightProvider = {
  key: 'orders-unprocessed',
  label: 'Orders awaiting action',
  defaultEnabled: true,
  compute({ data }): InsightResult {
    const byStatus = new Map<string, number>();
    for (const o of data.orders) if (UNSHIPPED.has(o.status)) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
    const total = [...byStatus.values()].reduce((a, b) => a + b, 0);
    const caveats = data.truncated ? ['Order window was capped — counts cover recent orders.'] : undefined;
    if (total === 0) {
      return {
        key: this.key, label: this.label, status: 'ok',
        summary: 'No orders are waiting on you right now — fulfillment is clear.',
        metrics: { unprocessed: 0 },
      };
    }
    const labels = ['pending', 'processing', 'processed'].filter((s) => byStatus.has(s));
    return {
      key: this.key, label: this.label, status: data.truncated ? 'partial' : 'ok',
      summary: `${total} order${total === 1 ? '' : 's'} still need action before shipping.`,
      metrics: { unprocessed: total, ...Object.fromEntries(byStatus) },
      chart: {
        type: 'donut', title: 'Unprocessed orders by stage', unit: 'orders',
        labels: labels.map((s) => STATUS_LABEL[s] ?? s),
        series: [{ data: labels.map((s) => byStatus.get(s) ?? 0) }],
      },
      dataCaveats: caveats,
    };
  },
};

// 2 ─ Cancellation rate ────────────────────────────────────────────────────────────────────────
const cancellationRate: InsightProvider = {
  key: 'cancellation-rate',
  label: 'Cancellation rate',
  defaultEnabled: true,
  compute({ data }): InsightResult {
    const total = data.orders.length;
    if (total === 0) {
      return { key: this.key, label: this.label, status: 'no_data', summary: 'No orders in the window to measure cancellations.', metrics: {} };
    }
    const cancelled = data.orders.filter((o) => o.status === 'cancelled').length;
    const completed = data.orders.filter((o) => o.status === 'completed' || o.status === 'delivered').length;
    const other = Math.max(0, total - cancelled - completed);
    const rate = (cancelled / total) * 100;
    return {
      key: this.key, label: this.label, status: data.truncated ? 'partial' : 'ok',
      summary: `Cancellation rate is ${round1(rate)}% — ${cancelled} of ${total} orders over ~${windowDays(data)} days.`,
      metrics: { cancellationRatePct: round1(rate), cancelled, total },
      chart: {
        type: 'bar', title: 'Orders by outcome', unit: 'orders',
        labels: ['Cancelled', 'Completed', 'In progress'], series: [{ data: [cancelled, completed, other] }],
      },
      dataCaveats: data.truncated ? ['Rate is over the fetched sample (window capped).'] : undefined,
    };
  },
};

// 3 ─ Orders to ship — aging ──────────────────────────────────────────────────────────────────
const ordersToShipAging: InsightProvider = {
  key: 'orders-to-ship-aging',
  label: 'Orders to ship — aging',
  defaultEnabled: true,
  compute({ data, now }): InsightResult {
    const buckets: Record<string, number> = { '≤24h': 0, '24–48h': 0, '48–72h': 0, '>72h': 0 };
    let oldestHours = 0;
    for (const o of data.orders) {
      if (!UNSHIPPED.has(o.status)) continue;
      const created = o.createdAt ? Date.parse(o.createdAt) : NaN;
      if (Number.isNaN(created)) continue;
      const h = (now.getTime() - created) / 3_600_000;
      oldestHours = Math.max(oldestHours, h);
      if (h <= 24) buckets['≤24h']++;
      else if (h <= 48) buckets['24–48h']++;
      else if (h <= 72) buckets['48–72h']++;
      else buckets['>72h']++;
    }
    const total = Object.values(buckets).reduce((a, b) => a + b, 0);
    const overdue = buckets['48–72h'] + buckets['>72h'];
    if (total === 0) {
      return { key: this.key, label: this.label, status: 'ok', summary: 'Nothing is sitting unshipped — great turnaround.', metrics: { awaitingShipment: 0 } };
    }
    return {
      key: this.key, label: this.label, status: 'ok',
      summary: `${total} orders await shipment${overdue ? `; ${overdue} are over 48h old — prioritize these` : ''}.`,
      metrics: { awaitingShipment: total, over48h: overdue, oldestHours: Math.round(oldestHours) },
      chart: { type: 'bar', title: 'Unshipped orders by age', unit: 'orders', labels: Object.keys(buckets), series: [{ data: Object.values(buckets) }] },
    };
  },
};

// 4 ─ Selling out — restock now (high demand, zero stock) ────────────────────────────────────────
const highDemandNotRestocked: InsightProvider = {
  key: 'high-demand-not-restocked',
  label: 'Selling out — restock now',
  defaultEnabled: true,
  needs: { orderItems: true, products: true },
  compute({ data }): InsightResult {
    const { rows, hasDemand } = buildDemandStock(data);
    if (hasDemand) {
      const flagged = rows.filter((r) => r.demand > 0 && r.stock === 0).slice(0, 8);
      if (flagged.length === 0) {
        return { key: this.key, label: this.label, status: data.truncated ? 'partial' : 'ok', summary: 'No selling products are out of stock — inventory is keeping up.', metrics: { outOfStockSellers: 0 } };
      }
      const caveats: string[] = [];
      if (data.truncated) caveats.push('Based on recent orders (window capped).');
      return {
        key: this.key, label: this.label, status: data.truncated ? 'partial' : 'ok',
        summary: `${flagged.length} product${flagged.length === 1 ? ' that sold' : 's that sold'} recently ${flagged.length === 1 ? 'is' : 'are'} now out of stock — you're leaving sales on the table.`,
        metrics: { outOfStockSellers: flagged.length, topSeller: flagged[0].name, topDemand: flagged[0].demand },
        chart: { type: 'bar', title: 'Out-of-stock sellers (units sold recently)', unit: 'units sold', labels: flagged.map((f) => short(f.name)), series: [{ data: flagged.map((f) => f.demand) }] },
        dataCaveats: caveats.length ? caveats : undefined,
      };
    }
    // Fallback: no order-item demand available → use catalog sales counts (Shopee) where present.
    const fallback = data.products
      .filter((p) => (p.totalAvailableStock ?? 0) === 0 && (p.soldCount ?? 0) > 0)
      .sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0))
      .slice(0, 8);
    if (fallback.length === 0) {
      return { key: this.key, label: this.label, status: 'no_data', summary: 'Not enough recent order data yet to gauge which products are selling out.', metrics: {} };
    }
    return {
      key: this.key, label: this.label, status: 'partial',
      summary: `${fallback.length} previously-selling products are out of stock (estimated from catalog sales).`,
      metrics: { outOfStockSellers: fallback.length },
      chart: { type: 'bar', title: 'Out-of-stock products (lifetime sales)', unit: 'sold', labels: fallback.map((p) => short(p.title)), series: [{ data: fallback.map((p) => p.soldCount ?? 0) }] },
      dataCaveats: ['Estimated from catalog sales counts; demand from live orders gives a sharper signal.'],
    };
  },
};

// 5 ─ Bestsellers running low (demand > 0, low but non-zero stock) ────────────────────────────────
const LOW_STOCK_THRESHOLD = 10;
const lowStockBestsellers: InsightProvider = {
  key: 'low-stock-bestsellers',
  label: 'Bestsellers running low',
  defaultEnabled: true,
  needs: { orderItems: true, products: true },
  compute({ data }): InsightResult {
    const { rows, hasDemand } = buildDemandStock(data);
    if (!hasDemand) {
      return { key: this.key, label: this.label, status: 'no_data', summary: 'Not enough recent order data yet to rank bestsellers.', metrics: {} };
    }
    const flagged = rows
      .filter((r) => r.demand > 0 && r.stock != null && r.stock > 0 && r.stock <= LOW_STOCK_THRESHOLD)
      .slice(0, 8);
    if (flagged.length === 0) {
      return { key: this.key, label: this.label, status: data.truncated ? 'partial' : 'ok', summary: `No bestsellers are below ${LOW_STOCK_THRESHOLD} units — stock cover looks comfortable.`, metrics: { lowStockBestsellers: 0 } };
    }
    return {
      key: this.key, label: this.label, status: data.truncated ? 'partial' : 'ok',
      summary: `${flagged.length} recent bestseller${flagged.length === 1 ? ' is' : 's are'} below ${LOW_STOCK_THRESHOLD} units — restock soon to avoid stockouts.`,
      metrics: { lowStockBestsellers: flagged.length, lowestStock: Math.min(...flagged.map((f) => f.stock ?? 0)) },
      chart: { type: 'bar', title: 'Bestsellers low on stock', unit: 'units in stock', labels: flagged.map((f) => short(f.name)), series: [{ name: 'Stock left', data: flagged.map((f) => f.stock ?? 0) }] },
      dataCaveats: data.truncated ? ['Based on recent orders (window capped).'] : undefined,
    };
  },
};

export const INSIGHT_PROVIDERS: InsightProvider[] = [
  ordersUnprocessed,
  cancellationRate,
  ordersToShipAging,
  highDemandNotRestocked,
  lowStockBestsellers,
];

export interface ProviderDescriptor {
  key: string;
  label: string;
  defaultEnabled: boolean;
}

export function listProviders(): ProviderDescriptor[] {
  return INSIGHT_PROVIDERS.map((p) => ({ key: p.key, label: p.label, defaultEnabled: p.defaultEnabled }));
}

/** null = all default-on providers; otherwise the subset whose keys are subscribed. */
export function resolveSubscribedProviders(keys: string[] | null): InsightProvider[] {
  if (!keys) return INSIGHT_PROVIDERS.filter((p) => p.defaultEnabled);
  const set = new Set(keys);
  return INSIGHT_PROVIDERS.filter((p) => set.has(p.key));
}
