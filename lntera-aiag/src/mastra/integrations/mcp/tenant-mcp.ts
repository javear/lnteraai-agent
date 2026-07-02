import { MCPClient } from '@mastra/mcp';
import { getConnectedTenantMcpProject } from '../shared/tenant-projects';
import { resolveIntegrationVaultSecret } from '../shared/vault';
import { logErrorBrief } from '../../logger/compact-error';

type McpTools = Awaited<ReturnType<MCPClient['listTools']>>;
const EMPTY = {} as McpTools;

/** Cached MCPClient per tenant (keyed by tenant + endpoint) so we don't reconnect every request. */
const cache = new Map<string, { client: MCPClient; url: string }>();

/**
 * Tools from the tenant's CONNECTED MCP project (built + deployed in Studio), for merging into the
 * business agent's toolset. Best-effort: any failure (not connected, endpoint down, bad token)
 * returns no tools rather than breaking the agent. The MCP auth token is read from Vault and sent as
 * a Bearer header; the tenant owns this MCP, so its tools bypass the generic role filter.
 */
export async function getTenantMcpTools(tenantId: string | null | undefined): Promise<McpTools> {
  if (!tenantId) return EMPTY;
  try {
    const project = await getConnectedTenantMcpProject(tenantId);
    if (!project?.mcp_url) return EMPTY;

    let authToken: string | undefined;
    if (project.mcp_secret_ref) {
      const secret = await resolveIntegrationVaultSecret(project.mcp_secret_ref).catch(() => null);
      if (secret && typeof secret.authToken === 'string') authToken = secret.authToken;
    }

    let entry = cache.get(tenantId);
    if (!entry || entry.url !== project.mcp_url) {
      if (entry) await entry.client.disconnect().catch(() => undefined);
      const client = new MCPClient({
        id: `tenant-mcp-${tenantId}`,
        servers: {
          tenant: {
            url: new URL(project.mcp_url),
            requestInit: authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {},
          },
        },
      });
      entry = { client, url: project.mcp_url };
      cache.set(tenantId, entry);
    }

    return await entry.client.listTools();
  } catch (err) {
    logErrorBrief(`[tenant-mcp] failed to load tools for tenant=${tenantId}`, err);
    return EMPTY;
  }
}
