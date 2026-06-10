import type { TenantMaster } from '../shared/types';
import { type LlmProviderCode } from '../../models/llm-providers';

const PORTKEY_SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Tenant base slug — `tenant.slug` with safe fallbacks. */
export function derivePortkeyProviderSlug(tenant: Pick<TenantMaster, 'slug' | 'id'>): string {
  const base = sanitizePortkeySlug(tenant.slug) || sanitizePortkeySlug(tenant.id.replace(/-/g, ''));
  if (!base) {
    throw new Error(`Cannot derive Portkey provider slug for tenant ${tenant.id}.`);
  }
  return base;
}

/** Append a suffix to the tenant base slug, staying within Portkey's 64-char limit. */
function deriveSuffixedSlug(tenant: Pick<TenantMaster, 'slug' | 'id'>, suffix: string): string {
  const base = derivePortkeyProviderSlug(tenant);
  const candidate = `${base}-${suffix}`;
  if (candidate.length <= 64 && PORTKEY_SLUG_PATTERN.test(candidate)) return candidate;
  return `${base.slice(0, 63 - suffix.length)}-${suffix}`;
}

/**
 * Portkey **provider** slug per LLM provider.
 * Groq keeps the bare tenant slug for back-compat; others get `{slug}-{code}`.
 */
export function derivePortkeyProviderSlugFor(
  tenant: Pick<TenantMaster, 'slug' | 'id'>,
  code: LlmProviderCode,
): string {
  return code === 'groq' ? derivePortkeyProviderSlug(tenant) : deriveSuffixedSlug(tenant, code);
}

/** Portkey **integration** slug (key store) per provider — always `{slug}-{code}`. */
export function derivePortkeyIntegrationSlugFor(
  tenant: Pick<TenantMaster, 'slug' | 'id'>,
  code: LlmProviderCode,
): string {
  return deriveSuffixedSlug(tenant, code);
}

/** Portkey integration slug storing the tenant Groq API key (back-compat: `{slug}-groq`). */
export function derivePortkeyIntegrationSlug(tenant: Pick<TenantMaster, 'slug' | 'id'>): string {
  return derivePortkeyIntegrationSlugFor(tenant, 'groq');
}

export function sanitizePortkeySlug(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!trimmed || !PORTKEY_SLUG_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * A Portkey-valid display name. Portkey rejects names containing characters like `@` or `.`
 * (AB01 "Invalid value"), and our tenant name often defaults to the user's email. Reduce to
 * letters/digits/space/hyphen/underscore, then append a suffix (e.g. "Groq", "LLM").
 */
export function derivePortkeyName(
  tenant: Pick<TenantMaster, 'name' | 'slug' | 'id'>,
  suffix: string,
): string {
  const cleaned = (tenant.name ?? '')
    .replace(/[^a-zA-Z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || sanitizePortkeySlug(tenant.slug) || `tenant ${tenant.id.slice(0, 8)}`;
  return `${base} ${suffix}`.slice(0, 60).trim();
}

export function isValidGroqApiKey(value: string): boolean {
  const key = value.trim();
  return key.startsWith('gsk_') && key.length >= 20;
}

export function isValidGeminiApiKey(value: string): boolean {
  const key = value.trim();
  // Google AI Studio issues both legacy `AIza…` keys and newer `AQ.…` keys.
  return (key.startsWith('AIza') || key.startsWith('AQ.')) && key.length >= 14;
}
