import type { DiscordBotsHandle } from './bot';
import { startDiscordBots } from './bot';

const GLOBAL_KEY = '__lnteraDiscordEmbeddedHandle';
const LISTENERS_KEY = '__lnteraDiscordEmbeddedListeners';

function isEmbeddedEnabled(): boolean {
  const v = process.env.DISCORD_EMBEDDED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Start Discord bots inside the same Node process as Mastra (e.g. `npm run dev`).
 * Opt-in via `DISCORD_EMBEDDED=1` so `mastra build` / CI do not open Gateway connections.
 */
export async function startEmbeddedDiscordBots(): Promise<void> {
  if (!isEmbeddedEnabled()) return;

  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return;

  try {
    g[GLOBAL_KEY] = await startDiscordBots();
  } catch (err) {
    console.warn('[discord] Embedded start failed (Mastra still runs):', err);
  }

  if (g[LISTENERS_KEY]) return;
  g[LISTENERS_KEY] = true;

  const shutdown = async () => {
    const handle = g[GLOBAL_KEY] as DiscordBotsHandle | undefined;
    if (!handle) return;
    try {
      await handle.shutdown();
    } catch {
      /* ignore */
    }
    delete g[GLOBAL_KEY];
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
