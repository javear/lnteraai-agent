// Runs PDF text extraction (unpdf, a bundled full PDF.js engine — real document-model + per-page
// content-stream interpretation + font/glyph resolution, all in-process) in a DISPOSABLE CHILD
// PROCESS instead of the main app process. In a browser, PDF.js's own worker is isolated in its own
// thread/process specifically so a pathological PDF can't take down the host page; unpdf inlines that
// worker into whatever process calls it. Without isolation here, a complex-but-small PDF (deeply
// nested objects, huge page count, heavy embedded fonts/images) can blow well past what the input
// file's byte size would suggest, and — because it runs in the SAME process as the whole app — take
// the entire container down with it. This was the actual cause of PDF uploads reliably OOM-crashing
// Railway (images are fine — they're shipped whole to an external vision LLM, no local parsing at all).
//
// Containment: the parent polls the child's ACTUAL resident memory (/proc/<pid>/status, Linux-only —
// fine, Railway is Linux) and SIGKILLs it past a ceiling. Deliberately NOT `ulimit -v`: that bounds
// virtual address space, and V8/JSC both reserve large virtual ranges up front unrelated to actual
// usage — a low `ulimit -v` can make the child fail to even start, independent of real memory
// pressure. A wall-clock timeout is a second, independent containment layer for CPU-bound (not just
// memory-bound) runaway parsing. Either failure mode surfaces as a normal thrown error — the caller
// (parsers.ts -> ingest-document.ts) already turns that into a clean, visible `status:'failed'`
// document instead of a container crash.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_RSS_KB = Number(process.env.PDF_PARSE_MAX_RSS_KB) || 800_000; // ~800MB resident, tunable
const PARSE_TIMEOUT_MS = 90_000;
const RSS_POLL_INTERVAL_MS = 500;
/** Reject above this many pages BEFORE paying for full extraction — a fast, friendly failure for the
 *  obviously-too-large case instead of a multi-minute parse that only then hits a limit. */
export const MAX_PDF_PAGES = 300;

function buildWorkerSource(unpdfEntryUrl: string): string {
  // Plain string template, not a separate file — Mastra's build only bundles what's statically
  // reachable from the main entry graph (see template-manifest.ts for the same workaround), so a
  // sibling .mjs meant to be spawned as its own process wouldn't reliably survive the build. Importing
  // unpdf via its ABSOLUTE resolved path (not a bare "unpdf" specifier) means this generated file works
  // regardless of which directory it's written to at runtime — no node_modules-resolution dependency.
  return `import { readFileSync, writeFileSync } from 'node:fs';
import { getDocumentProxy, extractText } from ${JSON.stringify(unpdfEntryUrl)};

const [, , inPath, outPath, maxPagesRaw] = process.argv;
const maxPages = Number(maxPagesRaw) || 0;
const buf = readFileSync(inPath);
const doc = await getDocumentProxy(new Uint8Array(buf));
if (maxPages && doc.numPages > maxPages) {
  process.stderr.write('PDF_TOO_MANY_PAGES:' + doc.numPages);
  process.exit(2);
}
const { text } = await extractText(doc, { mergePages: true });
writeFileSync(outPath, text, 'utf8');
`;
}

function readRssKb(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+)\s*kB/.exec(status);
    return m ? Number(m[1]) : null;
  } catch {
    return null; // process already exited, or /proc unavailable (non-Linux dev machine) — no-op
  }
}

/** Extracts PDF text via an isolated child process. Throws a clear error on timeout, OOM-kill, a
 *  too-many-pages rejection, or any parse failure — never lets a bad PDF crash the caller's process. */
export async function extractPdfTextIsolated(buffer: Buffer): Promise<string> {
  const unpdfEntryUrl = await import.meta.resolve('unpdf');
  const dir = await mkdtemp(join(tmpdir(), 'pdf-parse-'));
  const inPath = join(dir, 'in.pdf');
  const outPath = join(dir, 'out.txt');
  const scriptPath = join(dir, 'worker.mjs');

  try {
    await writeFile(inPath, buffer);
    await writeFile(scriptPath, buildWorkerSource(unpdfEntryUrl), 'utf8');

    await new Promise<void>((resolve, reject) => {
      let killedForMemory = false;

      const child = execFile(
        process.execPath,
        [scriptPath, inPath, outPath, String(MAX_PDF_PAGES)],
        { timeout: PARSE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, _stdout, stderr) => {
          clearInterval(rssWatch);
          if (!err) return resolve();
          if (killedForMemory) return reject(new Error(`PDF parsing exceeded ${Math.round(MAX_RSS_KB / 1000)}MB resident memory and was stopped.`));
          if (err.killed || err.signal === 'SIGTERM') return reject(new Error(`PDF parsing timed out after ${PARSE_TIMEOUT_MS}ms.`));
          const tooManyPages = /PDF_TOO_MANY_PAGES:(\d+)/.exec(stderr ?? '');
          if (tooManyPages) return reject(new Error(`This PDF has ${tooManyPages[1]} pages, over the ${MAX_PDF_PAGES}-page limit — split it into smaller files.`));
          return reject(new Error(`PDF parsing failed: ${(stderr || err.message).slice(0, 500)}`));
        },
      );

      const rssWatch = setInterval(() => {
        if (!child.pid) return;
        const rssKb = readRssKb(child.pid);
        if (rssKb !== null && rssKb > MAX_RSS_KB) {
          killedForMemory = true;
          child.kill('SIGKILL');
        }
      }, RSS_POLL_INTERVAL_MS);
      child.once('exit', () => clearInterval(rssWatch));
    });

    return await readFile(outPath, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
