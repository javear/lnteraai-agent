// Cross-store SKU matching: product_mappings are product-level, but stock/price are per-SKU, so to
// propagate we must line up an internal SKU with the corresponding marketplace SKU. Used to SEED
// product_sku_links the first time we reconcile a product; thereafter the link row is authoritative.
//
// Priority: seller_sku (the only seller-controlled, cross-store-stable id) → single-SKU products →
// normalized attribute tuple (color=red|size=l) → position (last resort, equal counts only).

export interface MatchableSku {
  sellerSku?: string | null;
  externalSkuId?: string | null;
  attributes?: Array<{ name?: string | null; value?: string | null }> | null;
  position?: number | null;
}

export type MatchBy = 'seller_sku' | 'single' | 'attributes' | 'position';
export interface SkuMatch {
  internalIndex: number;
  externalIndex: number;
  by: MatchBy;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function attrKey(attrs: MatchableSku['attributes']): string {
  return (attrs ?? [])
    .map((a) => `${norm(a?.name)}=${norm(a?.value)}`)
    .filter((p) => p !== '=')
    .sort()
    .join('|');
}

export function matchSkus(internal: MatchableSku[], external: MatchableSku[]): SkuMatch[] {
  const matches: SkuMatch[] = [];
  const usedExt = new Set<number>();
  const claimedInt = new Set<number>();

  // 1. seller_sku
  const extBySeller = new Map<string, number>();
  external.forEach((e, i) => {
    const k = norm(e.sellerSku);
    if (k && !extBySeller.has(k)) extBySeller.set(k, i);
  });
  internal.forEach((s, i) => {
    const k = norm(s.sellerSku);
    const ei = k ? extBySeller.get(k) : undefined;
    if (ei != null && !usedExt.has(ei)) {
      matches.push({ internalIndex: i, externalIndex: ei, by: 'seller_sku' });
      usedExt.add(ei);
      claimedInt.add(i);
    }
  });

  // 2. single-SKU products
  if (internal.length === 1 && external.length === 1 && !claimedInt.has(0) && !usedExt.has(0)) {
    matches.push({ internalIndex: 0, externalIndex: 0, by: 'single' });
    usedExt.add(0);
    claimedInt.add(0);
  }

  // 3. attribute tuple
  const extByAttr = new Map<string, number>();
  external.forEach((e, i) => {
    if (usedExt.has(i)) return;
    const k = attrKey(e.attributes);
    if (k && !extByAttr.has(k)) extByAttr.set(k, i);
  });
  internal.forEach((s, i) => {
    if (claimedInt.has(i)) return;
    const k = attrKey(s.attributes);
    const ei = k ? extByAttr.get(k) : undefined;
    if (ei != null && !usedExt.has(ei)) {
      matches.push({ internalIndex: i, externalIndex: ei, by: 'attributes' });
      usedExt.add(ei);
      claimedInt.add(i);
    }
  });

  // 4. position — only when counts are equal (low confidence)
  if (internal.length === external.length) {
    for (let i = 0; i < internal.length; i++) {
      if (claimedInt.has(i) || usedExt.has(i)) continue;
      matches.push({ internalIndex: i, externalIndex: i, by: 'position' });
      usedExt.add(i);
      claimedInt.add(i);
    }
  }

  return matches;
}
