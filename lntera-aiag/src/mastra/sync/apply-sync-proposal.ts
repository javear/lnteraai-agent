// Applies (or dismisses) a NOTIFY propagation proposal. "apply"/"apply_always" re-run the engine with
// force=true, which RE-VALIDATES against the current internal truth and pushes — so a stale snapshot is
// never blindly applied. "apply_always" also flips the tenant to autopilot for that attribute.
import { getProposalById, markProposal } from '../integrations/products/sync-proposals-repo';
import { setSyncPrefs } from '../integrations/shared/sync-prefs';
import { propagateAttributeChange } from './propagate-attribute-change';

export interface ApplyProposalResult {
  status: 'applied' | 'dismissed' | 'already' | 'not_found' | 'expired' | 'invalid';
  message: string;
  prefUpdated?: boolean;
}

export async function applySyncProposal(args: {
  tenantId: string;
  proposalId: string;
  choice: string;
}): Promise<ApplyProposalResult> {
  const proposal = await getProposalById(args.proposalId, args.tenantId);
  if (!proposal) return { status: 'not_found', message: 'This sync request no longer exists.' };

  if (proposal.status !== 'pending') {
    const message =
      proposal.status === 'applied'
        ? 'Already synced.'
        : proposal.status === 'dismissed'
          ? 'Already dismissed.'
          : 'This sync request is no longer pending.';
    return { status: 'already', message };
  }

  if (proposal.expires_at && new Date(proposal.expires_at).getTime() < Date.now()) {
    await markProposal(proposal.id, 'expired');
    return { status: 'expired', message: 'This sync request expired — make the change again to re-apply.' };
  }

  const choice = args.choice.trim();

  if (choice === 'dismiss') {
    await markProposal(proposal.id, 'dismissed');
    return { status: 'dismissed', message: 'Dismissed — nothing was changed.' };
  }

  if (choice !== 'apply' && choice !== 'apply_always') {
    return { status: 'invalid', message: `Unknown choice "${choice}".` };
  }

  let prefUpdated = false;
  if (choice === 'apply_always') {
    await setSyncPrefs(args.tenantId, {
      propagateMode: 'autopilot',
      ...(proposal.attribute === 'stock' ? { autopilotStock: true } : { autopilotPrice: true }),
    });
    prefUpdated = true;
  }

  // Re-validate against CURRENT internal truth and push (force = skip latch + force autopilot path).
  await propagateAttributeChange({
    tenantId: args.tenantId,
    masterProductId: proposal.master_product_id,
    attribute: proposal.attribute,
    sourceConnectionId: proposal.source_connection_id,
    force: true,
  });
  await markProposal(proposal.id, 'applied');

  return {
    status: 'applied',
    message: prefUpdated ? 'Synced — and autopilot is now on for this.' : 'Synced across your stores.',
    prefUpdated,
  };
}
