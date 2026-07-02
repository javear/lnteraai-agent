/** A Studio session id identifies one browser tab's bridge on the tenant channel. */
export function newStudioSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
