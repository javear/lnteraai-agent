/**
 * Verifies soft model() + groq onboard gate processor tripwire.
 * Run: npx tsx scripts/verify-groq-onboard-gate.mjs [tenantId]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

function applyEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    val = val.replace(/\r$/, '').trim();
    if (!val) continue;
    if (!process.env[key]?.trim()) {
      process.env[key] = val;
    }
  }
}

applyEnvFile(resolve(PKG_ROOT, '.env'));
delete process.env.DISCORD_EMBEDDED;

function assert(cond, label) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
}

const tenantId = process.argv[2]?.trim() || 'bc25b4f0-769b-4ac6-88c5-44287741cc75';

const { RequestContext } = await import('@mastra/core/request-context');
const { mastra } = await import('../src/mastra/index.ts');
const generalAgent = mastra.getAgent('generalAgent');
const { TENANT_MASTER_ID_KEY } = await import(
  '../src/mastra/integrations/shared/marketplace-auth.ts'
);
const { resolveAgentTextFromResult } = await import(
  '../src/mastra/integrations/shared/agent-result-text.ts'
);
const { isTenantGroqActive, resolveTenantGroqConfig } = await import(
  '../src/mastra/integrations/portkey/resolve-tenant-model.ts'
);

const groqConfig = await resolveTenantGroqConfig(tenantId);
if (isTenantGroqActive(groqConfig)) {
  console.log(`skip: tenant ${tenantId} already has active Groq — pick another tenant`);
  process.exit(0);
}

const requestContext = new RequestContext();
requestContext.set(TENANT_MASTER_ID_KEY, tenantId);

let modelList;
try {
  modelList = await generalAgent.getModelList(requestContext);
} catch (err) {
  console.error('FAIL: getModelList threw (Studio would 500)', err);
  process.exit(1);
}
assert(Array.isArray(modelList) && modelList.length > 0, 'getModelList returns placeholder chain');

const result = await generalAgent.generate('hello', { requestContext, maxSteps: 1 });
assert(result.tripwire?.reason, 'generate tripwire reason present');
const text = resolveAgentTextFromResult(result);
assert(text.includes('/integrations/groq/onboard'), 'tripwire includes onboard URL');
assert(text.includes('Groq API key'), 'tripwire includes onboard message');
assert(!result.text?.trim?.(), 'no LLM text when gate fires');

console.log('verify-groq-onboard-gate: OK');
console.log('sample:', text.split('\n')[0]);
process.exit(0);
