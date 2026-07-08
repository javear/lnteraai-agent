// One-off validation of the tenant-knowledge/GraphRAG pipeline against REAL infra:
//   - FalkorDB Cloud (connection, vector index creation, vecf32 insert, KNN search, graph traversal)
//   - Portkey embeddings (already-proven infra, exercised via the same code path this feature uses)
//   - Real LLM-based entity/relationship extraction using MASTRA_DEV_TENANT_ID's connected provider
//
// Writes ONLY to a disposable FalkorDB graph (deleted at the end) — never touches Postgres/Storage/
// Inngest, so this is safe to run repeatedly with no production side effects.
//   npx tsx scripts/verify-knowledge-pipeline.ts
import { loadLocalEnv } from './mock/mock-env';
loadLocalEnv();

const DEV_TENANT_ID = process.env.MASTRA_DEV_TENANT_ID?.trim();
const TEST_TENANT_ID = '00000000-0000-4000-8000-000000000001'; // disposable FalkorDB graph only

function ok(label: string, pass: boolean, detail?: string) {
  console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

async function main() {
  console.log('FALKORDB_URL      :', process.env.FALKORDB_URL ? 'set' : '(NOT SET)');
  console.log('FALKORDB_USERNAME :', process.env.FALKORDB_USERNAME ? 'set' : '(not set — using default ACL user)');
  console.log('FALKORDB_PASSWORD :', process.env.FALKORDB_PASSWORD ? 'set' : '(not set — ok if embedded in URL)');
  console.log('FALKORDB_TLS      :', process.env.FALKORDB_TLS?.trim().toLowerCase() === 'false' ? 'false' : 'true (default)');
  console.log('MASTRA_DEV_TENANT_ID:', DEV_TENANT_ID ?? '(NOT SET)');
  console.log('');

  let allPass = true;

  // 1. Chunking — pure function, no external deps.
  const { chunkText } = await import('../src/mastra/integrations/knowledge/chunk');
  const sampleText =
    'Acme Corp offers free returns within 30 days for unopened items.\n\n' +
    'Jane Doe is the head of customer support at Acme Corp and approves all refund exceptions.';
  const chunks = chunkText(sampleText);
  allPass = ok('chunkText produced >=1 chunk', chunks.length >= 1, `${chunks.length} chunk(s)`) && allPass;

  // 2. Embeddings — real Portkey call, same path as ingestion/search.
  const { embedTexts, EMBEDDING_DIM } = await import('../src/mastra/integrations/embeddings/qwen-embeddings');
  let embeddings: number[][] = [];
  try {
    embeddings = await embedTexts(chunks);
    allPass = ok('embedTexts returns correct dimension', embeddings.every((v) => v.length === EMBEDDING_DIM), `dim=${embeddings[0]?.length}`) && allPass;
  } catch (err) {
    allPass = ok('embedTexts call succeeded', false, err instanceof Error ? err.message : String(err));
  }

  // 3. FalkorDB connectivity + vector index + insert — the genuinely new, never-executed surface.
  const { getTenantGraph, deleteTenantGraph } = await import('../src/mastra/integrations/knowledge/falkordb-client');
  try {
    const graph = await getTenantGraph(TEST_TENANT_ID);
    await graph.query('RETURN 1');
    ok('FalkorDB connection + basic query', true);
  } catch (err) {
    allPass = ok('FalkorDB connection + basic query', false, err instanceof Error ? err.message : String(err));
    console.error('\nCannot continue without a working FalkorDB connection.');
    process.exit(1);
  }

  // 4. Entity/relationship extraction — real LLM call via the dev tenant's connected provider.
  let extracted: Awaited<ReturnType<typeof import('../src/mastra/integrations/knowledge/extract-entities').extractEntitiesAndRelationships>> = { entities: [], relationships: [] };
  if (DEV_TENANT_ID) {
    const { extractEntitiesAndRelationships } = await import('../src/mastra/integrations/knowledge/extract-entities');
    try {
      extracted = await extractEntitiesAndRelationships(DEV_TENANT_ID, chunks[0]);
      allPass = ok('extractEntitiesAndRelationships (real LLM call)', extracted.entities.length > 0, `${extracted.entities.length} entities, ${extracted.relationships.length} relationships`) && allPass;
      console.log('   entities:', extracted.entities.map((e) => `${e.name} (${e.type})`).join(', '));
    } catch (err) {
      allPass = ok('extractEntitiesAndRelationships (real LLM call)', false, err instanceof Error ? err.message : String(err));
    }
  } else {
    ok('extractEntitiesAndRelationships', false, 'skipped — MASTRA_DEV_TENANT_ID not set');
  }

  // 5. Full graph write + vector search + 1-hop enrichment, on the disposable test graph.
  try {
    const { ingestChunks } = await import('../src/mastra/integrations/knowledge/graph-write');
    const { searchTenantKnowledge } = await import('../src/mastra/integrations/knowledge/graph-read');
    const { randomUUID } = await import('node:crypto');

    if (embeddings.length > 0) {
      // A second, semantically UNRELATED chunk — needed to actually verify sort direction. With only
      // one chunk in the graph, any ORDER BY (ASC or DESC) trivially "works" since there's nothing to
      // rank against.
      const unrelatedText = 'The weather forecast for tomorrow shows heavy rain and strong coastal winds.';
      const [unrelatedEmbedding] = await embedTexts([unrelatedText]);

      await ingestChunks(TEST_TENANT_ID, [
        {
          id: randomUUID(),
          text: chunks[0],
          embedding: embeddings[0],
          documentId: 'verify-script',
          sourceType: 'document',
          chunkIndex: 0,
          extracted,
        },
        {
          id: randomUUID(),
          text: unrelatedText,
          embedding: unrelatedEmbedding,
          documentId: 'verify-script-unrelated',
          sourceType: 'document',
          chunkIndex: 0,
          extracted: { entities: [], relationships: [] },
        },
      ]);
      ok('ingestChunks (vector index + node/edge writes)', true);

      // Query with chunk[0]'s OWN embedding — it must rank first (score toward its "best" end) with
      // the unrelated chunk ranked second, or the sort direction (ORDER BY score DESC) is wrong.
      const result = await searchTenantKnowledge(TEST_TENANT_ID, embeddings[0], 3);
      allPass = ok('searchTenantKnowledge returns the ingested chunk', result.chunks.length > 0, `${result.chunks.length} chunk(s)`) && allPass;
      console.log('   ranked results:', result.chunks.map((c) => `[score=${c.score.toFixed(4)}] "${c.text.slice(0, 40)}..."`).join('  |  '));
      const selfMatchRankedFirst = result.chunks[0]?.documentId === 'verify-script';
      allPass = ok('self-match chunk ranks ABOVE the unrelated chunk', selfMatchRankedFirst, selfMatchRankedFirst ? 'sort direction is correct' : 'sort direction is WRONG — check ASC/DESC in graph-read.ts, and whether score is a distance or a similarity') && allPass;
      if (extracted.entities.length > 0) {
        allPass = ok('1-hop entity enrichment returns related entities', result.relatedEntities.length > 0, `${result.relatedEntities.length} entities`) && allPass;
      }
    } else {
      ok('ingestChunks / searchTenantKnowledge', false, 'skipped — no embeddings from step 2');
    }
  } catch (err) {
    allPass = ok('graph write/search round trip', false, err instanceof Error ? err.message : String(err));
  }

  // Cleanup — always attempt, even if earlier steps failed.
  try {
    await deleteTenantGraph(TEST_TENANT_ID);
    ok('cleanup: deleteTenantGraph', true);
  } catch (err) {
    ok('cleanup: deleteTenantGraph', false, err instanceof Error ? err.message : String(err));
  }

  console.log('\n' + (allPass ? '✅ All checks passed.' : '❌ Some checks failed — see above.'));
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
