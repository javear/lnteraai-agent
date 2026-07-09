/** A Studio session id identifies one browser tab's bridge on the tenant channel. */
export function newStudioSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for the rare environment without randomUUID() — still cryptographically random
    // (getRandomValues has near-universal support wherever the Web Crypto API exists at all),
    // never Math.random().
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `s-${Date.now()}-${hex}`;
  }
}
