/**
 * Verifies Groq reasoning history sanitization and error detection.
 * History reasoning is stripped proactively before every Groq step (rolling chain).
 * Run: npx tsx scripts/verify-groq-reasoning-compat.mjs
 */

function assert(cond, label) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
}

const { isGroqReasoningUnsupportedError, stripReasoningFromMessages } = await import(
  '../src/mastra/processors/groq-reasoning-rolling-compat.ts'
);

const groqError =
  "groq error: 'messages.8' : for 'role:assistant' the following must be satisfied[('messages.8' : property 'reasoning_content' is unsupported)]";
assert(isGroqReasoningUnsupportedError(groqError), 'detects reasoning_content unsupported');

const legacyError = "messages[3].reasoning is not supported";
assert(isGroqReasoningUnsupportedError(legacyError), 'detects legacy reasoning unsupported');

const messages = [
  {
    id: 'm1',
    role: 'assistant',
    reasoning_content: 'chain of thought',
    content: {
      format: 2,
      parts: [
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'answer', reasoning_content: 'nested' },
      ],
      reasoning: 'old field',
      reasoning_content: 'content field',
    },
  },
];

stripReasoningFromMessages(messages);
assert(!('reasoning_content' in messages[0]), 'strips top-level reasoning_content');
assert(!('reasoning' in messages[0].content), 'strips content.reasoning');
assert(!('reasoning_content' in messages[0].content), 'strips content.reasoning_content');
assert(messages[0].content.parts.length === 1, 'drops reasoning parts');
assert(messages[0].content.parts[0].type === 'text', 'keeps text parts');
assert(!('reasoning_content' in messages[0].content.parts[0]), 'strips part reasoning_content');

console.log('verify-groq-reasoning-compat: OK');
