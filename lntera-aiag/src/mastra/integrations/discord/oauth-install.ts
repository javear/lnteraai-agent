/**
 * Discord OAuth2 bot install: authorize URL + code exchange + default channel resolution (Bot REST).
 */

const DISCORD_API = 'https://discord.com/api/v10';

export type DiscordOauthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Bitfield string, see Discord Developer Portal → Bot → Permissions. */
  permissions: string;
};

export function getDiscordOauthConfig(): DiscordOauthConfig {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  const redirectUri = process.env.DISCORD_REDIRECT_URI?.trim();
  /** View Channel + Send Messages + Read Message History (override via DISCORD_BOT_PERMISSIONS). */
  const permissions = process.env.DISCORD_BOT_PERMISSIONS?.trim() ?? '68608';
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Discord OAuth requires DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI.',
    );
  }
  return { clientId, clientSecret, redirectUri, permissions };
}

/**
 * Full URL to send the user to Discord’s OAuth2 authorize screen (bot install).
 */
export function buildDiscordInstallUrl(state: string): string {
  const cfg = getDiscordOauthConfig();
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'bot');
  url.searchParams.set('permissions', cfg.permissions);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Exchange authorization code for tokens (validates the install server-side).
 */
export async function exchangeDiscordOAuthCode(code: string): Promise<void> {
  const cfg = getDiscordOauthConfig();
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });

  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord token exchange failed (${res.status}): ${text.slice(0, 500)}`);
  }
}

function getBotToken(): string {
  const t = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!t) {
    throw new Error('DISCORD_BOT_TOKEN is required to resolve guild channels after install.');
  }
  return t;
}

type DiscordGuildPartial = {
  id?: string;
  system_channel_id?: string | null;
};

type DiscordChannelPartial = {
  id: string;
  type: number;
  position?: number;
};

/**
 * Prefer guild system channel; else first GUILD_TEXT channel by position.
 */
export async function resolveDefaultChannelId(guildId: string): Promise<string> {
  const token = getBotToken();
  const headers = { Authorization: `Bot ${token}` };

  const guildRes = await fetch(`${DISCORD_API}/guilds/${guildId}`, { headers });
  if (!guildRes.ok) {
    const text = await guildRes.text();
    throw new Error(
      `Discord GET guild failed (${guildRes.status}). Ensure the bot was added to this server and DISCORD_BOT_TOKEN is valid: ${text.slice(0, 300)}`,
    );
  }

  const guild = (await guildRes.json()) as DiscordGuildPartial;
  const sys = guild.system_channel_id?.trim();
  if (sys) return sys;

  const chRes = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, { headers });
  if (!chRes.ok) {
    const text = await chRes.text();
    throw new Error(`Discord GET channels failed (${chRes.status}): ${text.slice(0, 300)}`);
  }

  const channels = (await chRes.json()) as DiscordChannelPartial[];
  const textChannels = channels
    .filter((c) => c.type === 0 && c.id)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const first = textChannels[0];
  if (!first) {
    throw new Error('No text channels found in this server; set a system channel or create a text channel.');
  }
  return first.id;
}
