-- Widen tenant_products.embedding to the full Qwen3-Embedding-4B dimensionality (2560).
-- pgvector's HNSW/ivfflat indexes cap the float32 `vector` type at 2000 dims, so >2000-d embeddings
-- use `halfvec` (float16) — HNSW supports it up to 4000 dims with negligible cosine-similarity loss.
-- The table is empty at this point, so this is a clean type swap (no re-embed needed).
set local search_path = public, extensions;

drop index if exists public.tenant_products_embedding_hnsw;

alter table public.tenant_products
  alter column embedding type halfvec(2560) using null::halfvec(2560);

create index if not exists tenant_products_embedding_hnsw
  on public.tenant_products using hnsw (embedding halfvec_cosine_ops)
  with (m = 16, ef_construction = 64)
  where embedding is not null;
