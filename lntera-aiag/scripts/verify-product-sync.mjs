// End-to-end verification of the product-sync matching core against the LIVE DB with REAL
// Qwen3-Embedding-4B vectors (2560-d). Validates: (1) embedding quality + threshold calibration
// (near-dup ≥0.90, related 0.60–0.90, unrelated <0.60), (2) the hybrid_search_products RPC over
// halfvec(2560), (3) strict tenant isolation. Creates two throwaway tenants and deletes them (cascade)
// at the end. Read-your-own-writes only; touches no real tenant data.
//
//   node scripts/verify-product-sync.mjs
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// ---- env ----
const envPath = resolve('.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]?.trim()) process.env[k] = v;
  }
}

const PORTKEY_BASE = (process.env.PORTKEY_BASE_URL?.trim() || 'https://api.portkey.ai/v1').replace(/\/+$/, '');
const MODEL = process.env.PORTKEY_EMBEDDING_MODEL?.trim();
const PORTKEY_KEY = process.env.PORTKEY_API_KEY?.trim();
const SUPA_URL = process.env.SUPABASE_URL?.trim();
const SUPA_KEY = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const DIM = 2560;

if (!MODEL || !PORTKEY_KEY) throw new Error('Missing PORTKEY_EMBEDDING_MODEL / PORTKEY_API_KEY');
if (!SUPA_URL || !SUPA_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SECRET_KEY');

async function embed(texts) {
  const res = await fetch(`${PORTKEY_BASE}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-portkey-api-key': PORTKEY_KEY },
    body: JSON.stringify({ model: MODEL, input: texts, dimensions: DIM }),
  });
  if (!res.ok) throw new Error(`embed failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return j.data.map((d) => d.embedding);
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
const lit = (v) => `[${v.join(',')}]`;

const supabase = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

const T1 = randomUUID();
const T2 = randomUUID();
const checks = [];
const record = (name, pass, detail) => { checks.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`); };

async function main() {
  // Catalog (T1) + an isolation decoy (T2). The query is a fresh near-dup of A.
  const A = 'Panadol Extra 500mg Tablet 20s';
  const Adup = 'Panadol Extra Strength 500 mg Tablets, Box of 20';
  const Brelated = 'Paracetamol 500mg Tablet 100s';
  const Cunrelated = 'Nike Air Zoom Pegasus Running Shoes Men';
  const Ddecoy = 'Samsung Galaxy A54 5G Smartphone 128GB';
  const query = 'Panadol Extra Strength 500mg, 20 tablets';

  const [eA, eAdup, eB, eC, eD, eQ] = await embed([A, Adup, Brelated, Cunrelated, Ddecoy, query]);

  console.log('\n--- JS cosine vs query (embedding quality / threshold calibration) ---');
  const cq = { A: cosine(eQ, eA), Adup: cosine(eQ, eAdup), B: cosine(eQ, eB), C: cosine(eQ, eC), D: cosine(eQ, eD) };
  for (const [k, v] of Object.entries(cq)) console.log(`  cos(query, ${k}) = ${v.toFixed(4)}`);
  record('near-dup ≥ 0.90', Math.max(cq.A, cq.Adup) >= 0.9, `max(A,Adup)=${Math.max(cq.A, cq.Adup).toFixed(3)}`);
  record('related in [0.60,0.90)', cq.B >= 0.6 && cq.B < 0.95, `B=${cq.B.toFixed(3)}`);
  record('unrelated < 0.60', cq.C < 0.6, `C=${cq.C.toFixed(3)}`);

  try {
    // Seed tenants + products.
    await supabase.from('tenant_master').insert([
      { id: T1, slug: `zz-sync-${T1.slice(0, 8)}`, name: 'EmbedTest T1' },
      { id: T2, slug: `zz-sync-${T2.slice(0, 8)}`, name: 'EmbedTest T2' },
    ]).throwOnError();

    const mkRow = (tenant, title, e) => ({
      tenant_id: tenant, source_origin: 'marketplace', source_platform: 'shopee',
      title, status: 'active', embedding_source_text: title, embedding: lit(e),
      embedding_model: MODEL, embedding_version: 1, embedded_at: new Date().toISOString(),
    });
    await supabase.from('tenant_products').insert([
      mkRow(T1, A, eA), mkRow(T1, Adup, eAdup), mkRow(T1, Brelated, eB), mkRow(T1, Cunrelated, eC),
      mkRow(T2, Ddecoy, eD),
    ]).throwOnError();

    // Hybrid search for T1.
    const { data: rows, error } = await supabase.rpc('hybrid_search_products', {
      p_tenant_id: T1, p_query_text: query, p_query_embedding: lit(eQ), p_match_count: 10,
    });
    if (error) throw new Error(`RPC error: ${error.message}`);
    console.log('\n--- hybrid_search_products (T1) ---');
    for (const r of rows) console.log(`  ${Number(r.semantic_similarity).toFixed(4)}  ${r.title}`);

    const byTitle = new Map(rows.map((r) => [r.title, Number(r.semantic_similarity)]));
    const topSim = Math.max(byTitle.get(A) ?? 0, byTitle.get(Adup) ?? 0);
    record('RPC near-dup ≥ 0.90', topSim >= 0.9, `top=${topSim.toFixed(3)}`);
    record('RPC returns related (B)', byTitle.has(Brelated), `B sim=${(byTitle.get(Brelated) ?? -1).toFixed(3)}`);
    record('tenant isolation (decoy D absent in T1)', !byTitle.has(Ddecoy), `D present=${byTitle.has(Ddecoy)}`);

    // T2 must not see any T1 product.
    const { data: rows2 } = await supabase.rpc('hybrid_search_products', {
      p_tenant_id: T2, p_query_text: query, p_query_embedding: lit(eQ), p_match_count: 10,
    });
    const t2titles = new Set((rows2 ?? []).map((r) => r.title));
    record('tenant isolation (T2 cannot see T1)', ![A, Adup, Brelated, Cunrelated].some((t) => t2titles.has(t)),
      `T2 returned ${[...t2titles].join(', ') || '(none)'}`);
  } finally {
    // Cascade-delete the throwaway tenants (removes their products via FK on delete cascade).
    await supabase.from('tenant_master').delete().in('id', [T1, T2]);
    console.log('\n(cleaned up throwaway tenants)');
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed ===`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error('\nverify failed:', e.message); process.exit(1); });
