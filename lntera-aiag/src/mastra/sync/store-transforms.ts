// Pure, one-directional INTERNAL → STORE transforms. Applied only when pushing the master product's
// value out to a marketplace store; marketplace → internal never uses these. The price math is mirrored
// (in TS) by the frontend preview in web/src/lib/sync-config.ts — keep the two in sync.

/** Currencies with no minor unit (whole-number prices). Mirrors the marketplace price formatters. */
const ZERO_DECIMAL_CURRENCIES = new Set(['IDR', 'VND', 'JPY', 'KRW', 'CLP', 'TWD', 'HUF']);

/**
 * One dynamic price adjustment the seller adds for a store. `percent` is applied to the base price;
 * `fixed` is an absolute amount in `feeCurrency`. Values may be negative (a discount). The seller can
 * stack any number of these.
 */
export interface PriceAdjustment {
  kind: 'percent' | 'fixed';
  value: number;
  label?: string;
}

export interface PriceMarginConfig {
  /** Ordered list of adjustments. Percents are summed onto the base; fixed amounts are added after. */
  adjustments: PriceAdjustment[];
  /** Currency the FIXED adjustments are denominated in; they're applied only when it matches the SKU currency. */
  feeCurrency?: string | null;
  /** Optional hard floor for the pushed price. */
  priceFloor?: number | null;
}

/** Sum a list of adjustments into a total percent and a total fixed amount. */
export function sumAdjustments(adjustments: PriceAdjustment[] | null | undefined): {
  percentTotal: number;
  fixedTotal: number;
} {
  let percentTotal = 0;
  let fixedTotal = 0;
  for (const a of adjustments ?? []) {
    if (!a || !Number.isFinite(a.value)) continue;
    if (a.kind === 'percent') percentTotal += a.value;
    else if (a.kind === 'fixed') fixedTotal += a.value;
  }
  return { percentTotal, fixedTotal };
}

export interface StockCapConfig {
  /** Push this percentage of the internal quantity to the store (1–100). Default 100. */
  stockCapPct: number;
}

export function roundForCurrency(value: number, currency?: string | null): number {
  const cur = (currency ?? '').toUpperCase();
  return ZERO_DECIMAL_CURRENCIES.has(cur) ? Math.round(value) : Math.round(value * 100) / 100;
}

/**
 * Margin formula: `pushed = base × (1 + Σpercent/100) + Σfixed`.
 * Fixed adjustments are skipped when their currency differs from the SKU currency (no FX). Returns the
 * rounded push price, or a `skipped` reason when the result is non-finite/≤0 so the caller can flag + skip.
 */
export function applyPriceMargin(
  basePrice: number,
  cfg: PriceMarginConfig | null | undefined,
  skuCurrency?: string | null,
): { value: number } | { skipped: string } {
  if (!Number.isFinite(basePrice) || basePrice <= 0) return { skipped: 'invalid_base_price' };
  if (!cfg || !cfg.adjustments?.length) return { value: roundForCurrency(basePrice, skuCurrency) };

  const { percentTotal, fixedTotal } = sumAdjustments(cfg.adjustments);
  let value = basePrice * (1 + percentTotal / 100);

  // Fixed adjustments only when their currency matches the SKU's (avoid silently adding e.g. USD to IDR).
  const feeCur = (cfg.feeCurrency ?? skuCurrency ?? '').toUpperCase();
  const skuCur = (skuCurrency ?? '').toUpperCase();
  if (fixedTotal) {
    if (!skuCur || !feeCur || feeCur === skuCur) value += fixedTotal;
    // else: currency mismatch → percentages only (caller may flag).
  }

  if (cfg.priceFloor != null) value = Math.max(value, cfg.priceFloor);
  value = roundForCurrency(value, skuCurrency);
  if (!Number.isFinite(value) || value <= 0) return { skipped: 'nonpositive_price' };
  return { value };
}

/** True when fixed adjustments exist but their currency differs from the SKU currency (they were skipped). */
export function fixedAdjustmentCurrencyMismatch(
  cfg: PriceMarginConfig | null | undefined,
  skuCurrency?: string | null,
): boolean {
  if (!cfg || sumAdjustments(cfg.adjustments).fixedTotal === 0) return false;
  const feeCur = (cfg.feeCurrency ?? skuCurrency ?? '').toUpperCase();
  const skuCur = (skuCurrency ?? '').toUpperCase();
  return Boolean(skuCur && feeCur && feeCur !== skuCur);
}

/**
 * Stock cap: push `floor(internalQty × cap%/100)`. Guardrails:
 *  - internalQty ≤ 0 → push 0 (true out-of-stock everywhere).
 *  - internalQty > 0 but the cap rounds to 0 (e.g. 80% of 1) → push 1, so we never zero a store that
 *    genuinely has stock.
 */
export function applyStockCap(internalQty: number, cfg: StockCapConfig | null | undefined): number {
  if (!Number.isFinite(internalQty) || internalQty <= 0) return 0;
  const pct = cfg?.stockCapPct ?? 100;
  const capped = Math.floor((internalQty * pct) / 100);
  return capped < 1 ? 1 : capped;
}
