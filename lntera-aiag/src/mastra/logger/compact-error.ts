/** Minimal error shape for logs — avoids dumping stack / responseBody / nested API payloads. */
export type CompactErrorInfo = {
  type: string;
  message: string;
};

/**
 * Reduce an unknown thrown value to `{ type, message }` for logging.
 * Handles `Error`, AI SDK `APICallError`, and plain objects.
 */
export function compactError(err: unknown): CompactErrorInfo {
  if (err == null) {
    return { type: 'Unknown', message: 'null or undefined' };
  }
  if (typeof err === 'string') {
    return { type: 'Error', message: err };
  }
  if (err instanceof Error) {
    const e = err as Error & {
      type?: string;
      data?: { error?: { message?: string; type?: string } };
    };
    const nested = e.data?.error;
    return {
      type: e.type ?? nested?.type ?? e.name ?? 'Error',
      message: e.message || nested?.message || 'Unknown error',
    };
  }
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const nested =
      o.data && typeof o.data === 'object'
        ? (o.data as { error?: { message?: string; type?: string } }).error
        : undefined;
    const type =
      (typeof o.type === 'string' && o.type) ||
      (typeof nested?.type === 'string' && nested.type) ||
      (typeof o.name === 'string' && o.name) ||
      'Error';
    const message =
      (typeof o.message === 'string' && o.message) ||
      (typeof nested?.message === 'string' && nested.message) ||
      'Unknown error';
    return { type, message };
  }
  return { type: 'Error', message: String(err) };
}

function compactArgs(args: Record<string, unknown> = {}): Record<string, unknown> {
  const out = { ...args };
  if ('err' in out && out.err != null) {
    out.err = compactError(out.err);
  }
  if ('error' in out && out.error != null) {
    out.error = compactError(out.error);
  }
  return out;
}

/** `console.error(prefix, compactError(err))` — one line, no stack dump. */
export function logErrorBrief(prefix: string, err: unknown, extra?: Record<string, unknown>): void {
  const info = compactError(err);
  if (extra && Object.keys(extra).length > 0) {
    console.error(prefix, info, extra);
  } else {
    console.error(prefix, info);
  }
}

export { compactArgs };
