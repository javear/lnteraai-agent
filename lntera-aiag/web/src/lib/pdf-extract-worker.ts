// Runs in a dedicated Web Worker (spawned by pdf-extract.ts), never on the main thread — parsing a
// large/complex PDF is CPU-heavy synchronous work that would otherwise freeze the UI, and a worker
// isolates any crash to itself rather than the whole tab. This is the SAME reason the server runs its
// own PDF parsing in a disposable child process (see pdf-isolated-parse.ts) — the browser's own
// process/thread model gives us that isolation for free here, plus it runs on the user's own device,
// which has far more headroom than the shared server container.
//
// Walks pages sequentially with page.cleanup() after each one (not unpdf's own extractText(), which
// processes every page concurrently via Promise.all and never releases anything — see the matching
// comment in pdf-isolated-parse.ts for why that matters for peak memory).
//
// maxImageSize: 0 tells PDF.js to skip decoding EVERY embedded image (it checks width*height against
// this cap before touching any pixel data, and just omits the image with a warning if over) — for
// text-heavy documents mixed with large scanned/photo images, decoding those images is what actually
// drove memory into the hundreds of MB even after every other optimization (isolated process, tighter
// ceilings, sequential per-page processing). getTextContent() never needs decoded image pixels: text
// position/content comes entirely from its own operators, independent of any image draw calls.
import { getDocumentProxy } from 'unpdf';

export interface PdfExtractRequest {
  buffer: ArrayBuffer;
  maxPages: number;
}

export type PdfExtractResponse = { ok: true; text: string } | { ok: false; error: string };

self.onmessage = async (e: MessageEvent<PdfExtractRequest>) => {
  try {
    const doc = await getDocumentProxy(new Uint8Array(e.data.buffer), { maxImageSize: 0 });
    if (e.data.maxPages && doc.numPages > e.data.maxPages) {
      throw new Error(`This PDF has ${doc.numPages} pages, over the ${e.data.maxPages}-page limit — split it into smaller files.`);
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
    const response: PdfExtractResponse = { ok: true, text: parts.join('\n') };
    self.postMessage(response);
  } catch (err) {
    const response: PdfExtractResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(response);
  }
};
