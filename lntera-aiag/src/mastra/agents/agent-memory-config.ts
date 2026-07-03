/** Tunable memory / token limits for generalAgent (see .env.example). */

/**
 * Working-memory template: a small, BOUNDED markdown doc the agent maintains per tenant (resource
 * scope) across all their chats. Kept short on purpose — it folds into the system prompt and stays
 * prompt-cacheable, so it persists useful business facts WITHOUT bloating the ~7k input budget. The
 * agent fills/updates it via the working-memory tool as it learns durable facts (never guesses).
 */
export const WORKING_MEMORY_TEMPLATE = `# Seller Profile
- Business name:
- Marketplaces (Shopee/TikTok/…):
- Main products or categories:
- Currency / region:

# Preferences
- Language:
- How they like answers (tone, detail):

# Finance & Tax (only if mentioned)
- Accounting enabled:
- PPN/PKP status & rate:
- NPWP:
- PPh withholding used:

# Ongoing / Follow-ups
- `;

/** Working memory is ON by default; disable with AGENT_WORKING_MEMORY=0 if it ever misbehaves. */
export function workingMemoryEnabled(): boolean {
  const v = (process.env.AGENT_WORKING_MEMORY ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/** The Memory `workingMemory` config (resource-scoped per-tenant), or disabled. */
export function getWorkingMemoryConfig():
  | { enabled: true; scope: 'resource'; template: string }
  | { enabled: false } {
  return workingMemoryEnabled()
    ? { enabled: true, scope: 'resource', template: WORKING_MEMORY_TEMPLATE }
    : { enabled: false };
}

export function getAgentLastMessages(): number {
  const raw = process.env.AGENT_LAST_MESSAGES?.trim();
  if (!raw) return 8;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

export function getAgentInputTokenLimit(): number {
  const raw = process.env.AGENT_INPUT_TOKEN_LIMIT?.trim();
  if (!raw) return 7000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 7000;
}

/**
 * The technical agent (Studio) gets its OWN, much larger budget than the chat defaults above.
 * A single coding turn carries far more than a chat reply: full file contents as tool args, plus
 * verbose npm/build output as tool results. At the generalAgent's 7k/8-message defaults, a normal
 * multi-step build (write several files, npm install, build, fix, commit) blows the input budget
 * mid-turn; `trimMode: 'contiguous'` then drops the EARLIER steps of that same turn, so the model's
 * next step sees a decapitated transcript and loses track that it's mid-task — it reads as the agent
 * "randomly" stopping partway through. The model chain also already forces `largeContext: true` for
 * this agent (see technical-agent.ts), so it's already paying for a big-context model; capping input
 * at the chat default wastes that headroom instead of using it.
 */
export function getTechnicalAgentInputTokenLimit(): number {
  const raw = process.env.TECHNICAL_AGENT_INPUT_TOKEN_LIMIT?.trim();
  if (!raw) return 32_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 32_000;
}

/** More retained thread history so an iterative debugging session ("do it" / "you stopped again" /
 *  "check the terminal") doesn't lose the original task or earlier fixes after a handful of turns. */
export function getTechnicalAgentLastMessages(): number {
  const raw = process.env.TECHNICAL_AGENT_LAST_MESSAGES?.trim();
  if (!raw) return 24;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

export function getDiscordAmbientRecallLimit(): number {
  const raw = process.env.DISCORD_AMBIENT_RECALL_LIMIT?.trim();
  if (!raw) return 2;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

export function getGeneralAgentMemoryOptions(): {
  lastMessages: number;
  semanticRecall: false;
  filterIncompleteToolCalls: boolean;
  workingMemory: ReturnType<typeof getWorkingMemoryConfig>;
} {
  return {
    lastMessages: getAgentLastMessages(),
    semanticRecall: false,
    filterIncompleteToolCalls: true,
    workingMemory: getWorkingMemoryConfig(),
  };
}
