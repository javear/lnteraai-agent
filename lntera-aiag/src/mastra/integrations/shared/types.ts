import { z } from 'zod';

export const PLATFORMS = ['shopee', 'tiktok'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Uuid = string;

export const INTEGRATION_CODES = [
  'discord',
  'groq',
  'gemini',
  'openai',
  'anthropic',
  'openrouter',
  'knowledge',
] as const;
export type IntegrationCode = (typeof INTEGRATION_CODES)[number];

export function isIntegrationCode(value: string): value is IntegrationCode {
  return (INTEGRATION_CODES as readonly string[]).includes(value);
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export interface MarketplaceConnection {
  id: string;
  platform: Platform;
  external_shop_id: string;
  shop_name: string | null;
  region: string | null;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  refresh_token_expires_at: string | null;
  scope: string | null;
  shop_cipher: string | null;
  raw_metadata: Record<string, unknown> | null;
  tenant_id: Uuid;
  created_at: string;
  updated_at: string;
}

export interface TenantMaster {
  id: Uuid;
  slug: string;
  name: string;
  legal_name: string | null;
  country_code: string | null;
  timezone: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertConnectionInput {
  platform: Platform;
  external_shop_id: string;
  shop_name?: string | null;
  region?: string | null;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: Date;
  refresh_token_expires_at?: Date | null;
  scope?: string | null;
  shop_cipher?: string | null;
  raw_metadata?: Record<string, unknown> | null;
  tenant_id: Uuid;
}

export interface UpdateTokensInput {
  access_token: string;
  refresh_token: string;
  access_token_expires_at: Date;
  refresh_token_expires_at?: Date | null;
  raw_metadata?: Record<string, unknown> | null;
}

export interface TenantIntegration {
  id: string;
  tenant_id: Uuid;
  integration_code: IntegrationCode;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Wildcard value in `tenant_roles.allowed_tools` meaning "every tool". */
export const ALL_TOOLS_WILDCARD = '*';

export const TENANT_USER_STATUSES = ['active', 'invited', 'suspended'] as const;
export type TenantUserStatus = (typeof TENANT_USER_STATUSES)[number];

/** Maps a Supabase `auth.users` row to a tenant + role (slug into `tenant_roles`). */
export interface TenantUser {
  id: string;
  tenant_id: Uuid;
  auth_user_id: Uuid;
  email: string | null;
  role: string;
  status: TenantUserStatus;
  created_at: string;
  updated_at: string;
}

/** Per-tenant role definition. `allowed_tools` holds Mastra tool ids; `['*']` = all tools. */
export interface TenantRole {
  id: string;
  tenant_id: Uuid;
  slug: string;
  name: string;
  allowed_tools: string[];
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

const vaultSecretRefSchema = z.object({
  type: z.enum(['id', 'name']),
  value: z.string().min(1),
});

const routingSchema = z
  .object({
    guildId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Stored in tenant_integrations.config for integration_code === "discord".
 *
 * **Single Discord app (recommended):** One platform bot token (`DISCORD_BOT_TOKEN`);
 * per-tenant linkage + consent live here — no tenant bot token.
 *
 * When `enabled` is not `false`, `guildId`, `channelId`, and `dataProcessingAcknowledgedAt` are required.
 */
export const discordTenantIntegrationConfigSchema = z
  .object({
    guildId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    /** ISO 8601 timestamp when the tenant acknowledged data processing / terms. */
    dataProcessingAcknowledgedAt: z.string().min(1).optional(),
    /** Optional terms version string the tenant acknowledged (e.g. "2025-05-01"). */
    termsAcknowledgedVersion: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.enabled === false) return;
    const missing: string[] = [];
    if (!data.guildId?.trim()) missing.push('guildId');
    if (!data.channelId?.trim()) missing.push('channelId');
    if (!data.dataProcessingAcknowledgedAt?.trim()) missing.push('dataProcessingAcknowledgedAt');
    if (missing.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `When enabled (default), required: ${missing.join(', ')}.`,
      });
    }
  });

export type DiscordTenantIntegrationConfig = z.infer<typeof discordTenantIntegrationConfigSchema>;

/**
 * Legacy: one Discord bot token per tenant via Supabase Vault (`vaultSecretRef`).
 * Used only when `DISCORD_BOT_TOKEN` is unset — multi Gateway clients (one per tenant row).
 */
export const discordLegacyTenantIntegrationConfigSchema = z
  .object({
    vaultSecretRef: vaultSecretRefSchema,
    routing: routingSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type DiscordLegacyTenantIntegrationConfig = z.infer<
  typeof discordLegacyTenantIntegrationConfigSchema
>;

/** JSON payload stored inside Supabase Vault for Discord bot credentials. */
export const discordVaultSecretPayloadSchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();

export type DiscordVaultSecretPayload = z.infer<typeof discordVaultSecretPayloadSchema>;

export const groqIntegrationStatusSchema = z.enum(['pending', 'active', 'error', 'revoked']);

/**
 * Stored in tenant_integrations.config for integration_code === "groq".
 * Groq API keys live in Portkey only — never in this config.
 */
export const groqTenantIntegrationConfigSchema = z
  .object({
    status: groqIntegrationStatusSchema,
    portkeyIntegrationSlug: z.string().min(1),
    portkeyProviderSlug: z.string().min(1),
    portkeyIntegrationId: z.string().min(1).optional(),
    portkeyProviderId: z.string().min(1).optional(),
    connectedAt: z.string().min(1).optional(),
    lastValidatedAt: z.string().min(1).optional(),
    errorMessage: z.string().optional(),
  })
  .strict();

export type GroqTenantIntegrationConfig = z.infer<typeof groqTenantIntegrationConfigSchema>;

/**
 * Provider-agnostic config: every BYO LLM provider (Groq, Gemini, OpenAI, …) stores the same
 * Portkey slugs/ids + status in `tenant_integrations.config` — never the API key. Advanced/BYOK
 * providers additionally store `selectedModels`: the provider-relative model segments the tenant
 * is allowed to use (e.g. `gpt-4o`, `anthropic/claude-3.5-sonnet`). Free providers omit it.
 */
export const llmProviderIntegrationConfigSchema = groqTenantIntegrationConfigSchema
  .extend({
    selectedModels: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type LlmProviderIntegrationConfig = z.infer<typeof llmProviderIntegrationConfigSchema>;

export const groqOnboardSubmitSchema = z
  .object({
    groqApiKey: z.string().min(1),
    tenantId: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
  })
  .strict();

// ── Technical agent ("Studio") projects ──────────────────────────────────────────────────

/** A Vault reference stored in a `*_secret_ref` column; the plaintext lives in Supabase Vault. */
export const vaultSecretRefValueSchema = z
  .object({ type: z.enum(['id', 'name']), value: z.string().min(1) })
  .strict();
export type VaultSecretRefValue = z.infer<typeof vaultSecretRefValueSchema>;

export const PROJECT_KINDS = ['mcp', 'webapp'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export function isProjectKind(value: string): value is ProjectKind {
  return (PROJECT_KINDS as readonly string[]).includes(value);
}

export const PROJECT_STATUSES = ['draft', 'deployed', 'connected', 'error'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** A row of `tenant_projects` — correlation + deploy state for one tenant coding project. */
export interface TenantProject {
  id: string;
  tenant_id: Uuid;
  name: string;
  kind: ProjectKind;
  gitea_repo: string | null;
  deploy_url: string | null;
  mcp_url: string | null;
  /** Persistent "development" deploy URL the agent redeploys to on its own — separate from deploy_url/
   *  mcp_url, which only change via the user's explicit Publish action. */
  preview_url: string | null;
  gitea_secret_ref: VaultSecretRefValue | null;
  mcp_secret_ref: VaultSecretRefValue | null;
  status: ProjectStatus;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
