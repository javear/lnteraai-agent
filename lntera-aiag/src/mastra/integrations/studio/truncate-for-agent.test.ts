import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { truncateForAgent, MAX_EXEC_OUTPUT_CHARS, MAX_FILE_CONTENT_CHARS } from './tools';

describe('truncateForAgent', () => {
  it('leaves short text untouched', () => {
    assert.equal(truncateForAgent('hello'), 'hello');
    assert.equal(truncateForAgent('hello', MAX_FILE_CONTENT_CHARS), 'hello');
  });

  it('truncates exec output to the default cap, keeping head and tail', () => {
    const text = `HEAD${'x'.repeat(MAX_EXEC_OUTPUT_CHARS * 2)}TAIL`;
    const result = truncateForAgent(text);
    assert.ok(result.length < text.length);
    assert.ok(result.startsWith('HEAD'));
    assert.ok(result.endsWith('TAIL'));
    assert.match(result, /characters omitted/);
  });

  it('never returns something longer than the requested cap plus the omission marker overhead', () => {
    const text = 'y'.repeat(MAX_FILE_CONTENT_CHARS * 3);
    const result = truncateForAgent(text, MAX_FILE_CONTENT_CHARS);
    // head + tail is exactly maxChars; only the inserted marker text adds extra length.
    assert.ok(result.length < MAX_FILE_CONTENT_CHARS + 100);
  });

  it('uses a much larger cap for file/diff content than exec output', () => {
    const text = 'z'.repeat(MAX_EXEC_OUTPUT_CHARS + 500);
    // Under the exec-output default cap, this would truncate...
    assert.notEqual(truncateForAgent(text), text);
    // ...but under the file-content cap, it fits untouched.
    assert.equal(truncateForAgent(text, MAX_FILE_CONTENT_CHARS), text);
  });
});
