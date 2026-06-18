// Contracts for the dynamic business-insights engine. Providers are pure-ish functions over a
// PREFETCHED data bundle (orders + products fetched ONCE per run) so adding an insight never adds
// API calls. Charts are produced DETERMINISTICALLY here (exact numbers); the LLM only narrates.
import type { NormalizedOrder } from '../integrations/shared/orders';
import type { NormalizedProduct } from '../integrations/shared/products';

/** A chart the web renders (Recharts). Kept minimal + serializable so it rides the notification payload. */
export interface ChartSpec {
  type: 'bar' | 'line' | 'donut';
  title: string;
  /** Optional value unit for tooltips/labels, e.g. 'orders', '%', 'units', 'MYR'. */
  unit?: string;
  /** X-axis / category labels (one per data point). */
  labels: string[];
  /** One or more series; donut uses a single series whose data aligns to `labels`. */
  series: Array<{ name?: string; data: number[] }>;
}

export type InsightStatus = 'ok' | 'partial' | 'no_data' | 'error';

export interface InsightResult {
  key: string;
  label: string;
  /** One or two sentences of deterministic fact (the LLM expands these into the narrative). */
  summary: string;
  metrics: Record<string, number | string>;
  chart?: ChartSpec;
  dataCaveats?: string[];
  status: InsightStatus;
}

/** Orders carry `items` only when prefetched with order-item enrichment (see PrefetchedData). */
export type OrderWithItems = NormalizedOrder & {
  items?: Array<{ sku?: string; name?: string; quantity?: number; price?: number }>;
};

export interface PrefetchedData {
  orders: OrderWithItems[];
  products: NormalizedProduct[];
  /** Unix seconds window the orders were fetched over. */
  windowFrom: number;
  windowTo: number;
  /** True when a page/budget cap stopped pagination (insights should flag reduced confidence). */
  truncated: boolean;
  /** True when orders were fetched with line-item enrichment (demand insights need this). */
  hasOrderItems: boolean;
  /** True when products were fetched (stock insights need this). */
  hasProducts: boolean;
  errors: string[];
}

export interface InsightContext {
  tenantId: string;
  now: Date;
  data: PrefetchedData;
}

export interface InsightProvider {
  key: string;
  label: string;
  defaultEnabled: boolean;
  /** Declares the extra data this provider needs so the engine prefetches the minimum. */
  needs?: { products?: boolean; orderItems?: boolean };
  compute(ctx: InsightContext): InsightResult | Promise<InsightResult>;
}
