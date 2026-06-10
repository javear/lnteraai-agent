// OneSignal push registration, cross-platform. We register external_id = user uuid + a
// `tenant_id` tag = tenant uuid, and target pushes server-side by that tag — so NO OneSignal
// player ids are stored in our DB. No-ops when no appId is configured (dev without OneSignal).

import type OneSignalWeb from 'react-onesignal';

let started = false;
/** The initialized web SDK instance, so `promptPush()` can drive opt-in from a user gesture. */
let webOneSignal: typeof OneSignalWeb | null = null;

function isNative(): boolean {
  return !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
}

export async function initPush(opts: {
  appId?: string | null;
  userId?: string;
  tenantId?: string;
  safariWebId?: string | null;
}): Promise<void> {
  const { appId, userId, tenantId, safariWebId } = opts;
  if (!appId || !userId || !tenantId || started) return;
  started = true;

  try {
    if (isNative()) {
      // Native (Capacitor) — the real plugin is bundled in the native build; the web build aliases
      // this specifier to a no-op stub (see vite.config), so this line is safe in both targets.
      const mod = await import('onesignal-cordova-plugin');
      const OneSignal = ((mod as { default?: unknown }).default ?? mod) as OneSignalNative;
      OneSignal.initialize(appId);
      OneSignal.login(userId);
      OneSignal.User.addTag('tenant_id', tenantId);
      void OneSignal.Notifications.requestPermission(true);
      return;
    }

    // Web / Electron — OneSignal Web SDK.
    const { default: OneSignal } = await import('react-onesignal');
    // Our SPA is served under /app (BASE_URL), and a PWA service worker already owns scope /app/.
    // Host OneSignal's worker under a dedicated /app/onesignal/ scope so the two never collide.
    const base = import.meta.env.BASE_URL || '/';
    await OneSignal.init({
      appId,
      ...(safariWebId ? { safari_web_id: safariWebId } : {}),
      serviceWorkerPath: `${base}onesignal/OneSignalSDKWorker.js`.replace(/^\//, ''),
      serviceWorkerParam: { scope: `${base}onesignal/` },
      allowLocalhostAsSecureOrigin: true,
    });
    webOneSignal = OneSignal;
    await OneSignal.login(userId);
    OneSignal.User.addTag('tenant_id', tenantId);
    // Foreground pushes are suppressed — the in-app realtime popup already covers that case.
    OneSignal.Notifications.addEventListener('foregroundWillDisplay', (event) => event.preventDefault());
  } catch (err) {
    started = false;
    console.warn('[push] OneSignal init failed', err);
  }
}

export interface PushState {
  /** SDK initialized (web). False before login / when OneSignal isn't configured / on native. */
  ready: boolean;
  /** Browser supports web push at all. */
  supported: boolean;
  /** Browser-level permission. 'denied' means the user must re-enable in browser settings. */
  permission: NotificationPermission;
  /** Subscribed to push for this app. */
  optedIn: boolean;
}

/** Snapshot of the current push state (web). */
export function getPushState(): PushState {
  const OneSignal = webOneSignal;
  if (!OneSignal) {
    return { ready: false, supported: false, permission: 'default', optedIn: false };
  }
  return {
    ready: true,
    supported: OneSignal.Notifications.isPushSupported(),
    permission: OneSignal.Notifications.permissionNative,
    optedIn: OneSignal.User.PushSubscription.optedIn ?? false,
  };
}

/** Subscribe to push: ask for permission if needed, then opt in. Returns the resulting state. */
export async function subscribePush(): Promise<PushState> {
  const OneSignal = webOneSignal;
  if (!OneSignal) return getPushState();
  try {
    if (!OneSignal.Notifications.permission) await OneSignal.Notifications.requestPermission();
    if (OneSignal.Notifications.permission) await OneSignal.User.PushSubscription.optIn();
  } catch (err) {
    console.warn('[push] subscribe failed', err);
  }
  return getPushState();
}

/** Unsubscribe from push (keeps the browser permission; just opts this app out). */
export async function unsubscribePush(): Promise<PushState> {
  const OneSignal = webOneSignal;
  if (!OneSignal) return getPushState();
  try {
    await OneSignal.User.PushSubscription.optOut();
  } catch (err) {
    console.warn('[push] unsubscribe failed', err);
  }
  return getPushState();
}

/** Subscribe to push-subscription changes (e.g. from another tab). Returns an unsubscribe fn. */
export function onPushChange(listener: () => void): () => void {
  const OneSignal = webOneSignal;
  if (!OneSignal) return () => {};
  const handler = () => listener();
  OneSignal.User.PushSubscription.addEventListener('change', handler);
  return () => OneSignal.User.PushSubscription.removeEventListener('change', handler);
}

/**
 * Ask the user to enable push (web). Driven from a user gesture. No-ops if the SDK isn't ready,
 * push isn't supported, or permission is already granted.
 */
export async function promptPush(): Promise<void> {
  const OneSignal = webOneSignal;
  if (!OneSignal) return;
  try {
    if (!OneSignal.Notifications.isPushSupported() || OneSignal.Notifications.permission) return;
    await OneSignal.Slidedown.promptPush();
  } catch (err) {
    console.warn('[push] prompt failed', err);
  }
}

/** Minimal shape of the native (cordova) OneSignal plugin we use. */
interface OneSignalNative {
  initialize: (appId: string) => void;
  login: (externalId: string) => void;
  User: { addTag: (key: string, value: string) => void };
  Notifications: { requestPermission: (fallbackToSettings: boolean) => Promise<boolean> };
}
