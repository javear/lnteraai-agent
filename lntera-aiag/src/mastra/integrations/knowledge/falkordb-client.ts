// FalkorDB Cloud connection: ONE shared instance, ONE named graph per tenant ("tenant:{tenantId}").
// This is platform infra (not per-tenant BYOK) — the connection secret is a single env var, and
// tenant isolation comes entirely from the graph name, matching FalkorDB's multigraph tenancy model.
//
// Config (env):
//   FALKORDB_URL      – EITHER a full `falkor[s]://[[user][:password]@]host[:port]` URI, OR the bare
//                        `host:port` FalkorDB Cloud's dashboard shows (no scheme) — both are accepted.
//   FALKORDB_PASSWORD – the database password (FalkorDB Cloud always issues one separately from host:port).
//   FALKORDB_USERNAME – optional ACL username (FalkorDB Cloud instances often use one other than
//                        "default" — check the dashboard's connection details, not just host/port/password).
//   FALKORDB_TLS      – set to "false" to disable TLS. Defaults to true — FalkorDB Cloud requires it.
import { FalkorDB, type Graph, type FalkorDBOptions } from 'falkordb';

const GRAPH_PREFIX = 'tenant:';

let clientPromise: Promise<FalkorDB> | null = null;

function buildConnectOptions(): FalkorDBOptions {
  const raw = process.env.FALKORDB_URL?.trim();
  if (!raw) {
    throw new Error('FALKORDB_URL is not set. Create a FalkorDB Cloud instance and set its connection URL.');
  }
  const password = process.env.FALKORDB_PASSWORD?.trim();
  const username = process.env.FALKORDB_USERNAME?.trim();
  const tls = process.env.FALKORDB_TLS?.trim().toLowerCase() !== 'false';
  const auth = { ...(password ? { password } : {}), ...(username ? { username } : {}) };

  if (/^falkors?:\/\//i.test(raw)) {
    return { url: raw, ...auth };
  }

  // Bare "host:port" (FalkorDB Cloud's dashboard format, no scheme) — parse directly rather than
  // trying to assemble a URI string, which would need to URL-escape special characters in the password.
  const m = /^([^:/]+):(\d+)$/.exec(raw);
  if (!m) {
    throw new Error(`FALKORDB_URL is not a valid "falkor://..." URI or "host:port" pair (got "${raw}").`);
  }
  const [, host, port] = m;
  return {
    socket: { host, port: Number(port), tls },
    ...auth,
  };
}

async function getClient(): Promise<FalkorDB> {
  if (!clientPromise) {
    clientPromise = FalkorDB.connect(buildConnectOptions()).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** The FalkorDB graph name isolating one tenant's knowledge graph from all others. */
export function tenantGraphName(tenantId: string): string {
  return `${GRAPH_PREFIX}${tenantId}`;
}

/** Graph handle scoped to one tenant. Selecting a graph is a lightweight client-side operation. */
export async function getTenantGraph(tenantId: string): Promise<Graph> {
  const client = await getClient();
  return client.selectGraph(tenantGraphName(tenantId));
}

/** Permanently deletes a tenant's entire knowledge graph (used by inactivity eviction). Idempotent. */
export async function deleteTenantGraph(tenantId: string): Promise<void> {
  const graph = await getTenantGraph(tenantId);
  try {
    await graph.delete();
  } catch (err) {
    // FalkorDB errors on DELETE of a graph key that doesn't exist — treat as already-deleted.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/does not exist|unknown graph/i.test(msg)) throw err;
  }
}
