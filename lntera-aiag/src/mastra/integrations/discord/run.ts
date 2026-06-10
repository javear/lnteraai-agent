/**
 * Long-running Discord Gateway worker. Run with: npm run discord
 * Requires SUPABASE_* credentials. Prefer `DISCORD_BOT_TOKEN` (single app + tenant linkage in
 * tenant_integrations); legacy mode uses Vault `vaultSecretRef` per row when `DISCORD_BOT_TOKEN` is unset.
 */
import { logErrorBrief } from '../../logger/compact-error';
import { startDiscordBots } from './bot';

let handle: Awaited<ReturnType<typeof startDiscordBots>>;
try {
  handle = await startDiscordBots();
} catch (err) {
  logErrorBrief('[discord] Failed to start Discord bots', err);
  process.exit(1);
}

async function shutdown(signal: string) {
  console.info(`[discord] ${signal} received, shutting down…`);
  await handle.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
