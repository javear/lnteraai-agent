// Platform-level product embeddings via the Portkey gateway → OpenRouter (Qwen3-Embedding).
// NOT per-tenant: embeddings are platform infra (short text, cheap) so they don't touch a tenant's
// BYO chat key. Used to populate tenant_products.embedding (halfvec(2560)) + the hybrid-search query.
//
// Config (env):
//   PORTKEY_API_KEY              – existing platform inference key (header x-portkey-api-key)
//   PORTKEY_EMBEDDING_MODEL      – Portkey model string (catalog form `@<provider-slug>/<model>`).
//                                  Default = the OpenRouter Qwen3-Embedding-4B. Set to match your
//                                  Portkey OpenRouter integration slug.
//   PORTKEY_EMBEDDING_VIRTUAL_KEY – optional/deprecated; only set if your Portkey route still uses a
//                                  virtual key (then we send `x-portkey-virtual-key`). Leave unset.
//   PORTKEY_EMBEDDING_DIMENSIONS – optional; override the MRL output dim (defaults to EMBEDDING_DIM).
import { getPortkeyBaseUrl, getPortkeyInferenceApiKey } from '../portkey/config';

export const EMBEDDING_MODEL = process.env.PORTKEY_EMBEDDING_MODEL?.trim() || '@lntera-open-router/qwen/qwen3-embedding-4b';
// Full Qwen3-Embedding-4B fidelity = 2560 dims. Stored as halfvec(2560) (float16) because pgvector
// HNSW/ivfflat indexes cap the float32 `vector` type at 2000 dims; halfvec supports up to 4000 with
// negligible cosine-similarity loss.
export const EMBEDDING_DIM = 2560;
/** Bump whenever the model OR the embedding-text composition changes (forces a filterable re-embed). */
export const EMBEDDING_VERSION = 1;

const MAX_BATCH = 64;
const MAX_CHARS = 2000;

function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  if (!n || !Number.isFinite(n)) return v;
  return v.map((x) => x / n);
}

/** pgvector accepts a `[a,b,c]` text literal over PostgREST. */
export function toPgVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

interface PortkeyEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

/** Embed a batch of short texts → EMBEDDING_DIM-d vectors (L2-normalized), order-preserving. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH).map((t) => (t ?? '').slice(0, MAX_CHARS) || ' ');
    out.push(...(await embedBatch(batch)));
  }
  return out;
}

export async function embedText(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  if (!v) throw new Error('Embedding returned no vector.');
  return v;
}

async function embedBatch(input: string[]): Promise<number[][]> {
  const virtualKey = process.env.PORTKEY_EMBEDDING_VIRTUAL_KEY?.trim();
  // Pin the output dimension to EMBEDDING_DIM (2560 = Qwen3-Embedding-4B native). Qwen3 is
  // Matryoshka-trained, so this also lets a different size (0.6B/8B) be coerced to the column's
  // dimension — keeping the halfvec(2560) column valid regardless of which Qwen3 size is registered.
  const dimensions = Number(process.env.PORTKEY_EMBEDDING_DIMENSIONS) || EMBEDDING_DIM;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-portkey-api-key': getPortkeyInferenceApiKey(),
  };
  if (virtualKey) headers['x-portkey-virtual-key'] = virtualKey;

  const res = await fetch(`${getPortkeyBaseUrl()}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: EMBEDDING_MODEL, input, dimensions }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Embedding request failed (${res.status}): ${text.slice(0, 400)}`);
  }
  let parsed: PortkeyEmbeddingResponse;
  try {
    parsed = JSON.parse(text) as PortkeyEmbeddingResponse;
  } catch {
    throw new Error('Embedding response was not valid JSON.');
  }
  const data = parsed.data;
  if (!Array.isArray(data) || data.length !== input.length) {
    throw new Error(`Embedding response shape unexpected (got ${data?.length ?? 0} of ${input.length}).`);
  }
  const vectors: number[][] = new Array(input.length);
  data.forEach((item, i) => {
    const idx = typeof item.index === 'number' ? item.index : i;
    const emb = item.embedding;
    if (!Array.isArray(emb)) throw new Error('Embedding item missing embedding[].');
    if (emb.length !== EMBEDDING_DIM) {
      throw new Error(
        `Embedding dimension mismatch: got ${emb.length}, expected ${EMBEDDING_DIM}. ` +
          `Set PORTKEY_EMBEDDING_MODEL to a ${EMBEDDING_DIM}-d model or PORTKEY_EMBEDDING_DIMENSIONS=${EMBEDDING_DIM}.`,
      );
    }
    vectors[idx] = l2normalize(emb.map(Number));
  });
  return vectors;
}
