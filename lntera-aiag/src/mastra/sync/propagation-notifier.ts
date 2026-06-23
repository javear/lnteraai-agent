// Deterministic (no-LLM) notifications for bidirectional sync — the NOTIFY proposal prompt and the
// AUTOPILOT "applied" FYI. Reuses the tenant web-delivery stack (persist + realtime + push).
import { deliverTenantWebNotification } from '../active-mode/web-delivery';

export async function notifyPropagationProposal(args: {
  tenantId: string;
  attribute: 'stock' | 'price';
  productTitle: string;
  sourceSummary: string;
  proposalId: string;
  masterProductId: string;
  targetCount: number;
}): Promise<void> {
  const attr = args.attribute === 'stock' ? 'stock' : 'price';
  const plural = args.targetCount === 1 ? 'store' : 'stores';
  const text = `${args.sourceSummary} Apply the new ${attr} for **${args.productTitle}** to your other ${args.targetCount} ${plural}?`;
  await deliverTenantWebNotification({
    tenantId: args.tenantId,
    text,
    heading: '🔄 Sync update',
    kind: 'product_sync',
    deterministic: true,
    actions: [
      { id: 'apply', label: 'Apply', kind: 'propagate', style: 'primary' },
      { id: 'apply_always', label: 'Always', kind: 'propagate' },
      { id: 'dismiss', label: 'Dismiss', kind: 'dismiss' },
    ],
    contextRef: { proposalId: args.proposalId, internalProductId: args.masterProductId, attribute: args.attribute },
  });
}

export async function notifyPropagationApplied(args: {
  tenantId: string;
  attribute: 'stock' | 'price';
  productTitle: string;
  applied: number;
  failed: number;
}): Promise<void> {
  const attr = args.attribute === 'stock' ? 'Stock' : 'Price';
  const plural = args.applied === 1 ? 'store' : 'stores';
  let text = `✅ ${attr} for **${args.productTitle}** synced across ${args.applied} ${plural}.`;
  if (args.failed > 0) {
    text += ` ${args.failed} couldn't be updated — check that those stores are still connected.`;
  }
  await deliverTenantWebNotification({
    tenantId: args.tenantId,
    text,
    heading: '🔄 Sync update',
    kind: 'product_sync',
    deterministic: true,
  });
}
