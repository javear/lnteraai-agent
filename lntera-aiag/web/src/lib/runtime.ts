import { Capacitor } from '@capacitor/core';

/** True inside a Capacitor shell (iOS/Android). Electron is treated as web (served locally). */
export const IS_NATIVE = Capacitor.isNativePlatform();

/** 'android' | 'ios' | 'web' (synchronous). Android draws under the status bar; see native-shell. */
export const NATIVE_PLATFORM = Capacitor.getPlatform();

/**
 * Base URL for the backend API.
 *  - Web (served by the Mastra server at /app): empty string → same-origin relative requests.
 *  - Native/Electron: the UI loads from capacitor://localhost / file://, so the deployed backend
 *    URL must be baked in at build time via `VITE_API_BASE_URL` (see vite.config / NATIVE.md).
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

/** Prepend the API base to a server path. Absolute URLs are returned unchanged. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path}`;
}

/**
 * Router basename, derived from the Vite `base` (one knob per build target):
 *  - Mastra monolith (`/app/`) → `/app`; Vercel/standalone (`/`) → `/`.
 * Native uses hash routing and ignores this.
 */
export const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';
