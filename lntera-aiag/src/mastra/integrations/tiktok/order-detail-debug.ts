/**
 * Set `MASTRA_DEBUG_TIKTOK_ORDERS=1` (or `true`) to log TikTok order detail/search traces to stderr.
 * Helps debug "Order not found" when tool input looks correct (cipher scope, API bodies, swallowed errors).
 */
export function tiktokOrderDetailDebugEnabled(): boolean {
  const v = process.env.MASTRA_DEBUG_TIKTOK_ORDERS?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Short fingerprint for logs — not for security, only to correlate requests without pasting full ciphers. */
export function redactShopCipher(cipher: string): string {
  const t = cipher.trim();
  if (!t) return '(empty)';
  if (t.length <= 14) return `${t.slice(0, 4)}…(${t.length})`;
  return `${t.slice(0, 8)}…${t.slice(-4)}[len=${t.length}]`;
}

export function ttOrderDetailDebug(message: string, data?: Record<string, unknown>): void {
  if (!tiktokOrderDetailDebugEnabled()) return;
  const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  console.warn(`[mastra:tiktok-order-detail] ${message}${suffix}`);
}
