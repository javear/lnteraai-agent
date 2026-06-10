import { getMastraPublicBaseUrl } from '../portkey/config';
import { createGroqOnboardToken } from './groq-onboard-state';
import { getTenantById } from './supabase';

export async function buildGroqOnboardUrl(tenantId: string): Promise<string> {
  const tenant = await getTenantById(tenantId);
  const tenantParam = tenant?.slug ?? tenantId;
  const token = createGroqOnboardToken({ tenantId });
  const base = getMastraPublicBaseUrl();
  return `${base}/integrations/groq/onboard?tenantId=${encodeURIComponent(tenantParam)}&token=${encodeURIComponent(token)}`;
}

export function groqNotConfiguredMessage(onboardUrl: string): string {
  return (
    `This workspace needs a Groq API key before the assistant can run.\n\n` +
    `Connect your key here (takes about a minute):\n${onboardUrl}\n\n` +
    `You'll create a key at Groq, paste it on our page, and we'll wire it up securely via Portkey.`
  );
}
