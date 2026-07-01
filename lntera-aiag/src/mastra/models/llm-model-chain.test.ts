import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type ActiveLlmProvider,
  buildCombinedLlmPool,
  providerAllowedSegments,
  resolvePinnedLlmChain,
} from './llm-model-chain';
import { LLM_PROVIDERS, toModelCode } from './llm-providers';

/** Order is randomized inside the pool builder, so compare as sets. */
const asSet = (xs: readonly string[]) => [...xs].sort();

const groq: ActiveLlmProvider = { code: 'groq', providerSlug: 'acme' };
const gemini: ActiveLlmProvider = { code: 'gemini', providerSlug: 'acme-gemini' };
const openai = (models: string[]): ActiveLlmProvider => ({
  code: 'openai',
  providerSlug: 'acme-openai',
  selectedModels: models,
});
const openrouter = (models: string[]): ActiveLlmProvider => ({
  code: 'openrouter',
  providerSlug: 'acme-openrouter',
  selectedModels: models,
});

describe('providerAllowedSegments', () => {
  it('free providers use their curated registry toolModels', () => {
    assert.deepEqual([...providerAllowedSegments(groq)], [...LLM_PROVIDERS.groq.toolModels]);
  });

  it('advanced providers use the tenant selectedModels', () => {
    assert.deepEqual([...providerAllowedSegments(openai(['gpt-4o', 'gpt-4o-mini']))], ['gpt-4o', 'gpt-4o-mini']);
  });

  it('advanced provider with no selected models is empty', () => {
    assert.deepEqual([...providerAllowedSegments(openai([]))], []);
    assert.deepEqual([...providerAllowedSegments({ code: 'openai', providerSlug: 'x' })], []);
  });
});

describe('resolvePinnedLlmChain', () => {
  const freeSegment = LLM_PROVIDERS.groq.toolModels[0];

  it('returns null when nothing is pinned', () => {
    assert.equal(resolvePinnedLlmChain(undefined, [groq]), null);
  });

  it('pins a free model that is in the provider toolModels', () => {
    const pinned = toModelCode('groq', freeSegment);
    assert.deepEqual(resolvePinnedLlmChain(pinned, [groq]), [pinned]);
  });

  it('pins an advanced model that is in the tenant selectedModels', () => {
    assert.deepEqual(resolvePinnedLlmChain('openai/gpt-4o', [openai(['gpt-4o'])]), ['openai/gpt-4o']);
  });

  it('rejects an advanced model NOT in selectedModels (paid model cannot be forced)', () => {
    assert.equal(resolvePinnedLlmChain('openai/gpt-4o', [openai(['gpt-4o-mini'])]), null);
  });

  it('rejects a model whose provider is not connected', () => {
    assert.equal(resolvePinnedLlmChain('openai/gpt-4o', [groq]), null);
  });

  it('handles OpenRouter multi-slash segments (split on the first slash only)', () => {
    const p = openrouter(['anthropic/claude-3.5-sonnet']);
    assert.deepEqual(resolvePinnedLlmChain('openrouter/anthropic/claude-3.5-sonnet', [p]), [
      'openrouter/anthropic/claude-3.5-sonnet',
    ]);
  });
});

describe('buildCombinedLlmPool (tier-aware default pool)', () => {
  it('is empty with no providers', () => {
    assert.deepEqual(buildCombinedLlmPool([], false), []);
  });

  it('includes only free providers and excludes advanced/paid ones', () => {
    const pool = buildCombinedLlmPool([groq, openai(['gpt-4o'])], false);
    const expected = LLM_PROVIDERS.groq.toolModels.map((s) => toModelCode('groq', s));
    assert.deepEqual(asSet(pool), asSet(expected));
    assert.ok(!pool.includes('openai/gpt-4o'), 'paid model must not be in the auto-rotation pool');
  });

  it('interleaves multiple free providers', () => {
    const pool = buildCombinedLlmPool([groq, gemini], false);
    const expected = [
      ...LLM_PROVIDERS.groq.toolModels.map((s) => toModelCode('groq', s)),
      ...LLM_PROVIDERS.gemini.toolModels.map((s) => toModelCode('gemini', s)),
    ];
    assert.deepEqual(asSet(pool), asSet(expected));
  });

  it('falls back to advanced providers when NO free provider is connected', () => {
    const pool = buildCombinedLlmPool([openai(['gpt-4o', 'gpt-4o-mini'])], false);
    assert.deepEqual(asSet(pool), asSet(['openai/gpt-4o', 'openai/gpt-4o-mini']));
  });
});
