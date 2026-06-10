const DEFAULT_PORTKEY_BASE_URL = 'https://api.portkey.ai/v1';

export function getPortkeyBaseUrl(): string {
  const raw = process.env.PORTKEY_BASE_URL?.trim();
  return raw && raw.length > 0 ? raw.replace(/\/+$/, '') : DEFAULT_PORTKEY_BASE_URL;
}

export function getPortkeyInferenceApiKey(): string {
  const key = process.env.PORTKEY_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'PORTKEY_API_KEY is not set. Create an inference API key in the Portkey dashboard.',
    );
  }
  return key;
}

export function getPortkeyAdminApiKey(): string {
  const key = process.env.PORTKEY_ADMIN_API_KEY?.trim() || process.env.PORTKEY_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'PORTKEY_ADMIN_API_KEY (or PORTKEY_API_KEY) is not set. Required to provision tenant Groq integrations.',
    );
  }
  return key;
}

export function getPortkeyWorkspaceId(): string | undefined {
  const id = process.env.PORTKEY_WORKSPACE_ID?.trim();
  return id && id.length > 0 ? id : undefined;
}

export function getMastraPublicBaseUrl(): string {
  const raw =
    process.env.MASTRA_PUBLIC_BASE_URL?.trim() ||
    process.env.OPENAPI_BASE_URL?.trim() ||
    'http://localhost:4111';
  return raw.replace(/\/+$/, '');
}
