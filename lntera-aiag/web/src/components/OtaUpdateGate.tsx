// Native OTA update gate. On launch (native only) it marks the running bundle healthy (notifyAppReady →
// capgo rollback safety), then checks the public Supabase manifest. If a newer web bundle exists it shows
// a BLOCKING "Updating…" splash with a real progress bar, downloads it, then applies + reloads into it —
// so the user is always on the latest immediately. No-update launches stay instant (the splash only
// appears once an update is confirmed). Any failure (offline, bad bundle) just proceeds on the current
// bundle. No-op on web/Electron.
import { useEffect, useState } from 'react';
import { IS_NATIVE } from '../lib/runtime';
import { Logo } from '../ui';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const MANIFEST_URL = SUPABASE_URL ? `${SUPABASE_URL}/storage/v1/object/public/app-bundles/latest.json` : '';

export function OtaUpdateGate() {
  // null = not updating (render nothing). 0–100 = blocking splash with that progress.
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => {
    if (!IS_NATIVE || !MANIFEST_URL) return;
    let cancelled = false;
    let progressSub: { remove: () => Promise<void> } | undefined;

    void (async () => {
      try {
        const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
        // Confirm the running bundle booted OK (cancels capgo's auto-rollback for it).
        await CapacitorUpdater.notifyAppReady().catch(() => {});

        // Check the manifest WITHOUT blocking — the splash only shows if there's actually an update.
        const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
        if (!res.ok) return;
        const manifest = (await res.json()) as { version?: string; url?: string };
        if (!manifest.version || !manifest.url) return;

        const current = await CapacitorUpdater.current().catch(() => null);
        if (current?.bundle?.version === manifest.version) return; // already latest

        const listed = await CapacitorUpdater.list().catch(() => null);
        let bundle = listed?.bundles?.find((b) => b.version === manifest.version);
        if (cancelled) return;

        // Update confirmed → block the app with the progress splash.
        setPercent(0);

        if (!bundle) {
          progressSub = await CapacitorUpdater.addListener('download', (info: { percent?: number }) => {
            if (!cancelled) setPercent(Math.max(0, Math.min(99, Math.round(info?.percent ?? 0))));
          });
          bundle = await CapacitorUpdater.download({ url: manifest.url, version: manifest.version });
        }
        if (cancelled) return;
        setPercent(100);

        // Apply now + reload the webview into the new bundle (this tears down + reboots the app).
        await CapacitorUpdater.set({ id: bundle.id });
        await CapacitorUpdater.reload();
      } catch {
        // Offline / failed download / bad bundle → drop the splash and run the current bundle.
        if (!cancelled) setPercent(null);
      } finally {
        await progressSub?.remove().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      void progressSub?.remove().catch(() => {});
    };
  }, []);

  if (percent === null) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-[hsl(var(--background))]">
      <Logo size="lg" wordmark={false} className="opacity-90 motion-safe:animate-fade-in" />
      <div className="w-56">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-200 ease-soft"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-2.5 text-center text-[13px] text-muted-foreground">Updating… {percent}%</div>
      </div>
    </div>
  );
}
