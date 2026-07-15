// Extracts a PDF's text in a Web Worker on the user's own device, BEFORE upload — so the server never
// has to run the memory-hungry part of PDF parsing at all. Every attempt to contain that cost purely
// on the server side (isolated child process, cgroup-aware memory ceiling, sequential page
// processing — see pdf-isolated-parse.ts) still shares the same constrained container budget as the
// rest of the app; the user's own device has far more headroom and is exactly where a browser's own
// PDF.js is designed to run in the first place.
import type { PdfExtractRequest, PdfExtractResponse } from './pdf-extract-worker';

// Mirrors the server's own MAX_PDF_PAGES (pdf-isolated-parse.ts) — same friendly cap either way.
const MAX_PDF_PAGES = 300;
const EXTRACT_TIMEOUT_MS = 60_000;

// A real production failure showed up as a completely blank reason ("...falling back to server
// parsing: ") — traced to a caught value that WAS `instanceof Error` but had an empty `.message`
// (e.g. some DOMExceptions, like a File read failing after its underlying handle became invalid).
// Every rejection from this function must carry SOMETHING readable, or the diagnostics added
// specifically to unblock this investigation are worthless the next time it happens.
function nonEmptyMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  const asString = String(err);
  if (asString && asString !== '[object Object]') return asString;
  return fallback;
}

/** Resolves with the extracted plain text, or rejects with a user-facing error message. Callers
 *  should treat a rejection as "couldn't extract client-side" and decide whether to fall back to
 *  letting the server attempt its own (slower, resource-limited) parse. */
export function extractPdfTextInBrowser(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-extract-worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Reading this PDF took too long.'));
    }, EXTRACT_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent<PdfExtractResponse>) => {
      clearTimeout(timer);
      worker.terminate();
      if (e.data.ok) resolve(e.data.text);
      else reject(new Error(e.data.error || 'Worker reported failure with no error detail.'));
    };
    worker.onerror = (e: ErrorEvent) => {
      clearTimeout(timer);
      worker.terminate();
      const detail = e.message ? `${e.message} (${e.filename}:${e.lineno})` : 'Could not read this PDF (worker crashed with no error detail).';
      reject(new Error(detail));
    };

    file
      .arrayBuffer()
      .then((buffer) => {
        const request: PdfExtractRequest = { buffer, maxPages: MAX_PDF_PAGES };
        worker.postMessage(request, [buffer]);
      })
      .catch((err) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(nonEmptyMessage(err, 'Could not read this file from disk.')));
      });
  });
}
