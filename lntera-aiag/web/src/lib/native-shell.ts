import { IS_NATIVE } from './runtime';

/**
 * Native (Capacitor) shell tweaks. Currently Android-only.
 *
 * Android's WebView draws under the status bar and — unlike iOS — does NOT expose a
 * `safe-area-inset-top` for it (only display cutouts count). So headers that rely on `.safe-t`
 * (`padding-top: env(safe-area-inset-top)`) collapse to 0 and sit flush against the top edge.
 * Pushing the WebView below the status bar fixes every screen at once.
 *
 * The status bar is given the app's dark boot/login surface (the `.lp-space` scope is near-black in
 * both themes) with light icons (`Style.Dark` = light content on a dark bar). iOS is untouched — it
 * keeps the overlay + `env(safe-area-inset-top)` approach that already works there.
 *
 * Dynamic imports keep `@capacitor/status-bar` out of the web/Electron bundle. No-op off-Android.
 */
export async function initNativeShell(): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.getPlatform() !== 'android') return;
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0b0d11' });
  } catch {
    // Plugin missing (web build) or call failed — non-fatal cosmetic setup.
  }
}
