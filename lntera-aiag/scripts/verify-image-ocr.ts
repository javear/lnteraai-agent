// One-off validation of the new image-OCR knowledge path — confirms a real vision call against the
// dev tenant's connected providers actually succeeds (no Postgres/Storage/FalkorDB side effects,
// calls extractImageText directly). Delete after use, or keep as a diagnostic like verify-embedding.mjs.
//   npx tsx scripts/verify-image-ocr.ts
import { loadLocalEnv } from './mock/mock-env';
loadLocalEnv();

const DEV_TENANT_ID = process.env.MASTRA_DEV_TENANT_ID?.trim();

// A known-valid tiny 1x1 transparent PNG. There's no real text to OCR — this test validates that the
// vision API call itself succeeds (correct message shape, model accepts image content) rather than
// OCR accuracy. A real image would additionally prove transcription quality.
const TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function main() {
  if (!DEV_TENANT_ID) {
    console.error('MASTRA_DEV_TENANT_ID not set.');
    process.exit(1);
  }
  const { extractImageText } = await import('../src/mastra/integrations/knowledge/image-ocr');
  const buffer = Buffer.from(TEST_IMAGE_BASE64, 'base64');
  console.log('image buffer bytes:', buffer.length);
  try {
    const text = await extractImageText(DEV_TENANT_ID, buffer, 'image/png');
    console.log('✅ extractImageText succeeded');
    console.log('output:', text);
    process.exit(0);
  } catch (err) {
    console.error('❌ extractImageText failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
