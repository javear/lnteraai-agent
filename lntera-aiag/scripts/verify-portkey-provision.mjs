/**
 * Smoke check for Portkey slug derivation (no live API calls).
 * Run: npx tsx scripts/verify-portkey-provision.mjs
 */

function assert(cond, label) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
}

const { derivePortkeyIntegrationSlug, derivePortkeyProviderSlug, isValidGroqApiKey } =
  await import('../src/mastra/integrations/portkey/slugs.ts');

const tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'Acme Corp!',
  name: 'Acme Corp',
};

const provider = derivePortkeyProviderSlug(tenant);
const integration = derivePortkeyIntegrationSlug(tenant);

assert(/^[a-z0-9_-]+$/.test(provider), 'provider slug sanitized');
assert(integration.endsWith('-groq'), 'integration slug suffix');
assert(isValidGroqApiKey('gsk_test123456789012345'), 'valid groq key');
assert(!isValidGroqApiKey('sk-openai'), 'reject non-groq key');

console.log('verify-portkey-provision: OK', { provider, integration });
