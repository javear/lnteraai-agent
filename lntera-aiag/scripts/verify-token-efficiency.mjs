/**
 * Verifies token-efficiency helpers (memory config + Discord ambient recall filter).
 * Run: npx tsx scripts/verify-token-efficiency.mjs
 */

function assert(cond, label) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
}

const { getAgentLastMessages, getAgentInputTokenLimit, getDiscordAmbientRecallLimit } =
  await import('../src/mastra/agents/agent-memory-config.ts');
const { filterDiscordMemoryMessages } = await import(
  '../src/mastra/processors/discord-memory-recall.ts'
);

assert(getAgentLastMessages() === 8, 'default lastMessages is 8');
assert(getAgentInputTokenLimit() === 7000, 'default input token limit is 7000');
assert(getDiscordAmbientRecallLimit() === 2, 'default ambient recall limit is 2');

function msg(id, role, discord) {
  return {
    id,
    role,
    createdAt: new Date(),
    threadId: 't1',
    resourceId: 'r1',
    content: {
      format: 2,
      parts: [{ type: 'text', text: id }],
      metadata: { channel: 'discord', discord },
    },
  };
}

const thread = [
  msg('a1', 'user', { isMention: false, isDM: false }),
  msg('a2', 'user', { isMention: false, isDM: false }),
  msg('a3', 'user', { isMention: false, isDM: false }),
  msg('m1', 'user', { isMention: true, isDM: false }),
  msg('bot1', 'assistant', {}),
  msg('a4', 'user', { isMention: false, isDM: false }),
];

const filtered = filterDiscordMemoryMessages(thread, 2);
const ids = filtered.map((m) => m.id);
assert(ids.includes('m1'), 'keeps mention user');
assert(ids.includes('bot1'), 'keeps assistant');
assert(ids.includes('a3'), 'keeps recent ambient');
assert(ids.includes('a4'), 'keeps recent ambient');
assert(!ids.includes('a1'), 'drops old ambient');
assert(!ids.includes('a2'), 'drops old ambient');

const ambient = filtered.find((m) => m.id === 'a4');
const text = ambient?.content?.parts?.[0]?.text ?? '';
assert(text.startsWith('[Recent channel activity'), 'prefixes ambient text');

console.log('verify-token-efficiency: OK');
