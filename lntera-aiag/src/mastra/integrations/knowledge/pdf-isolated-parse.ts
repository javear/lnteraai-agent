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
// document instead of a container crash. The ceiling itself is derived from the container's real
// cgroup memory limit (see readContainerMemLimitKb) rather than a fixed guess — the child shares the
// SAME container memory budget as the main app process, so a limit picked in isolation can still lose
// the race to the OS's own OOM-killer, which looks identical to our own kill from the outside (a bare
// SIGKILL, no stderr) but happens before our poll interval gets a chance to catch it first.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Referenced but never called — required so Mastra's build-time dependency analyzer (which only
// registers a package as a real production dependency if it sees a non-tree-shaken usage) ships
// `unpdf` into the deployed node_modules. It does NOT trace import.meta.resolve('unpdf') below (a
// plain method call, not module-loading syntax), and a bare `import 'unpdf'` with no referenced
// binding gets tree-shaken away too since unpdf declares "sideEffects": false in its package.json —
// verified empirically: only a referenced named import survives and makes `unpdf` show up in the
// built package.json's dependencies. Without this, import.meta.resolve('unpdf') throws in production.
import { getDocumentProxy as _unpdfDepRef } from 'unpdf';
void _unpdfDepRef;

/** Reads the container's actual cgroup memory limit (v2, then v1) in KB. A fixed guess for MAX_RSS_KB
 *  is unsafe because the child shares the SAME container memory budget as the main app process — a
 *  ceiling that looks safe for the child alone can still leave the OS's own OOM-killer (not our RSS
 *  watch) to SIGKILL it first if the container's real total limit is tighter than assumed. Returns
 *  null on non-Linux/no-cgroup (local dev) or an unbounded cgroup (huge sentinel value = "no limit"). */
function readContainerMemLimitKb(): number | null {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (raw === 'max') continue;
      const bytes = Number(raw);
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 1024 ** 4) return Math.floor(bytes / 1024);
    } catch {
      // try the next cgroup version's path
    }
  }
  return null;
}

/** Computes the child's memory ceiling FRESH on every call (not a load-time constant) from the main
 *  process's ACTUAL current RSS — a static fraction of the container total (the previous approach)
 *  was too conservative whenever the main app was using much less than its "assumed" share, and too
 *  generous whenever it was using more; reading live usage adapts either way. Reserves headroom for
 *  the main process to keep growing while this parse runs (it's still serving other requests
 *  concurrently) and for the overshoot our poll interval can miss between checks. */
function computeMaxRssKb(): number {
  const override = Number(process.env.PDF_PARSE_MAX_RSS_KB);
  if (override > 0) return override;
  const containerLimitKb = readContainerMemLimitKb();
  if (!containerLimitKb) return 400_000; // local dev / no cgroup limit readable
  const mainRssKb = readRssKb(process.pid) ?? Math.floor(containerLimitKb * 0.3);
  const reserveKb = Math.max(150_000, Math.floor(containerLimitKb * 0.15));
  const availableKb = containerLimitKb - mainRssKb - reserveKb;
  return Math.max(250_000, availableKb);
}
const PARSE_TIMEOUT_MS = 90_000;
const RSS_POLL_INTERVAL_MS = 200;
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
  const maxRssKb = computeMaxRssKb();

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
          if (killedForMemory) return reject(new Error(`PDF parsing exceeded ${Math.round(maxRssKb / 1000)}MB resident memory and was stopped.`));
          if (err.killed || err.signal === 'SIGTERM') return reject(new Error(`PDF parsing timed out after ${PARSE_TIMEOUT_MS}ms.`));
          const tooManyPages = /PDF_TOO_MANY_PAGES:(\d+)/.exec(stderr ?? '');
          if (tooManyPages) return reject(new Error(`This PDF has ${tooManyPages[1]} pages, over the ${MAX_PDF_PAGES}-page limit — split it into smaller files.`));
          // A bare SIGKILL with no stderr and no other explanation is the exact signature of the
          // container's OWN OOM-killer stepping in ahead of our RSS poll (confirmed empirically: an
          // externally-sent SIGKILL always produces `killed: false`, since Node/Bun only sets `killed`
          // when IT called .kill() — an OS-level kill looks identical to this from here) rather than an
          // actual parsing/logic error, which would instead throw a normal JS exception with a message.
          if (!stderr && err.signal === 'SIGKILL') {
            return reject(new Error('PDF parsing used too much memory and was stopped by the system before we could catch it — try a smaller or simpler file.'));
          }
          return reject(new Error(`PDF parsing failed: ${(stderr || err.message).slice(0, 500)}`));
        },
      );

      const rssWatch = setInterval(() => {
        if (!child.pid) return;
        const rssKb = readRssKb(child.pid);
        if (rssKb !== null && rssKb > maxRssKb) {
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
