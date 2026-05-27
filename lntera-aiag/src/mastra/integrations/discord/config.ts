import {
  discordLegacyTenantIntegrationConfigSchema,
  discordTenantIntegrationConfigSchema,
  discordVaultSecretPayloadSchema,
  type DiscordLegacyTenantIntegrationConfig,
  type DiscordTenantIntegrationConfig,
  type DiscordVaultSecretPayload,
} from '../shared/types';

export function parseDiscordTenantIntegrationConfig(
  raw: Record<string, unknown>,
): DiscordTenantIntegrationConfig {
  return discordTenantIntegrationConfigSchema.parse(raw);
}

export function parseDiscordLegacyTenantIntegrationConfig(
  raw: Record<string, unknown>,
): DiscordLegacyTenantIntegrationConfig {
  return discordLegacyTenantIntegrationConfigSchema.parse(raw);
}

export function parseDiscordVaultPayload(raw: Record<string, unknown>): DiscordVaultSecretPayload {
  return discordVaultSecretPayloadSchema.parse(raw);
}
