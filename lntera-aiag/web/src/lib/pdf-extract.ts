// Extracts a PDF's text on the user's own device, BEFORE upload — so the server never has to run the
// memory-hungry part of PDF parsing at all. Runs directly on the main thread, NOT in a Web Worker.
//
// A dedicated-Worker wrapper was the original design (isolate the parse, keep the main thread free),
// but unpdf's browser bundle is PDF.js's "serverless" build, meant to run inline in whatever context
// calls it. PDF.js's OWN internal worker-detection logic (see node_modules/unpdf/dist/pdfjs.mjs) checks
// `typeof window === 'undefined'` to decide whether it's already inside a worker-like context; when
// true, it tries to spin up ANOTHER real nested worker (expecting its own pdf.worker.js entry point,
// which this bundle doesn't ship) instead of using its same-thread "fake worker" fallback. Wrapping
// extraction in our own Worker made that condition true. Confirmed by direct reproduction in a real
// headless Chrome: the exact same file + options that parse in under 20ms on the main thread hang
// indefinitely inside a dedicated Worker — for every PDF tested, not just image-heavy ones. That's the
// real reason client-side extraction has been unreliable throughout this feature's life, regardless of
// a given document's content. Measured extraction time is well under 200ms locally for realistic
// documents (bounded further by the caps below), so running it on the main thread is an acceptable
// brief task, not a real UI-blocking concern.
import { getDocumentProxy } from 'unpdf';

// Mirrors the server's own MAX_PDF_PAGES (pdf-isolated-parse.ts) — same friendly cap either way.
const MAX_PDF_PAGES = 300;
const EXTRACT_TIMEOUT_MS = 60_000;

// PDF.js sometimes throws its own exception classes (InvalidPDFException, UnknownErrorException,
// PasswordException, etc.) that don't always carry a useful `.message` — a bare `err.message` can come
// back as an empty string, showing up in the console/server log as unhelpfully blank. Report name +
// message + constructor name so a truly unlabeled exception still tells us SOMETHING; also guarantees
// every rejection from this module carries non-empty text (a real past failure showed up completely
// blank because a caught DOMException was `instanceof Error` with an empty `.message`).
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== 'Error' ? err.name : (err.constructor?.name ?? 'Error');
    return err.message ? `${name}: ${err.message}` : `${name} (no message)`;
  }
  try {
    return `Non-Error thrown: ${JSON.stringify(err)}`;
  } catch {
    return `Non-Error thrown: ${String(err)}`;
  }
}

async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(buffer), { maxImageSize: 0 });
  if (doc.numPages > MAX_PDF_PAGES) {
    throw new Error(`This PDF has ${doc.numPages} pages, over the ${MAX_PDF_PAGES}-page limit — split it into smaller files.`);
  }
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .filter((item): item is typeof item & { str: string } => 'str' in item && item.str != null)
      .map((item) => item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ''))
      .join('');
    parts.push(pageText.replace(/\s+/g, ' '));
    page.cleanup();
  }
  return parts.join('\n');
}

/** Resolves with the extracted plain text, or rejects with a user-facing error message. Callers
 *  should treat a rejection as "couldn't extract client-side" and decide whether to fall back to
 *  letting the server attempt its own (slower, resource-limited) parse. */
export async function extractPdfTextInBrowser(file: File): Promise<string> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Reading this PDF took too long.')), EXTRACT_TIMEOUT_MS);
  });
  try {
    const buffer = await file.arrayBuffer();
    return await Promise.race([extractPdfText(buffer), timeout]);
  } catch (err) {
    throw new Error(describeError(err));
  }
}
