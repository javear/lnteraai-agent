-- Recreate hybrid_search_products with a halfvec(2560) query-embedding param to match the widened
-- tenant_products.embedding column (see 0016). Body is otherwise identical to 0015: full-text +
-- semantic legs fused with RRF for ORDERING, plus the candidate's cosine semantic_similarity (0..1)
-- which the app uses for THRESHOLDING. Always scoped to one tenant (no RLS backstop on this table).
set local search_path = public, extensions;

-- Drop the old vector(1024) overload by name (not typed signature) so it works regardless of which
-- schema the vector type lives in / the migration runner's search_path.
do $$
declare fn text;
begin
  select p.oid::regprocedure::text into fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'hybrid_search_products'
  limit 1;
  if fn is not null then
    execute 'drop function ' || fn;
  end if;
end $$;

create or replace function public.hybrid_search_products(
  p_tenant_id uuid,
  p_query_text text,
  p_query_embedding halfvec(2560),
  p_match_count int default 10,
  p_full_text_weight float default 1.0,
  p_semantic_weight float default 1.0,
  p_rrf_k int default 50,
  p_status_filter text default 'active'
)
returns table (
  product_id uuid,
  title text,
  semantic_similarity float,
  fts_rank int,
  semantic_rank int,
  rrf_score float
)
language sql
stable
set search_path = public
as $$
  with fts as (
    select tp.id,
      row_number() over (
        order by ts_rank_cd(tp.content_tsv, websearch_to_tsquery('simple', p_query_text)) desc
      ) as rank_ix
    from tenant_products tp
    where tp.tenant_id = p_tenant_id
      and (p_status_filter is null or tp.status = p_status_filter)
      and p_query_text is not null
      and tp.content_tsv @@ websearch_to_tsquery('simple', p_query_text)
    order by rank_ix
    limit least(p_match_count, 50) * 2
  ),
  semantic as (
    select tp.id,
      row_number() over (order by tp.embedding <=> p_query_embedding) as rank_ix
    from tenant_products tp
    where tp.tenant_id = p_tenant_id
      and (p_status_filter is null or tp.status = p_status_filter)
      and tp.embedding is not null
      and p_query_embedding is not null
    order by rank_ix
    limit least(p_match_count, 50) * 2
  )
  select
    tp.id as product_id,
    tp.title,
    case when tp.embedding is not null and p_query_embedding is not null
      then (1 - (tp.embedding <=> p_query_embedding))::float
      else null end as semantic_similarity,
    fts.rank_ix::int as fts_rank,
    semantic.rank_ix::int as semantic_rank,
    (
      coalesce(1.0 / (p_rrf_k + fts.rank_ix), 0.0) * p_full_text_weight
      + coalesce(1.0 / (p_rrf_k + semantic.rank_ix), 0.0) * p_semantic_weight
    )::float as rrf_score
  from fts
  full outer join semantic on fts.id = semantic.id
  join tenant_products tp on tp.id = coalesce(fts.id, semantic.id)
  order by rrf_score desc
  limit least(p_match_count, 50);
$$;

-- Lock down execution to service_role (resolve by name; see 0015).
do $$
declare fn text;
begin
  select p.oid::regprocedure::text into fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'hybrid_search_products'
  limit 1;
  if fn is not null then
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to service_role', fn);
  end if;
end $$;
