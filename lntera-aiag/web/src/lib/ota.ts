// Over-the-air web-bundle updates (native only) via @capgo/capacitor-updater, self-hosted on Supabase
// Storage. On launch we (1) call notifyAppReady() so capgo cancels its rollback timer for the running
// bundle, then (2) check our public manifest and, if a newer bundle exists, download it (showing a
// non-blocking progress toast) and stage it for the NEXT launch. Nothing here ever blocks or breaks
// boot — any failure just leaves the current bundle running. A bundle that fails to boot (never reaches
// notifyAppReady) is auto-reverted by capgo.
import { toast } from 'sonner';
import { IS_NATIVE } from './runtime';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
// Public manifest: { "version": "<sortable id>", "url": "https://…/app-bundles/<version>.zip" }
const MANIFEST_URL = SUPABASE_URL ? `${SUPABASE_URL}/storage/v1/object/public/app-bundles/latest.json` : '';
const TOAST_ID = 'ota-update';

interface OtaManifest {
  version?: string;
  url?: string;
}

type Updater = typeof import('@capgo/capacitor-updater').CapacitorUpdater;

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

async function checkForUpdate(CapacitorUpdater: Updater): Promise<void> {
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

  let bundle = already;
  if (!bundle) {
    // Non-blocking download with live progress. The app stays fully usable meanwhile.
    let progress: { remove: () => Promise<void> } | undefined;
    try {
      progress = await CapacitorUpdater.addListener('download', (info: { percent?: number }) => {
        const pct = Math.max(0, Math.min(100, Math.round(info?.percent ?? 0)));
        toast.loading('Updating app…', { id: TOAST_ID, description: `Downloading ${pct}%` });
      });
      bundle = await CapacitorUpdater.download({ url: manifest.url, version: manifest.version });
    } catch {
      toast.dismiss(TOAST_ID);
      return; // download failed → keep current bundle, retry next launch
    } finally {
      await progress?.remove().catch(() => {});
    }
  }

  // Stage for the NEXT cold start (no forced mid-session reload). capgo activates it then; if it fails to
  // call notifyAppReady() on that boot, capgo reverts to the current (known-good) bundle.
  await CapacitorUpdater.next({ id: bundle.id });

  // Let the user apply it now if they want — otherwise it takes effect the next time they open the app.
  toast.success('Update ready', {
    id: TOAST_ID,
    description: 'Restart to use the latest version.',
    duration: 10000,
    action: {
      label: 'Restart now',
      onClick: () => {
        void (async () => {
          try {
            await CapacitorUpdater.set({ id: bundle.id });
            await CapacitorUpdater.reload();
          } catch {
            /* if applying now fails, it still applies on the next natural launch */
          }
        })();
      },
    },
  });
}
