import { useEffect } from 'react';
import { toast } from 'sonner';
import { usePWA } from '@/lib/pwa';

/**
 * Mounted once at the app root. Registers the service worker and surfaces its lifecycle:
 * a persistent "reload" toast when a new build is precached, and a brief "ready offline" note.
 */
export function PwaUpdater() {
  const { needRefresh, offlineReady, updateServiceWorker, dismiss } = usePWA();

  useEffect(() => {
    if (!needRefresh) return;
    toast('New version available', {
      id: 'pwa-refresh',
      description: 'Reload to get the latest.',
      duration: Infinity,
      action: { label: 'Reload', onClick: () => void updateServiceWorker(true) },
      onDismiss: dismiss,
    });
  }, [needRefresh, updateServiceWorker, dismiss]);

  useEffect(() => {
    if (!offlineReady) return;
    toast.success('Ready to work offline', {
      id: 'pwa-offline-ready',
      duration: 3000,
      onAutoClose: dismiss,
      onDismiss: dismiss,
    });
  }, [offlineReady, dismiss]);

  return null;
}
