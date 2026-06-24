// Publish an OTA web bundle to Supabase Storage so installed native apps pick it up on next launch.
//
// Usage (run AFTER a native build — the npm `ota:publish` script does `build:native` first):
//   SUPABASE_SERVICE_ROLE_KEY=<service key> npm run ota:publish        (in web/)
//
// It zips web/dist (index.html at the zip root), uploads it as <version>.zip to the public `app-bundles`
// bucket, and overwrites latest.json → { version, url }. The app's src/lib/ota.ts reads latest.json and
// stages a newer bundle for the next launch. Service role key is required (write); it is NEVER bundled.
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// The Supabase URL is public — fall back to web/.env.native so only the service key need be exported.
function fromEnvNative(key) {
  try {
    const m = readFileSync(resolve('.env.native'), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

const SUPABASE_URL = (
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  fromEnvNative('VITE_SUPABASE_URL') ||
  ''
).replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = 'app-bundles';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('✗ Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before publishing.');
  process.exit(1);
}

const dist = resolve('dist');
if (!existsSync(resolve(dist, 'index.html'))) {
  console.error('✗ dist/index.html not found — run `npm run build:native` first (the ota:publish script does).');
  process.exit(1);
}

// Sortable, semver-valid version: <pkg.version>-<YYYYMMDDHHmmss>.
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const version = process.env.OTA_VERSION || `${pkg.version || '1.0.0'}-${ts}`;
const objectName = `${version}.zip`;
const zipPath = resolve(`ota-${ts}.zip`); // outside dist so it doesn't include itself

console.log(`• Zipping dist → ${objectName} …`);
execSync(`cd "${dist}" && zip -r -q "${zipPath}" .`, { stdio: 'inherit' });

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

console.log('• Uploading bundle …');
const zipUp = await supabase.storage
  .from(BUCKET)
  .upload(objectName, readFileSync(zipPath), { contentType: 'application/zip', upsert: true });
rmSync(zipPath, { force: true });
if (zipUp.error) {
  console.error(`✗ Bundle upload failed: ${zipUp.error.message}`);
  process.exit(1);
}

const bundleUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectName}`;
const manifest = JSON.stringify({ version, url: bundleUrl, publishedAt: new Date().toISOString() }, null, 2);

console.log('• Updating latest.json …');
const manUp = await supabase.storage
  .from(BUCKET)
  .upload('latest.json', Buffer.from(manifest), { contentType: 'application/json', upsert: true });
if (manUp.error) {
  console.error(`✗ Manifest upload failed: ${manUp.error.message}`);
  process.exit(1);
}

console.log(`\n✓ OTA published — version ${version}`);
console.log(`  bundle:   ${bundleUrl}`);
console.log(`  manifest: ${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/latest.json`);
console.log('  Installed apps will stage it on their next launch.');
