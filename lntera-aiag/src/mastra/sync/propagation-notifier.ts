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
  /** Whether this proposal also updates the internal master (marketplace → internal). */
  internalUpdate?: boolean;
  /** Human "from X to Y" of the change, woven into the prompt. */
  changeDetail?: string;
}): Promise<void> {
  const attr = args.attribute === 'stock' ? 'stock' : 'price';
  // Build the target phrase: the internal master and/or N other stores — whichever this proposal touches.
  const parts: string[] = [];
  if (args.internalUpdate) parts.push('your internal stock');
  if (args.targetCount > 0) parts.push(`your other ${args.targetCount} ${args.targetCount === 1 ? 'store' : 'stores'}`);
  const where = parts.length > 0 ? parts.join(' and ') : 'your stores';
  // "TikTok stock for "X" changed from 6 to 5. Apply the new stock to your internal stock?"
  const lead = args.sourceSummary.replace(/\.\s*$/, '');
  const detail = args.changeDetail ? ` ${args.changeDetail}` : '';
  const text = `${lead}${detail}. Apply the new ${attr} to ${where}?`;
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
  /** Whether the internal master was updated as part of this autopilot action. */
  internalUpdated?: boolean;
  /** Human "from X to Y" of the change. */
  changeDetail?: string;
}): Promise<void> {
  const attr = args.attribute === 'stock' ? 'Stock' : 'Price';
  // Describe what was synced: the internal master and/or the N other stores.
  const parts: string[] = [];
  if (args.internalUpdated) parts.push('your internal stock');
  if (args.applied > 0) parts.push(`${args.applied} ${args.applied === 1 ? 'store' : 'stores'}`);
  const where = parts.length > 0 ? parts.join(' + ') : 'your stores';
  const detail = args.changeDetail ? `${args.changeDetail} ` : '';
  let text = `✅ ${attr} for **${args.productTitle}** synced ${detail}(${where}).`;
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
