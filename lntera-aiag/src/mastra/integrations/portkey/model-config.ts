import { getPortkeyBaseUrl, getPortkeyInferenceApiKey } from './config';
import {
  type LlmProviderCode,
  providerCodeForSegment,
  splitModelCode,
} from '../../models/llm-providers';

/** Single-provider slug (groq) — kept for back-compat. */
export const PORTKEY_PROVIDER_SLUG_KEY = 'portkeyProviderSlug';
/** Map of `{ [providerCode]: portkeyProviderSlug }` for the tenant's active providers. */
export const PORTKEY_PROVIDER_SLUGS_KEY = 'portkeyProviderSlugs';
/**
 * Map of `{ [providerCode]: string[] }` — the tenant's allowed model segments for advanced/BYOK
 * providers. Lets the rolling processor rebuild a tier-aware chain (which must know each advanced
 * provider's user-selected models) purely from requestContext.
 */
export const PORTKEY_PROVIDER_MODELS_KEY = 'portkeyProviderModels';

export type PortkeyMastraModelConfig = {
  id: `${string}/${string}`;
  url: string;
  apiKey: string;
  headers?: Record<string, string>;
};

const PORTKEY_MODEL_ID_RE = /^openai\/@([^/@]+)\/(.+)$/i;
/** @deprecated Wrong format kept for identity extraction during rollout. */
const LEGACY_PORTKEY_MODEL_ID_RE = /^openai\/@([^@]+)@(.+)$/i;

/** Qualify a Portkey model segment to `${provider}/${segment}` (defaults to groq for back-compat). */
function qualifySegment(segment: string): string {
  const trimmed = segment.trim();
  const provider = providerCodeForSegment(trimmed) ?? 'groq';
  return `${provider}/${trimmed}`;
}

function identityFromPortkeyModelString(trimmed: string): string | null {
  for (const re of [
    PORTKEY_MODEL_ID_RE,
    LEGACY_PORTKEY_MODEL_ID_RE,
    /^@([^/@]+)\/(.+)$/i,
    /^@([^@]+)@(.+)$/i,
  ]) {
    const match = re.exec(trimmed);
    if (match?.[2]) return qualifySegment(match[2]);
  }
  return null;
}

/** Strip the leading `${provider}/` prefix to get the Portkey model segment. */
export function groqToolModelIdToPortkeyModelName(modelCode: string): string {
  const split = splitModelCode(modelCode);
  return split ? split.segment : modelCode.trim();
}

export function buildPortkeyModelConfig(input: {
  providerSlug: string;
  /** A provider-qualified modelCode (`groq/…`, `gemini/…`) or a bare Portkey segment. */
  groqModelId: string;
  metadata?: Record<string, unknown>;
}): PortkeyMastraModelConfig {
  const modelName = groqToolModelIdToPortkeyModelName(input.groqModelId);
  const headers: Record<string, string> = {};
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    headers['x-portkey-metadata'] = JSON.stringify(input.metadata);
  }

  return {
    // Portkey Model Catalog: `@provider-slug/model-id` (single @, slash before model).
    id: `openai/@${input.providerSlug}/${modelName}` as `${string}/${string}`,
    url: getPortkeyBaseUrl(),
    apiKey: getPortkeyInferenceApiKey(),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/**
 * Normalize any model identity (qualified code, bare segment, or Portkey inline config) to
 * `${provider}/${segment}` for rate-limit cache keys and processor decisions.
 */
export function extractGroqModelIdentity(model: unknown): string {
  if (typeof model === 'string') {
    const trimmed = model.trim();
    if (splitModelCode(trimmed)) return trimmed; // already `${provider}/${segment}`
    const fromPortkey = identityFromPortkeyModelString(trimmed);
    if (fromPortkey) return fromPortkey;
    return trimmed ? qualifySegment(trimmed) : '';
  }

  if (!model || typeof model !== 'object') return '';

  const o = model as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : '';
  if (id) {
    const fromId = extractGroqModelIdentity(id);
    if (fromId) return fromId;
  }

  const provider =
    typeof o.provider === 'string'
      ? o.provider
      : typeof o.providerId === 'string'
        ? o.providerId
        : '';
  const modelId = typeof o.modelId === 'string' ? o.modelId : '';
  if (provider && modelId) {
    return splitModelCode(modelId) ? modelId : qualifySegment(modelId);
  }
  return modelId ? qualifySegment(modelId) : '';
}

/** Provider-aware alias. */
export const extractModelIdentity = extractGroqModelIdentity;

function readSlugMap(
  requestContext: { get?: (key: string) => unknown } | undefined,
): Partial<Record<LlmProviderCode, string>> {
  const raw = requestContext?.get?.(PORTKEY_PROVIDER_SLUGS_KEY);
  if (raw && typeof raw === 'object') return raw as Partial<Record<LlmProviderCode, string>>;
  return {};
}

/** Portkey provider slug for a given model code, from the per-request slug map (+ groq fallback). */
export function resolveProviderSlugForModel(
  modelCode: string,
  requestContext: { get?: (key: string) => unknown } | undefined,
): string | null {
  const split = splitModelCode(modelCode);
  const code = split?.code ?? providerCodeForSegment(modelCode);
  const map = readSlugMap(requestContext);
  if (code && typeof map[code] === 'string' && map[code]) return map[code] as string;

  // Back-compat: single-provider (groq) slug key.
  const single = requestContext?.get?.(PORTKEY_PROVIDER_SLUG_KEY);
  if ((!code || code === 'groq') && typeof single === 'string' && single.length > 0) return single;
  return null;
}

export function resolveModelOverrideForRequestContext(
  modelCode: string,
  requestContext: { get?: (key: string) => unknown } | undefined,
): string | PortkeyMastraModelConfig {
  const providerSlug = resolveProviderSlugForModel(modelCode, requestContext);
  if (providerSlug) {
    const tenantId = requestContext?.get?.('tenant_master_id');
    const channel = requestContext?.get?.('channel');
    return buildPortkeyModelConfig({
      providerSlug,
      groqModelId: modelCode,
      metadata: {
        ...(typeof tenantId === 'string' ? { tenant_id: tenantId } : {}),
        ...(typeof channel === 'string' ? { channel } : {}),
        agent: 'general-agent',
      },
    });
  }
  return modelCode;
}
