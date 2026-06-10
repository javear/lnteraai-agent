/**
 * Verifies Portkey mapping preserves Groq chain order and model identity extraction.
 * Run: npx tsx scripts/verify-portkey-model-chain.mjs
 */

function assert(cond, label) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
}

const { buildAvailableGroqChain, pickNextGroqModelInChain } = await import(
  '../src/mastra/models/groq-model-chain.ts'
);
const {
  buildAvailablePortkeyGroqChain,
  groqChainOrderFromPortkeyChain,
} = await import('../src/mastra/integrations/portkey/portkey-groq-chain.ts');
const { extractGroqModelIdentity } = await import(
  '../src/mastra/integrations/portkey/model-config.ts'
);
const { markGroqModelRateLimited } = await import(
  '../src/mastra/processors/groq-rate-limit-cache.ts'
);

const { GROQ_TOOL_MODELS } = await import('../src/mastra/models/groq-tool-models.ts');

const tenant = 'verify-portkey-' + Date.now();
const providerSlug = 'acme-test';
const fixedOrder = [...GROQ_TOOL_MODELS];

const groqChain = buildAvailableGroqChain({
  tenantId: tenant,
  largeContext: false,
  chainOrder: fixedOrder,
});
const portkeyChain = buildAvailablePortkeyGroqChain({
  providerSlug,
  tenantId: tenant,
  largeContext: false,
  chainOrder: fixedOrder,
});

assert(groqChain.length === portkeyChain.length, 'chain length matches');
assert(
  groqChain.map((e) => e.model).join('|') === groqChainOrderFromPortkeyChain(portkeyChain).join('|'),
  'chain order preserved after Portkey mapping',
);

const sample = portkeyChain[0]?.model;
assert(sample?.id.includes(`@${providerSlug}/`), 'portkey id uses @provider/model format');

const identity = extractGroqModelIdentity(sample);
assert(identity.startsWith('groq/'), 'extractGroqModelIdentity returns groq/ prefix');
assert(
  identity === groqChain[0]?.model,
  `identity matches groq chain entry (${identity} vs ${groqChain[0]?.model})`,
);

const order = groqChain.map((e) => e.model);
markGroqModelRateLimited(tenant, order[0], 60_000);
const next = pickNextGroqModelInChain({
  tenantId: tenant,
  chainOrder: order,
  afterIdentity: order[0],
});
assert(next === order[1], `429 advance unchanged (${next})`);

console.log('verify-portkey-model-chain: OK');
