// Unified telemetry facade. Web/PWA → Firebase JS SDK (firebase-web.ts); native app → the
// @capacitor-firebase plugins (real native Analytics / Crashlytics / Performance). Everything is
// best-effort and gated — no Firebase config (web) or plugins/google-services (native) ⇒ silent no-op.
import { IS_NATIVE } from './runtime';
import { initWebTelemetry, webLogEvent, webSetUser } from './firebase-web';

interface NativeAnalytics {
  setEnabled(o: { enabled: boolean }): Promise<void>;
  logEvent(o: { name: string; params?: Record<string, unknown> }): Promise<void>;
  setCurrentScreen(o: { screenName: string }): Promise<void>;
  setUserId(o: { userId: string | null }): Promise<void>;
}
interface NativeCrashlytics {
  setEnabled(o: { enabled: boolean }): Promise<void>;
  recordException(o: { message: string }): Promise<void>;
  setUserId(o: { userId: string }): Promise<void>;
}

let nativeAnalytics: NativeAnalytics | null = null;
let nativeCrashlytics: NativeCrashlytics | null = null;
let initialized = false;

/** Initialize telemetry once. Web inits Firebase; native enables the plugins (they read google-services). */
export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  initialized = true;
  if (IS_NATIVE) {
    try {
      const [{ FirebaseAnalytics }, { FirebaseCrashlytics }, { FirebasePerformance }] = await Promise.all([
        import('@capacitor-firebase/analytics'),
        import('@capacitor-firebase/crashlytics'),
        import('@capacitor-firebase/performance'),
      ]);
      nativeAnalytics = FirebaseAnalytics as unknown as NativeAnalytics;
      nativeCrashlytics = FirebaseCrashlytics as unknown as NativeCrashlytics;
      await Promise.allSettled([
        FirebaseAnalytics.setEnabled({ enabled: true }),
        FirebaseCrashlytics.setEnabled({ enabled: true }),
        FirebasePerformance.setEnabled({ enabled: true }),
      ]);
    } catch {
      /* plugins unavailable (e.g. google-services missing) — no-op */
    }
    return;
  }
  await initWebTelemetry();
}

/** A custom analytics event. */
export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (IS_NATIVE) void nativeAnalytics?.logEvent({ name, params }).catch(() => {});
  else void webLogEvent(name, params);
}

/** A screen/page view (call on route change). */
export function trackScreen(name: string): void {
  if (IS_NATIVE) void nativeAnalytics?.setCurrentScreen({ screenName: name }).catch(() => {});
  else void webLogEvent('page_view', { page_path: name });
}

/** Associate events with the signed-in user (or clear on sign-out). */
export function setTelemetryUser(id: string | null): void {
  if (IS_NATIVE) {
    void nativeAnalytics?.setUserId({ userId: id }).catch(() => {});
    if (id) void nativeCrashlytics?.setUserId({ userId: id }).catch(() => {});
  } else {
    void webSetUser(id);
  }
}

/** Record a non-fatal error: native → Crashlytics; web → an Analytics `exception` event. */
export function recordError(err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (IS_NATIVE) void nativeCrashlytics?.recordException({ message }).catch(() => {});
  else void webLogEvent('exception', { description: message.slice(0, 256), fatal: false });
}
