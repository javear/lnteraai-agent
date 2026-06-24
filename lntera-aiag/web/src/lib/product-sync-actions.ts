// Token-free client for product-sync decisions. Hits the REST endpoints directly (never the agent
// stream) using the auth-attaching `api()` from useAuth.
type Api = (path: string, init?: RequestInit) => Promise<Response>;

export interface SyncActionResult {
  ok: boolean;
  status: string;
  message: string;
  mappingStatus?: string;
  prefUpdated?: string;
}

export async function postSyncAction(api: Api, linkId: string, choice: string): Promise<SyncActionResult> {
  const res = await api(`/svc/v1/products/sync-actions/${encodeURIComponent(linkId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ choice }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<SyncActionResult>;
  if (!res.ok) {
    return { ok: false, status: data.status ?? 'error', message: data.message ?? `Failed (${res.status}).` };
  }
  return {
    ok: data.ok ?? true,
    status: data.status ?? 'applied',
    message: data.message ?? 'Done.',
    mappingStatus: data.mappingStatus,
    prefUpdated: data.prefUpdated,
  };
}

/** Apply ('apply' / 'apply_always') or 'dismiss' a bidirectional-sync propagation proposal. */
export async function postPropagate(
  api: Api,
  proposalId: string,
  choice: string,
): Promise<{ ok: boolean; message: string }> {
  const res = await api(`/svc/v1/products/sync-proposals/${encodeURIComponent(proposalId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ choice }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
  return {
    ok: res.ok && (data.ok ?? true),
    message: data.message ?? (res.ok ? 'Done.' : `Failed (${res.status}).`),
  };
}

export type ProposalState = 'pending' | 'applied' | 'dismissed' | 'superseded' | 'expired' | 'not_found' | 'unknown';

/** Current display state of a propagation proposal (so decided/superseded prompts render resolved). */
export async function getProposalState(api: Api, proposalId: string): Promise<ProposalState> {
  try {
    const res = await api(`/svc/v1/products/sync-proposals/${encodeURIComponent(proposalId)}`);
    if (!res.ok) return 'unknown';
    const data = (await res.json().catch(() => ({}))) as { state?: ProposalState };
    return data.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Whether a recognition prompt is still actionable + its mapping status. */
export async function getLinkState(api: Api, linkId: string): Promise<{ actionable: boolean; status: string } | null> {
  try {
    const res = await api(`/svc/v1/products/sync-actions/${encodeURIComponent(linkId)}`);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { actionable?: boolean; status?: string };
    return { actionable: data.actionable ?? true, status: data.status ?? '' };
  } catch {
    return null;
  }
}

export async function postResync(
  api: Api,
  opts: { platform?: string; mode?: string } = {},
): Promise<{ ok: boolean; message: string }> {
  const res = await api('/svc/v1/products/resync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
  return {
    ok: res.ok && (data.ok ?? true),
    message: data.message ?? (res.ok ? 'Importing your products…' : `Failed (${res.status}).`),
  };
}
