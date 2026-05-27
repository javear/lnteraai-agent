import { z } from 'zod';

export const PLATFORMS = ['shopee', 'tiktok'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Uuid = string;

export const INTEGRATION_CODES = ['discord'] as const;
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
