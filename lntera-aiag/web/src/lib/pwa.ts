import { useSyncExternalStore } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * Service-worker lifecycle for the offline-capable shell. `needRefresh` flips when a new
 * build is precached (we surface a "reload" toast); `offlineReady` flips once the app can
 * load without the network. Never caches tokens or POST/stream responses (see vite.config).
 */
export function usePWA() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.error('Service worker registration failed', error);
    },
  });

  const dismiss = () => {
    setOfflineReady(false);
    setNeedRefresh(false);
  };

  return { offlineReady, needRefresh, updateServiceWorker, dismiss };
}

function subscribeOnline(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/** Reactive `navigator.onLine`. SSR-safe default of `true` (we never run on the server). */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}
