import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../../integrations/shared/marketplace-auth';
import { resolveSyncPrefs, setSyncPrefs, type SyncPrefsPatch } from '../../integrations/shared/sync-prefs';

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'on', 'enable', 'enabled', 'yes', 'auto', 'autopilot'].includes(s)) return true;
    if (['false', 'off', 'disable', 'disabled', 'no', 'notify', 'manual', 'ask'].includes(s)) return false;
  }
  return undefined;
}

/**
 * Chat-driven toggle for product-sync autopilot (auto-push stock/price changes across all mapped
 * stores) vs notify-first. Per-store fees/stock-cap are UI-only (chat can't safely pick store + money).
 */
export const configureSyncAutopilotTool = createTool({
  id: 'configure-sync-autopilot',
  strict: false,
  description:
    'Turn product-sync autopilot on/off for stock and/or price, or set it back to notify-first. ' +
    'Autopilot auto-applies a change on one store across all the seller\'s other mapped stores. ' +
    'Use for: "enable stock autopilot", "auto-sync my prices", "just notify me before syncing", "turn off auto sync".',
  requestContextSchema: z.object({ [TENANT_MASTER_ID_KEY]: z.string().uuid() }),
  inputSchema: z.record(z.string(), z.unknown()),
  inputExamples: [{ input: { stock: true } }, { input: { enabled: true, attribute: 'price' } }, { input: { mode: 'notify' } }],
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

    const attribute = typeof raw.attribute === 'string' ? raw.attribute.trim().toLowerCase() : undefined;
    const enabled = asBool(raw.enabled);
    const mode = asBool(raw.mode); // 'autopilot' → true, 'notify' → false
    const stock = asBool(raw.stock) ?? (attribute === 'stock' ? enabled : undefined);
    const price = asBool(raw.price) ?? (attribute === 'price' ? enabled : undefined);
    // Bare "enable/disable" with no attribute → apply to both.
    const applyBoth = enabled !== undefined && attribute === undefined && raw.stock === undefined && raw.price === undefined;

    const patch: SyncPrefsPatch = {};
    if (applyBoth) {
      patch.autopilotStock = enabled;
      patch.autopilotPrice = enabled;
    } else {
      if (stock !== undefined) patch.autopilotStock = stock;
      if (price !== undefined) patch.autopilotPrice = price;
    }
    const turnedOn = patch.autopilotStock === true || patch.autopilotPrice === true;
    if (mode !== undefined) patch.propagateMode = mode ? 'autopilot' : 'notify';
    else if (turnedOn) patch.propagateMode = 'autopilot'; // enabling autopilot implies autopilot mode

    if (Object.keys(patch).length > 0) await setSyncPrefs(tenantId, patch);

    const prefs = await resolveSyncPrefs(tenantId);
    const on = [prefs.autopilotStock ? 'stock' : null, prefs.autopilotPrice ? 'price' : null].filter(Boolean) as string[];
    const summary =
      on.length && prefs.propagateMode === 'autopilot'
        ? `Autopilot is ON for ${on.join(' & ')} — changes auto-push across your mapped stores.`
        : "Autopilot is OFF — I'll ask before syncing a change to your other stores (notify mode).";
    return {
      autopilotStock: prefs.autopilotStock,
      autopilotPrice: prefs.autopilotPrice,
      propagateMode: prefs.propagateMode,
      summary,
    };
  },
});
