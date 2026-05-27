/**
 * Quick checks for Groq rate-limit parsing and chain fallback order.
 * Run: npx tsx scripts/verify-groq-rate-limit-chain.mjs
 */

function assert(cond, label) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
}

const { extractGroqRateLimitFromError, parseGroqResetTokensHeader, markGroqModelRateLimited } =
  await import('../src/mastra/processors/groq-rate-limit-cache.ts');
const { partitionGroqModelsForContext, pickNextGroqModelInChain } = await import(
  '../src/mastra/models/groq-model-chain.ts'
);

assert(parseGroqResetTokensHeader('39.735s') === 39735, 'parse seconds header');

const msg =
  'Rate limit reached for model `openai/gpt-oss-120b` ... Please try again in 39.735s';
const rl = extractGroqRateLimitFromError({ statusCode: 429, message: msg }, 'groq/openai/gpt-oss-120b');
assert(rl != null && rl.ttlMs >= 39000, 'parse try again in message');

const large = partitionGroqModelsForContext(true);
assert(!large[large.length - 1]?.includes('8b-instant'), '8b not preferred head for large context');

const tenant = 'verify-tenant-' + Date.now();
const order = ['groq/a', 'groq/b', 'groq/c'];
markGroqModelRateLimited(tenant, 'a', 60_000);
const next = pickNextGroqModelInChain({ tenantId: tenant, chainOrder: order, afterIdentity: 'groq/a' });
assert(next === 'groq/b', `expected groq/b got ${next}`);

console.log('verify-groq-rate-limit-chain: OK');
