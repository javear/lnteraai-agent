// The bidirectional-sync engine. Internal is the source of truth, but NOTHING is written silently:
// a marketplace-driven change proposes BOTH the internal-master update AND the fan-out to the other
// stores as ONE gated action (NOTIFY → ask, AUTOPILOT → apply + FYI). The caller passes the proposed
// internal stock deltas; for an internal price edit there are no deltas (internal is already the value)
// and only the fan-out is gated.
import { logErrorBrief } from '../logger/compact-error';
import { getSupabase, listConnectionsByTenant } from '../integrations/shared/supabase';
import type { MarketplaceConnection } from '../integrations/shared/types';
import { resolveSyncPrefs, listStoreTransforms, STORE_TRANSFORM_DEFAULTS } from '../integrations/shared/sync-prefs';
import { getDecidedMappingsByInternal, type ProductMappingRow } from '../integrations/products/product-mappings-repo';
import { getProductSkusWithStock, applyInventoryDelta } from '../integrations/products/inventory-repo';
import { updateLinkSnapshot } from '../integrations/products/sku-links-repo';
import {
  createProposal,
  supersedePendingStockDeltas,
  type SyncProposalTarget,
  type SyncProposalInternalDelta,
} from '../integrations/products/sync-proposals-repo';
import { applyPriceMargin, applyStockCap } from './store-transforms';
import { ensureSkuLinks } from './sku-link-seeder';
import { pushToStore, type PushSkuUpdate } from './marketplace-push';
import { notifyPropagationProposal, notifyPropagationApplied } from './propagation-notifier';

export type SyncAttr = 'stock' | 'price';

/** Proposed internal-master change (stock only). Applied as part of the gated action, never silently. */
export interface InternalStockDelta {
  internalSkuId: string;
  delta: number;
}

/** Coalesce re-entrant fan-outs (and absorb echo bounces) for the same product+attribute. */
const COALESCE_MS = 3000;
const recentlyPropagated = new Map<string, number>();

interface TargetPlan {
  mapping: ProductMappingRow;
  connection: MarketplaceConnection;
  updates: Array<{ internalSkuId: string; externalSkuId: string | null; value: number; linkId: string }>;
}

async function getProductTitle(tenantId: string, productId: string): Promise<string> {
  const { data } = await getSupabase()
    .from('tenant_products')
    .select('title')
    .eq('id', productId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return (data as { title?: string } | null)?.title ?? 'your product';
}

export async function propagateAttributeChange(args: {
  tenantId: string;
  masterProductId: string;
  attribute: SyncAttr;
  /** Store that originated the change (excluded from fan-out — it already has the value). Null = internal edit. */
  sourceConnectionId: string | null;
  sourceSummary?: string;
  /**
   * Proposed internal-master stock deltas (marketplace → internal). These are NOT pre-applied: they're
   * gated with the fan-out (applied on AUTOPILOT / on proposal-approve). Omit for internal price edits
   * (internal already holds the authoritative value; only the fan-out is gated).
   */
  internalDeltas?: InternalStockDelta[];
  /** Force an immediate push (skip the coalesce latch + NOTIFY gating). Used when applying a proposal. */
  force?: boolean;
}): Promise<void> {
  const latchKey = `${args.tenantId}:${args.masterProductId}:${args.attribute}`;
  const now = Date.now();
  if (!args.force) {
    const last = recentlyPropagated.get(latchKey);
    if (last != null && now - last < COALESCE_MS) return;
    recentlyPropagated.set(latchKey, now);
  }

  try {
    const prefs = await resolveSyncPrefs(args.tenantId);
    const autopilot = args.attribute === 'stock' ? prefs.autopilotStock : prefs.autopilotPrice;
    const mode: 'notify' | 'autopilot' =
      args.force || (autopilot && prefs.propagateMode === 'autopilot') ? 'autopilot' : 'notify';

    const internalSkus = await getProductSkusWithStock(args.tenantId, args.masterProductId);
    if (internalSkus.length === 0) return;
    const internalById = new Map(internalSkus.map((s) => [s.id, s]));

    // Proposed internal stock change (marketplace → internal). The store fan-out targets the PROJECTED
    // internal value (current + delta) so NOTIFY proposals reflect what the master WILL be once approved.
    const deltaBySku = new Map<string, number>();
    for (const d of args.internalDeltas ?? []) {
      if (d.delta !== 0) deltaBySku.set(d.internalSkuId, (deltaBySku.get(d.internalSkuId) ?? 0) + d.delta);
    }
    let hasInternalChange = [...deltaBySku.values()].some((v) => v !== 0);

    // Collapse any still-pending proposal for this product+attribute into this one (sum its deltas,
    // expire it) so ignoring a NOTIFY prompt and changing stock again doesn't leave stale, double-counting
    // notifications. Skip on force (the proposal-apply path already carries its own deltas).
    if (!args.force && hasInternalChange) {
      try {
        const carried = await supersedePendingStockDeltas(args.tenantId, args.masterProductId, args.attribute);
        for (const [sku, d] of carried) deltaBySku.set(sku, (deltaBySku.get(sku) ?? 0) + d);
        hasInternalChange = [...deltaBySku.values()].some((v) => v !== 0);
      } catch (err) {
        logErrorBrief('[sync] supersede pending proposals failed', err);
      }
    }
    const projectedQty = (skuId: string, current: number): number => current + (deltaBySku.get(skuId) ?? 0);

    const mappings = (await getDecidedMappingsByInternal(args.masterProductId)).filter(
      (m) => m.internal_product_id && m.marketplace_connection_id !== args.sourceConnectionId,
    );

    const conns = await listConnectionsByTenant(args.tenantId, ['shopee', 'tiktok']);
    const connById = new Map(conns.map((c) => [c.id, c]));
    const transforms = await listStoreTransforms(args.tenantId);

    const plans: TargetPlan[] = [];
    for (const mapping of mappings) {
      const connection = connById.get(mapping.marketplace_connection_id);
      if (!connection) continue; // store disconnected / removed
      const transform = transforms.get(connection.id) ?? STORE_TRANSFORM_DEFAULTS;

      let links;
      try {
        links = await ensureSkuLinks({
          tenantId: args.tenantId,
          mappingId: mapping.id,
          connection,
          externalProductId: mapping.external_product_id,
          internalSkus,
        });
      } catch (err) {
        logErrorBrief(`[sync] seed links failed (mapping=${mapping.id})`, err);
        continue;
      }

      const updates: TargetPlan['updates'] = [];
      for (const link of links) {
        const internal = internalById.get(link.internal_sku_id);
        if (!internal) continue;
        let value: number;
        if (args.attribute === 'stock') {
          value = applyStockCap(projectedQty(internal.id, internal.quantity), { stockCapPct: transform.stockCapPct });
        } else {
          if (internal.price == null) continue;
          const r = applyPriceMargin(
            internal.price,
            {
              feeFlat: transform.priceFeeFlat,
              feeUpPct: transform.priceFeeUpPct,
              feeOtherPct: transform.priceFeeOtherPct,
              feeCurrency: transform.feeCurrency,
            },
            internal.currency,
          );
          if ('skipped' in r) continue;
          value = r.value;
        }
        updates.push({ internalSkuId: link.internal_sku_id, externalSkuId: link.external_sku_id, value, linkId: link.id });
      }
      if (updates.length > 0) plans.push({ mapping, connection, updates });
    }

    // Nothing to do if there's neither an internal change to record nor any other store to push to.
    if (!hasInternalChange && plans.length === 0) {
      console.info(
        `[sync] propagate ${args.attribute}: product ${args.masterProductId} has no internal change and no other mapped store — nothing to do.`,
      );
      return;
    }

    const productTitle = await getProductTitle(args.tenantId, args.masterProductId);
    const sourceSummary = args.sourceSummary ?? (args.attribute === 'stock' ? 'Stock changed.' : 'Price changed.');

    if (mode === 'autopilot') {
      // 1) Apply the internal-master change (atomic, never-negative). Gated work, not silent —
      //    autopilot is the user's standing "yes".
      if (hasInternalChange) {
        for (const [skuId, delta] of deltaBySku) {
          if (delta === 0) continue;
          const internal = internalById.get(skuId);
          if (internal) await applyInventoryDelta(internal.id, internal.primaryWarehouseId, delta);
        }
      }
      // 2) Fan out to the other stores.
      let applied = 0;
      let failed = 0;
      for (const plan of plans) {
        const res = await pushToStore({
          connection: plan.connection,
          attribute: args.attribute,
          externalProductId: plan.mapping.external_product_id,
          updates: plan.updates.map<PushSkuUpdate>((u) => ({ externalSkuId: u.externalSkuId, value: u.value })),
        });
        if (res.ok) {
          applied++;
          for (const u of plan.updates) {
            await updateLinkSnapshot(
              u.linkId,
              args.attribute === 'stock'
                ? { lastPushedExternalStock: u.value, touchPushAt: true }
                : { lastPushedPrice: u.value, touchPushAt: true },
            );
          }
        } else {
          failed++;
          logErrorBrief(`[sync] push failed (store=${plan.connection.id})`, res.reason ?? 'unknown');
        }
      }
      await notifyPropagationApplied({
        tenantId: args.tenantId,
        attribute: args.attribute,
        productTitle,
        applied,
        failed,
        internalUpdated: hasInternalChange,
      });
    } else {
      const targets: SyncProposalTarget[] = plans.map((p) => ({
        connectionId: p.connection.id,
        platform: p.connection.platform as 'shopee' | 'tiktok',
        shopName: p.connection.shop_name ?? null,
        externalProductId: p.mapping.external_product_id,
        skus: p.updates.map((u) => ({ internalSkuId: u.internalSkuId, externalSkuId: u.externalSkuId, value: u.value })),
      }));
      const internalDeltas: SyncProposalInternalDelta[] = [...deltaBySku]
        .filter(([, delta]) => delta !== 0)
        .map(([internalSkuId, delta]) => ({ internalSkuId, delta }));
      const proposal = await createProposal({
        tenantId: args.tenantId,
        masterProductId: args.masterProductId,
        attribute: args.attribute,
        sourceConnectionId: args.sourceConnectionId,
        payload: { productTitle, sourceSummary, targets, internalDeltas },
      });
      await notifyPropagationProposal({
        tenantId: args.tenantId,
        attribute: args.attribute,
        productTitle,
        sourceSummary,
        proposalId: proposal.id,
        masterProductId: args.masterProductId,
        targetCount: plans.length,
        internalUpdate: hasInternalChange,
      });
    }
  } catch (err) {
    logErrorBrief(`[sync] propagateAttributeChange failed (product=${args.masterProductId})`, err);
  }
}
