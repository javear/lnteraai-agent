/**
 * Rejects with a clear error if `promise` doesn't settle within `ms`. Several external/LLM calls in
 * this codebase (embeddings, entity extraction, image OCR) have no timeout of their own — a stalled
 * provider hangs the request indefinitely until the hosting platform's own proxy silently kills the
 * connection, which surfaces as an opaque 502 ("Application failed to respond") with no retry and no
 * diagnostic. Throwing here instead turns that into a normal, retryable step error.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
