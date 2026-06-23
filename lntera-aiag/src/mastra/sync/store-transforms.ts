// Pure, one-directional INTERNAL → STORE transforms. Applied only when pushing the master product's
// value out to a marketplace store; marketplace → internal never uses these. The price math is mirrored
// (in TS) by the frontend preview in web/src/lib/sync-config.ts — keep the two in sync.

/** Currencies with no minor unit (whole-number prices). Mirrors the marketplace price formatters. */
const ZERO_DECIMAL_CURRENCIES = new Set(['IDR', 'VND', 'JPY', 'KRW', 'CLP', 'TWD', 'HUF']);

export interface PriceMarginConfig {
  /** Flat fee added after the percentages, in `feeCurrency`. */
  feeFlat: number;
  /** "Up" margin, percent (e.g. 1 = +1%). */
  feeUpPct: number;
  /** Other fee, percent (e.g. 0.5 = +0.5%). */
  feeOtherPct: number;
  /** Currency the flat fee is denominated in; the flat fee is only applied when it matches the SKU currency. */
  feeCurrency?: string | null;
  /** Optional hard floor for the pushed price. */
  priceFloor?: number | null;
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
 * Margin formula (locked decision): `pushed = base × (1 + up%/100 + other%/100) + flat`.
 * The flat fee is skipped when its currency differs from the SKU currency (no FX). Returns the rounded
 * push price, or a `skipped` reason when the result is non-finite/≤0 so the caller can flag + skip.
 */
export function applyPriceMargin(
  basePrice: number,
  cfg: PriceMarginConfig | null | undefined,
  skuCurrency?: string | null,
): { value: number } | { skipped: string } {
  if (!Number.isFinite(basePrice) || basePrice <= 0) return { skipped: 'invalid_base_price' };
  if (!cfg) return { value: roundForCurrency(basePrice, skuCurrency) };

  const pct = 1 + (cfg.feeUpPct || 0) / 100 + (cfg.feeOtherPct || 0) / 100;
  let value = basePrice * pct;

  // Flat fee only when its currency matches the SKU's (avoid silently adding e.g. USD to an IDR price).
  const feeCur = (cfg.feeCurrency ?? skuCurrency ?? '').toUpperCase();
  const skuCur = (skuCurrency ?? '').toUpperCase();
  if (cfg.feeFlat) {
    if (!skuCur || !feeCur || feeCur === skuCur) value += cfg.feeFlat;
    // else: currency mismatch → percentages only (caller may flag).
  }

  if (cfg.priceFloor != null) value = Math.max(value, cfg.priceFloor);
  value = roundForCurrency(value, skuCurrency);
  if (!Number.isFinite(value) || value <= 0) return { skipped: 'nonpositive_price' };
  return { value };
}

/** True when the flat fee is set but its currency differs from the SKU currency (fee was skipped). */
export function flatFeeCurrencyMismatch(cfg: PriceMarginConfig | null | undefined, skuCurrency?: string | null): boolean {
  if (!cfg?.feeFlat) return false;
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
