import type { ProcessInputArgs, Processor } from '@mastra/core/processors';
import { TENANT_MASTER_ID_KEY } from '../integrations/shared/marketplace-auth';
import {
  buildGroqOnboardUrl,
  groqNotConfiguredMessage,
} from '../integrations/shared/groq-onboard-url';
import { resolveActiveTenantProviders } from '../integrations/portkey/resolve-tenant-model';

/**
 * Blocks agent runs when the tenant has not connected Groq via Portkey.
 * Emits a tripwire with a signed onboard link — no LLM call.
 */
export const groqOnboardGateProcessor = {
  id: 'groq-onboard-gate',
  name: 'Groq / Portkey onboarding gate',

  async processInput({ requestContext, abort, messageList }: ProcessInputArgs) {
    const tenantIdRaw = requestContext?.get?.(TENANT_MASTER_ID_KEY);
    const tenantId =
      typeof tenantIdRaw === 'string' && tenantIdRaw.length > 0 ? tenantIdRaw : null;
    if (!tenantId) {
      abort('This agent requires a workspace (tenant_master_id).');
    }
    const tenant = tenantId!;

    const active = await resolveActiveTenantProviders(tenant);
    if (active.length === 0) {
      const url = await buildGroqOnboardUrl(tenant);
      abort(groqNotConfiguredMessage(url), {
        metadata: { code: 'groq_not_configured', tenant_id: tenant },
      });
    }

    return messageList;
  },
} satisfies Processor<'groq-onboard-gate'>;
