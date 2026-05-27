/** Reserved URL prefix for non-agent HTTP APIs (OpenAPI product surface). */
export const OPEN_API_PREFIX = '/svc/v1';

export const OPENAPI_TAGS = {
  root: ['OpenAPI'],
  auth: ['OpenAPI', 'Auth'],
  integrations: ['OpenAPI', 'Integrations'],
} as const;

export const JWT_ISSUER = 'lntera-open-api';
export const JWT_AUDIENCE = 'lntera-integrations';

/** Default access token lifetime (seconds). */
export const DEFAULT_JWT_TTL_SEC = 900;
