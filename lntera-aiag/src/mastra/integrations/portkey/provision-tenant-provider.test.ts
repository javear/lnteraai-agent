import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSelectedModels } from './provision-tenant-provider';

describe('normalizeSelectedModels', () => {
  it('returns empty for undefined', () => {
    assert.deepEqual(normalizeSelectedModels(undefined), []);
  });

  it('trims, drops blanks, and de-dupes', () => {
    assert.deepEqual(normalizeSelectedModels(['  gpt-4o ', 'gpt-4o', '', '  ']), ['gpt-4o']);
  });

  it('strips a leading provider prefix that matches the code', () => {
    assert.deepEqual(normalizeSelectedModels(['openai/gpt-4o'], 'openai'), ['gpt-4o']);
  });

  it('strips only the leading provider prefix, preserving internal slashes (OpenRouter)', () => {
    assert.deepEqual(
      normalizeSelectedModels(['openrouter/anthropic/claude-3.5-sonnet'], 'openrouter'),
      ['anthropic/claude-3.5-sonnet'],
    );
  });

  it('leaves a slash-bearing code alone when it is not the provider prefix', () => {
    assert.deepEqual(
      normalizeSelectedModels(['anthropic/claude-3.5-sonnet'], 'openrouter'),
      ['anthropic/claude-3.5-sonnet'],
    );
  });

  it('is case-insensitive on the prefix strip', () => {
    assert.deepEqual(normalizeSelectedModels(['OpenAI/gpt-4o'], 'openai'), ['gpt-4o']);
  });
});
