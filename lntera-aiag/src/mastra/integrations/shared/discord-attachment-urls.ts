/** Append to product tools that accept `imageUrls` when Discord may supply attachments. */
export const DISCORD_IMAGE_URL_TOOL_HINT =
  'Pass Discord `[imageUrls for tools]` URLs in `imageUrls` when present (full URL including query).';

export interface DiscordAttachmentInfo {
  id: string;
  name: string;
  url: string;
  proxyUrl: string | null;
  downloadUrl: string;
  contentType: string | null;
  size: number;
}

/** Discord CDN links need signed query params (`hm`, etc.) for server-side fetch without a user session. */
export function isSignedDiscordCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('discord')) return false;
    return u.searchParams.has('hm') || u.searchParams.has('ex');
  } catch {
    return false;
  }
}

/**
 * Pick the URL our backend should GET — prefer `proxy_url` (media.discordapp.net + signature).
 */
export function resolveDiscordAttachmentDownloadUrl(info: {
  url: string;
  proxyUrl?: string | null;
}): string {
  const proxy = info.proxyUrl?.trim();
  const direct = info.url?.trim();
  if (proxy && isSignedDiscordCdnUrl(proxy)) return proxy;
  if (direct && isSignedDiscordCdnUrl(direct)) return direct;
  return proxy || direct;
}

export function isDiscordImageAttachment(a: DiscordAttachmentInfo): boolean {
  if (a.contentType?.toLowerCase().startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name);
}

/** Mastra tool execution context (requestContext keys vary by route). */
export type ToolContextLike = {
  requestContext?: { get?: (key: string) => unknown };
};

export function getDiscordImageDownloadUrlsFromContext(context: ToolContextLike | undefined): string[] {
  const discord = context?.requestContext?.get?.('discord') as
    | { attachments?: DiscordAttachmentInfo[] }
    | undefined;
  const attachments = discord?.attachments ?? [];
  return attachments
    .filter(isDiscordImageAttachment)
    .map((a) => a.downloadUrl ?? resolveDiscordAttachmentDownloadUrl({ url: a.url, proxyUrl: a.proxyUrl }));
}

/**
 * When the agent copies a broken/truncated Discord URL into `imageUrls`, use the bot's
 * signed URLs from the current message instead.
 */
export function resolveImageUrlsForProductTool(
  agentUrls: string[] | undefined,
  context: ToolContextLike | undefined,
): string[] {
  const discordUrls = getDiscordImageDownloadUrlsFromContext(context);
  const fromAgent = (agentUrls ?? []).map((u) => u.trim()).filter(Boolean);

  if (fromAgent.length === 0) return discordUrls;
  if (discordUrls.length === 0) return fromAgent;

  const agentLooksUnsigned = fromAgent.some(
    (u) => u.includes('discord') && !isSignedDiscordCdnUrl(u),
  );
  if (agentLooksUnsigned) {
    if (fromAgent.length === 1 && discordUrls.length >= 1) {
      return [discordUrls[0]];
    }
    return discordUrls.slice(0, fromAgent.length);
  }

  return fromAgent;
}
