import { registerApiRoute } from '@mastra/core/server';
import { getSupabase } from '../integrations/shared/supabase';
import { provisionWorkspaceForAuthUser } from '../integrations/shared/tenant-users';
import { webAppUrl } from './web-app-origin';

/**
 * Tenant-user registration / login (POC).
 *
 * `GET /auth` serves a Supabase-backed sign in / sign up page (email/password + Google) that,
 * on success, shows the user's access token for testing `/api/*` in Postman. `POST /auth/signup`
 * creates the Supabase user + a new workspace; `POST /auth/provision` maps a social-login user
 * to a workspace on first sign-in. All are public (auth happens via Supabase, not our JWT layer).
 */
export const authRoutes = [
  // Legacy entry point — the SPA now owns sign in / sign up at /app/login.
  registerApiRoute('/auth', {
    method: 'GET',
    requiresAuth: false,
    openapi: {
      summary: 'Redirect to the web app login (SPA owns auth UI)',
      tags: ['Auth'],
      responses: { 302: { description: 'Redirect to the web app login' } },
    },
    handler: async (c) => c.redirect(webAppUrl('/login')),
  }),

  registerApiRoute('/auth/signup', {
    method: 'POST',
    requiresAuth: false,
    openapi: {
      summary: 'Register a tenant user (creates Supabase user + a new workspace)',
      tags: ['Auth'],
      responses: { 200: { description: 'Created' }, 400: { description: 'Invalid request' } },
    },
    handler: async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_request', message: 'Expected JSON body.' }, 400);
      }
      const body = (raw ?? {}) as { email?: unknown; password?: unknown; workspaceName?: unknown };
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const workspaceName = typeof body.workspaceName === 'string' ? body.workspaceName : undefined;
      if (!email || !/.+@.+\..+/.test(email)) {
        return c.json({ error: 'invalid_email', message: 'A valid email is required.' }, 400);
      }
      if (password.length < 8) {
        return c.json({ error: 'weak_password', message: 'Password must be at least 8 characters.' }, 400);
      }

      try {
        const supabase = getSupabase();
        const { data, error } = await supabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true, // POC: skip email verification
        });
        if (error || !data?.user) {
          return c.json({ error: 'signup_failed', message: error?.message ?? 'Could not create user.' }, 400);
        }
        const { tenantId } = await provisionWorkspaceForAuthUser({
          authUserId: data.user.id,
          email,
          workspaceName,
        });
        return c.json({ ok: true, tenantId }, 200);
      } catch (err) {
        return c.json(
          { error: 'signup_failed', message: err instanceof Error ? err.message : 'Signup failed.' },
          400,
        );
      }
    },
  }),

  registerApiRoute('/auth/provision', {
    method: 'POST',
    requiresAuth: false,
    openapi: {
      summary: 'Map an authenticated Supabase user to a workspace (first social sign-in)',
      tags: ['Auth'],
      responses: { 200: { description: 'Provisioned' }, 401: { description: 'Invalid token' } },
    },
    handler: async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_request', message: 'Expected JSON body.' }, 400);
      }
      const accessToken = typeof (raw as { accessToken?: unknown })?.accessToken === 'string'
        ? ((raw as { accessToken: string }).accessToken).trim()
        : '';
      if (!accessToken) {
        return c.json({ error: 'invalid_request', message: 'accessToken is required.' }, 400);
      }

      try {
        const { data, error } = await getSupabase().auth.getUser(accessToken);
        if (error || !data?.user) {
          return c.json({ error: 'invalid_token', message: 'Could not verify the access token.' }, 401);
        }
        // Email sign-up stashes the chosen workspace name in user metadata (Google sign-in has none).
        const wsName = (data.user.user_metadata as { workspace_name?: unknown } | null)?.workspace_name;
        const { tenantId } = await provisionWorkspaceForAuthUser({
          authUserId: data.user.id,
          email: data.user.email ?? null,
          workspaceName: typeof wsName === 'string' && wsName.trim() ? wsName.trim() : undefined,
        });
        return c.json({ ok: true, tenantId }, 200);
      } catch (err) {
        return c.json(
          { error: 'provision_failed', message: err instanceof Error ? err.message : 'Provision failed.' },
          400,
        );
      }
    },
  }),
];
