// Over-the-air web-bundle updates (native only) via @capgo/capacitor-updater, self-hosted on Supabase
// Storage. On launch we (1) call notifyAppReady() so capgo cancels its rollback timer for the running
// bundle, then (2) check our public manifest and, if a newer bundle exists, download it and stage it for
// the NEXT launch. Nothing here ever blocks or breaks boot — any failure just leaves the current bundle
// running. A bundle that fails to boot (never reaches notifyAppReady) is auto-reverted by capgo.
import { IS_NATIVE } from './runtime';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
// Public manifest: { "version": "<sortable id>", "url": "https://…/app-bundles/<version>.zip" }
const MANIFEST_URL = SUPABASE_URL ? `${SUPABASE_URL}/storage/v1/object/public/app-bundles/latest.json` : '';

interface OtaManifest {
  version?: string;
  url?: string;
}

export function initOta(): void {
  if (!IS_NATIVE || !MANIFEST_URL) return;
  void (async () => {
    try {
      const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
      // Confirm the currently-running bundle booted OK (otherwise capgo rolls back on next start).
      await CapacitorUpdater.notifyAppReady().catch(() => {});
      await checkForUpdate(CapacitorUpdater);
    } catch {
      /* plugin unavailable (web/Electron) or check failed — stay on the current bundle */
    }
  })();
}

async function checkForUpdate(CapacitorUpdater: typeof import('@capgo/capacitor-updater').CapacitorUpdater): Promise<void> {
  let manifest: OtaManifest;
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) return; // no bundle published yet → built-in stays
    manifest = (await res.json()) as OtaManifest;
  } catch {
    return; // offline → try again next launch
  }
  if (!manifest.version || !manifest.url) return;

  // Already running (or already staged) this version? Nothing to do.
  const current = await CapacitorUpdater.current().catch(() => null);
  if (current?.bundle?.version === manifest.version) return;

  const listed = await CapacitorUpdater.list().catch(() => null);
  const already = listed?.bundles?.find((b) => b.version === manifest.version);

  const bundle = already ?? (await CapacitorUpdater.download({ url: manifest.url, version: manifest.version }));

  // Stage for the NEXT cold start (no mid-session reload). capgo activates it then; if it fails to call
  // notifyAppReady() on that boot, capgo reverts to this (known-good) bundle.
  await CapacitorUpdater.next({ id: bundle.id });
}
