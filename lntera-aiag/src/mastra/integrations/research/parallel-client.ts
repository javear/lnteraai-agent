// Parallel.ai client — external web search + URL extraction for the Research report feature.
// Config (env): PARALLEL_API_KEY, auth via `x-api-key` header (matching the plain-env-var convention
// already used for other external services, e.g. getEdgeOneToken() in studio/config.ts).
import { logErrorBrief } from '../../logger/compact-error';

const SEARCH_URL = 'https://api.parallel.ai/v1/search';
const EXTRACT_URL = 'https://api.parallel.ai/v1beta/extract';

export interface ParallelSearchResult {
  url: string;
  title: string;
  publishDate: string | null;
  excerpts: string[];
}

export interface ParallelSearchInput {
  objective?: string;
  searchQueries: string[];
  maxResults?: number;
}

export interface ParallelExtractResult {
  url: string;
  title: string | null;
  content: string | null;
}

/** Returns null when PARALLEL_API_KEY is not configured — callers treat this as "web search unavailable". */
export function getParallelApiKey(): string | null {
  return process.env.PARALLEL_API_KEY?.trim() || null;
}

/** `POST /v1/search` — fast (<5s) web search returning ranked results with excerpts, no full page fetch. */
export async function parallelSearch(input: ParallelSearchInput): Promise<ParallelSearchResult[]> {
  const apiKey = getParallelApiKey();
  if (!apiKey) throw new Error('Parallel.ai is not configured (set PARALLEL_API_KEY).');
  if (input.searchQueries.length === 0) return [];

  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      objective: input.objective ?? null,
      search_queries: input.searchQueries,
      mode: 'advanced',
      advanced_settings: { max_results: input.maxResults ?? 10 },
    }),
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`Parallel.ai search failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    results?: Array<{ url?: string; title?: string; publish_date?: string | null; excerpts?: string[] }>;
  };
  return (body.results ?? []).map((r) => ({
    url: r.url ?? '',
    title: r.title ?? r.url ?? 'Untitled',
    publishDate: r.publish_date ?? null,
    excerpts: r.excerpts ?? [],
  }));
}

/** `POST /v1beta/extract` — full-page markdown for up to 10 URLs (JS-heavy pages + PDFs handled server-side). */
export async function parallelExtract(urls: string[]): Promise<ParallelExtractResult[]> {
  const apiKey = getParallelApiKey();
  if (!apiKey) throw new Error('Parallel.ai is not configured (set PARALLEL_API_KEY).');
  const targets = urls.slice(0, 10);
  if (targets.length === 0) return [];

  const res = await fetch(EXTRACT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ urls: targets, full_content: true }),
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`Parallel.ai extract failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    results?: Array<{ url?: string; title?: string | null; full_content?: string | null; content?: string | null }>;
  };
  return (body.results ?? []).map((r) => ({
    url: r.url ?? '',
    title: r.title ?? null,
    content: r.full_content ?? r.content ?? null,
  }));
}

/** Best-effort wrapper — logs and returns [] instead of throwing, for call sites that shouldn't fail
 *  the whole operation over a flaky external search (e.g. mid-report-generation). */
export async function parallelSearchBestEffort(input: ParallelSearchInput): Promise<ParallelSearchResult[]> {
  try {
    return await parallelSearch(input);
  } catch (err) {
    logErrorBrief('[research] parallelSearch failed', err);
    return [];
  }
}

/** Best-effort wrapper for extract — same rationale as parallelSearchBestEffort. */
export async function parallelExtractBestEffort(urls: string[]): Promise<ParallelExtractResult[]> {
  try {
    return await parallelExtract(urls);
  } catch (err) {
    logErrorBrief('[research] parallelExtract failed', err);
    return [];
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
