import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { repairCommonJsonIssues } from './discord-reply-formatter';

describe('repairCommonJsonIssues', () => {
  it('quotes unquoted object keys', () => {
    assert.equal(repairCommonJsonIssues("{ ops: [] }"), '{ "ops": [] }');
  });

  it('converts single-quoted strings to double-quoted, escaping embedded double quotes', () => {
    assert.equal(repairCommonJsonIssues(`{'text': 'say "hi"'}`), '{"text": "say \\"hi\\""}');
  });

  it('escapes a raw backslash inside a single-quoted string instead of corrupting it', () => {
    const input = "{'text': 'C:\\Users\\foo'}"; // runtime string contains one literal backslash each
    const repaired = repairCommonJsonIssues(input);
    assert.equal(repaired, '{"text": "C:\\\\Users\\\\foo"}'); // valid JSON: backslash escaped as \\
    const parsed = JSON.parse(repaired) as { text: string };
    assert.equal(parsed.text, 'C:\\Users\\foo');
  });

  it('removes trailing commas before closing brackets', () => {
    assert.equal(repairCommonJsonIssues('{"a": 1,}'), '{"a": 1}');
  });

  it('balances a truncated closing brace', () => {
    assert.equal(repairCommonJsonIssues('{"a": 1'), '{"a": 1}');
  });
});
