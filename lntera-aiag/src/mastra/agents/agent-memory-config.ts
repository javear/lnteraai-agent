/** Tunable memory / token limits for generalAgent (see .env.example). */

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
} {
  return {
    lastMessages: getAgentLastMessages(),
    semanticRecall: false,
    filterIncompleteToolCalls: true,
  };
}
