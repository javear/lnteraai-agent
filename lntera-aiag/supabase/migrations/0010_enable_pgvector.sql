-- Vector search (pgvector) + trigram fuzzy matching, used by the internal tenant product
-- catalog (tenant_products.embedding) and the hybrid_search_products RPC. Additive + idempotent.

create extension if not exists vector;
create extension if not exists pg_trgm;
