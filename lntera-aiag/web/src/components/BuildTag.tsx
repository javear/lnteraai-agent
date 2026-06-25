// Tiny build indicator (native only) used to VALIDATE OTA: it shows the currently-running web bundle.
// On a fresh APK this reads "built-in"; after an OTA bundle is applied it shows the published version
// (e.g. 1.0.0-20260625…). Seeing this line change is proof the over-the-air update landed. Harmless to
// keep around — it doubles as "which bundle am I running" for support.
import { useEffect, useState } from 'react';
import { IS_NATIVE } from '../lib/runtime';

export function BuildTag() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_NATIVE) return;
    let alive = true;
    void import('@capgo/capacitor-updater')
      .then(({ CapacitorUpdater }) => CapacitorUpdater.current())
      .then((r) => {
        if (alive) setLabel(r?.bundle?.version || 'built-in');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!label) return null;
  return <div className="mt-8 text-center text-[11px] text-muted-foreground/70">App build · {label}</div>;
}
