// The bidirectional-sync engine. Internal is the source of truth: the CALLER has already applied the
// authoritative internal value (stock delta via the RPC, or price), then calls this to FAN OUT the
// (transformed) value to every OTHER decided store — gated by the tenant's NOTIFY vs AUTOPILOT pref.
import { logErrorBrief } from '../logger/compact-error';
import { getSupabase, listConnectionsByTenant } from '../integrations/shared/supabase';
import type { MarketplaceConnection } from '../integrations/shared/types';
import { resolveSyncPrefs, listStoreTransforms, STORE_TRANSFORM_DEFAULTS } from '../integrations/shared/sync-prefs';
import { getDecidedMappingsByInternal, type ProductMappingRow } from '../integrations/products/product-mappings-repo';
import { getProductSkusWithStock } from '../integrations/products/inventory-repo';
import { updateLinkSnapshot } from '../integrations/products/sku-links-repo';
import { createProposal, type SyncProposalTarget } from '../integrations/products/sync-proposals-repo';
import { applyPriceMargin, applyStockCap } from './store-transforms';
import { ensureSkuLinks } from './sku-link-seeder';
import { pushToStore, type PushSkuUpdate } from './marketplace-push';
import { notifyPropagationProposal, notifyPropagationApplied } from './propagation-notifier';

export type SyncAttr = 'stock' | 'price';

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

    const mappings = (await getDecidedMappingsByInternal(args.masterProductId)).filter(
      (m) => m.internal_product_id && m.marketplace_connection_id !== args.sourceConnectionId,
    );
    if (mappings.length === 0) {
      console.info(
        `[sync] propagate ${args.attribute}: product ${args.masterProductId} isn't mapped to any other store — nothing to propagate.`,
      );
      return;
    }

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
          value = applyStockCap(internal.quantity, { stockCapPct: transform.stockCapPct });
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
    if (plans.length === 0) return;

    const productTitle = await getProductTitle(args.tenantId, args.masterProductId);
    const sourceSummary = args.sourceSummary ?? (args.attribute === 'stock' ? 'Stock changed.' : 'Price changed.');

    if (mode === 'autopilot') {
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
      await notifyPropagationApplied({ tenantId: args.tenantId, attribute: args.attribute, productTitle, applied, failed });
    } else {
      const targets: SyncProposalTarget[] = plans.map((p) => ({
        connectionId: p.connection.id,
        platform: p.connection.platform as 'shopee' | 'tiktok',
        shopName: p.connection.shop_name ?? null,
        externalProductId: p.mapping.external_product_id,
        skus: p.updates.map((u) => ({ internalSkuId: u.internalSkuId, externalSkuId: u.externalSkuId, value: u.value })),
      }));
      const proposal = await createProposal({
        tenantId: args.tenantId,
        masterProductId: args.masterProductId,
        attribute: args.attribute,
        sourceConnectionId: args.sourceConnectionId,
        payload: { productTitle, sourceSummary, targets },
      });
      await notifyPropagationProposal({
        tenantId: args.tenantId,
        attribute: args.attribute,
        productTitle,
        sourceSummary,
        proposalId: proposal.id,
        masterProductId: args.masterProductId,
        targetCount: plans.length,
      });
    }
  } catch (err) {
    logErrorBrief(`[sync] propagateAttributeChange failed (product=${args.masterProductId})`, err);
  }
}
