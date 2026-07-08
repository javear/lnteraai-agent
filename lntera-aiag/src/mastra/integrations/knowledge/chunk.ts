// Simple paragraph-aware chunking to ~CHUNK_CHARS-character pieces (roughly 500 tokens). Good enough
// for GraphRAG retrieval granularity — no sentence-boundary NLP needed for the tenant doc sizes this
// feature targets (10MB cap total, per-tenant).
const CHUNK_CHARS = 2000;
const MIN_CHUNK_CHARS = 200;

export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= CHUNK_CHARS) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // A single paragraph longer than CHUNK_CHARS is hard-split.
    if (para.length > CHUNK_CHARS) {
      for (let i = 0; i < para.length; i += CHUNK_CHARS) chunks.push(para.slice(i, i + CHUNK_CHARS));
      current = '';
    } else {
      current = para;
    }
  }
  if (current) chunks.push(current);

  // Merge a trailing sliver into the previous chunk rather than embedding/extracting from noise.
  if (chunks.length > 1 && chunks[chunks.length - 1].length < MIN_CHUNK_CHARS) {
    const last = chunks.pop() as string;
    chunks[chunks.length - 1] += `\n\n${last}`;
  }

  return chunks;
}
