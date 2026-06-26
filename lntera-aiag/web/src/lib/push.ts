// OneSignal push registration, cross-platform. We register external_id = user uuid + a
// `tenant_id` tag = tenant uuid, and target pushes server-side by that tag — so NO OneSignal
// player ids are stored in our DB. No-ops when no appId is configured (dev without OneSignal).

import type OneSignalWeb from 'react-onesignal';

/** One-time SDK init (memoized); null again if it failed so a later call can retry. */
let initPromise: Promise<void> | null = null;
/** The external_id (user uuid) currently applied to the subscription — drives account-switch re-login. */
let appliedUserId: string | null = null;
/** The native (cordova) SDK instance once initialized. */
let nativeOneSignal: OneSignalNative | null = null;
/** The initialized web SDK instance, so `promptPush()` can drive opt-in from a user gesture. */
let webOneSignal: typeof OneSignalWeb | null = null;

function isNative(): boolean {
  return !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
}

/** Initialize the OneSignal SDK exactly once (idempotent across re-renders / account switches). */
function ensureInit(appId: string, safariWebId?: string | null): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (isNative()) {
      // Native (Capacitor) — the real plugin is bundled in the native build; the web build aliases
      // this specifier to a no-op stub (see vite.config), so this line is safe in both targets.
      const mod = await import('onesignal-cordova-plugin');
      const OneSignal = ((mod as { default?: unknown }).default ?? mod) as OneSignalNative;
      OneSignal.initialize(appId);
      // Tapping a push opens the APP (no web_url is set for native) — navigate in-app to the target
      // thread via the hash router (native uses HashRouter), instead of bouncing to the browser.
      OneSignal.Notifications.addEventListener('click', (event) => {
        const data = (event?.notification?.additionalData ?? {}) as { threadId?: unknown };
        const threadId = typeof data.threadId === 'string' ? data.threadId : null;
        if (threadId) window.location.hash = `#/c/${threadId}`;
      });
      void OneSignal.Notifications.requestPermission(true);
      nativeOneSignal = OneSignal;
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
    // Foreground pushes are suppressed — the in-app realtime popup already covers that case.
    OneSignal.Notifications.addEventListener('foregroundWillDisplay', (event) => event.preventDefault());
  })().catch((err) => {
    console.warn('[push] OneSignal init failed', err);
    initPromise = null; // let a later call retry
    throw err;
  });
  return initPromise;
}

/**
 * Register this device for the CURRENT user/tenant. Safe to call repeatedly: the SDK inits once, then
 * the external_id + tenant_id tag are (re)applied whenever the logged-in user changes — so logging out
 * and back in as a DIFFERENT account re-points the subscription instead of staying stuck on the first.
 */
export async function initPush(opts: {
  appId?: string | null;
  userId?: string;
  tenantId?: string;
  safariWebId?: string | null;
}): Promise<void> {
  const { appId, userId, tenantId, safariWebId } = opts;
  if (!appId || !userId || !tenantId) return;
  try {
    await ensureInit(appId, safariWebId);
    if (appliedUserId === userId) return; // identity unchanged — nothing to re-apply
    if (nativeOneSignal) {
      nativeOneSignal.login(userId);
      nativeOneSignal.User.addTag('tenant_id', tenantId);
    } else if (webOneSignal) {
      await webOneSignal.login(userId);
      webOneSignal.User.addTag('tenant_id', tenantId);
    }
    appliedUserId = userId;
  } catch {
    /* init/login failed — retried on the next call */
  }
}

/**
 * Clear the push identity on sign-out so this device STOPS receiving the previous tenant's pushes (and
 * the next login can re-point cleanly). Best-effort; no-op if the SDK never initialized.
 */
export async function logoutPush(): Promise<void> {
  try {
    if (nativeOneSignal) {
      nativeOneSignal.User.removeTag('tenant_id');
      nativeOneSignal.logout();
    } else if (webOneSignal) {
      webOneSignal.User.removeTag('tenant_id');
      await webOneSignal.logout();
    }
  } catch (err) {
    console.warn('[push] OneSignal logout failed', err);
  } finally {
    appliedUserId = null;
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
interface OneSignalNativeClickEvent {
  notification?: { additionalData?: Record<string, unknown> };
}
interface OneSignalNative {
  initialize: (appId: string) => void;
  login: (externalId: string) => void;
  logout: () => void;
  User: { addTag: (key: string, value: string) => void; removeTag: (key: string) => void };
  Notifications: {
    requestPermission: (fallbackToSettings: boolean) => Promise<boolean>;
    addEventListener: (event: 'click', listener: (event: OneSignalNativeClickEvent) => void) => void;
  };
}
