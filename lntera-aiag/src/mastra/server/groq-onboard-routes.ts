import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { connectTenantGroq, loadTenantForGroqOnboard } from '../integrations/portkey/connect-tenant-groq';
import { isValidGroqApiKey } from '../integrations/portkey/slugs';
import { resolveTenantGroqConfig } from '../integrations/portkey/resolve-tenant-model';
import { verifyGroqOnboardToken } from '../integrations/shared/groq-onboard-state';
import { groqOnboardSubmitSchema } from '../integrations/shared/types';
import { resolveTenantId } from '../integrations/shared/supabase';
import { notifyTenantOfConnectionEvent } from '../active-mode/notifier';
import { oauthErrorPage, groqAlreadyConnectedPage, groqOnboardFormPage } from './html-pages';

async function verifyOnboardAuth(input: {
  tenantInput: string;
  token: string;
}): Promise<{ tenantId: string }> {
  const payload = verifyGroqOnboardToken(input.token);
  const tenantUuid = await resolveTenantId(input.tenantInput);
  if (payload.tenantId !== tenantUuid) {
    throw new Error('Onboard token does not match tenant.');
  }
  return { tenantId: tenantUuid };
}

export const groqOnboardRoutes = [
  registerApiRoute('/integrations/groq/onboard', {
    method: 'GET',
    requiresAuth: false,
    openapi: {
      summary: 'Groq API key onboarding page (tenant-scoped, signed token)',
      tags: ['Integrations'],
      parameters: [
        { name: 'tenantId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'HTML onboarding page' }, 400: { description: 'Invalid token or tenant' } },
    },
    handler: async (c) => {
      const tenantInput = c.req.query('tenantId');
      const token = c.req.query('token');
      if (!tenantInput || !token) {
        return c.html(
          oauthErrorPage({ platform: 'Groq', title: 'Missing parameters', message: 'The tenantId or token parameter is missing.' }),
          400,
        );
      }

      try {
        const { tenantId } = await verifyOnboardAuth({ tenantInput, token });
        const tenant = await loadTenantForGroqOnboard(tenantInput);
        const existing = await resolveTenantGroqConfig(tenantId);

        if (existing?.status === 'active') {
          return c.html(groqAlreadyConnectedPage({ tenantName: tenant.name, tenantSlug: tenant.slug }));
        }

        return c.html(
          groqOnboardFormPage({ tenantId, tenantSlug: tenant.slug, tenantName: tenant.name, token }),
        );
      } catch (err) {
        return c.html(
          oauthErrorPage({ platform: 'Groq', title: 'Invalid link', message: (err as Error).message }),
          400,
        );
      }
    },
  }),

  registerApiRoute('/integrations/groq/onboard', {
    method: 'POST',
    requiresAuth: false,
    openapi: {
      summary: 'Submit Groq API key for onboarding',
      tags: ['Integrations'],
      responses: { 200: { description: 'Provisioned' }, 400: { description: 'Invalid request' } },
    },
    handler: async (c) => {
      const headerToken = c.req.header('X-Groq-Onboard-Token');

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_request', message: 'Expected JSON body.' }, 400);
      }

      let body;
      try {
        body = groqOnboardSubmitSchema.parse(raw);
      } catch (err) {
        const msg =
          err instanceof z.ZodError
            ? err.issues.map((i) => i.message).join('; ')
            : String(err);
        return c.json({ error: 'invalid_body', message: msg }, 400);
      }

      const token = body.token || headerToken;
      const tenantInput = body.tenantId;
      if (!token || !tenantInput) {
        return c.json({ error: 'invalid_request', message: 'tenantId and token are required.' }, 400);
      }

      if (!isValidGroqApiKey(body.groqApiKey)) {
        return c.json({ error: 'invalid_key', message: 'Groq API key must start with gsk_.' }, 400);
      }

      let tenantId: string;
      try {
        ({ tenantId } = await verifyOnboardAuth({ tenantInput, token }));
      } catch (err) {
        return c.json(
          { error: 'invalid_token', message: err instanceof Error ? err.message : 'Invalid token.' },
          401,
        );
      }

      try {
        const config = await connectTenantGroq({ tenantId, groqApiKey: body.groqApiKey });
        if (config.status === 'active') {
          void notifyTenantOfConnectionEvent({ tenantId, integration: 'groq', status: 'connected' });
        } else {
          void notifyTenantOfConnectionEvent({ tenantId, integration: 'groq', status: 'failed', errorMessage: config.errorMessage ?? undefined });
        }
        return c.json(
          {
            status: config.status,
            portkeyProviderSlug: config.portkeyProviderSlug,
            connectedAt: config.connectedAt,
          },
          200,
        );
      } catch (err) {
        void notifyTenantOfConnectionEvent({ tenantId, integration: 'groq', status: 'failed', errorMessage: err instanceof Error ? err.message : 'Failed to connect Groq.' });
        return c.json(
          {
            error: 'provision_failed',
            message: err instanceof Error ? err.message : 'Failed to connect Groq.',
          },
          400,
        );
      }
    },
  }),

  registerApiRoute('/integrations/groq/status', {
    method: 'GET',
    requiresAuth: false,
    openapi: {
      summary: 'Poll Groq onboarding status',
      tags: ['Integrations'],
      parameters: [
        { name: 'tenantId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Status JSON' } },
    },
    handler: async (c) => {
      const tenantInput = c.req.query('tenantId');
      const token = c.req.query('token');
      if (!tenantInput || !token) {
        return c.json({ error: 'invalid_request', message: 'Missing tenantId or token.' }, 400);
      }

      try {
        const { tenantId } = await verifyOnboardAuth({ tenantInput, token });
        const config = await resolveTenantGroqConfig(tenantId);
        return c.json({
          status: config?.status ?? 'pending',
          portkeyProviderSlug: config?.portkeyProviderSlug ?? null,
          connectedAt: config?.connectedAt ?? null,
          errorMessage: config?.errorMessage ?? null,
        });
      } catch (err) {
        return c.json(
          { error: 'invalid_token', message: err instanceof Error ? err.message : 'Invalid token.' },
          400,
        );
      }
    },
  }),
];
