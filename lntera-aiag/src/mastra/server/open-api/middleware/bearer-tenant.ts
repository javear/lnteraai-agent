import { verifyOpenApiAccessToken } from '../jwt';

/** Minimal shape for Mastra `registerApiRoute` handlers (Hono-compatible). */
export type OpenApiHandlerContext = {
  req: {
    header: (name: string) => string | undefined;
    json: <T = unknown>() => Promise<T>;
  };
  json: (data: unknown, status?: number) => Response;
  text: (body: string, status?: number) => Response;
};

export function openApiJsonError(
  c: OpenApiHandlerContext,
  status: number,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}

function extractBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m?.[1]?.trim() || null;
}

/**
 * Verifies `Authorization: Bearer` JWT and returns canonical tenant UUID from `sub`.
 */
export async function requireTenantJwt(
  c: OpenApiHandlerContext,
): Promise<{ tenantId: string } | Response> {
  const token = extractBearer(c.req.header('Authorization'));
  if (!token) {
    return openApiJsonError(c, 401, 'unauthorized', 'Missing or invalid Authorization bearer token.');
  }

  try {
    const claims = await verifyOpenApiAccessToken(token);
    return { tenantId: claims.sub };
  } catch {
    return openApiJsonError(c, 401, 'unauthorized', 'Invalid or expired access token.');
  }
}
