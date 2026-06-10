import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Three build targets from one codebase (the `base` knob drives every path-dependent value below):
//  - default (web): served by the Mastra server at /app; output → server public dir; PWA on.
//  - `--mode vercel`: standalone host (Vercel) at the origin root; base '/', output → dist/, PWA on.
//    Set VITE_API_BASE_URL to the deployed backend (cross-origin). See VERCEL.md.
//  - `--mode native`: packaged by Capacitor/Electron; base '/', output → dist/, PWA off.
//    Set VITE_API_BASE_URL to the deployed backend (the native UI loads locally). See NATIVE.md.
export default defineConfig(({ mode }) => {
  const native = mode === 'native';
  const vercel = mode === 'vercel';
  // Root-hosted targets (Vercel, native) serve from '/'; the Mastra monolith serves under '/app/'.
  const base = native || vercel ? '/' : '/app/';

  return {
    base,
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // Keep the native-only cordova plugin out of the web bundle (it's stubbed; never executed
        // on web because initPush guards on Capacitor.isNativePlatform()).
        ...(native
          ? {}
          : {
              'onesignal-cordova-plugin': fileURLToPath(
                new URL('./src/lib/onesignal-cordova-stub.ts', import.meta.url),
              ),
            }),
      },
    },
    plugins: [
      react(),
      VitePWA({
        // Disabled in native shells (no service worker; the bundle is already local).
        disable: native,
        // 'prompt' surfaces a dismissible "reload" toast (see PwaUpdater) instead of silently
        // reloading mid-session — better UX for an app with an active chat stream.
        registerType: 'prompt',
        injectRegister: 'auto',
        includeAssets: ['icon.svg'],
        manifest: {
          name: 'Lntera',
          short_name: 'Lntera',
          description: 'Your business agent — chat and integrations.',
          scope: base,
          start_url: base,
          display: 'standalone',
          background_color: '#0a0a0a',
          theme_color: '#0a0a0a',
          icons: [
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['index.html', '**/*.{js,css,svg,woff,woff2}'],
          // The Lottie WASM (~1.7MB) is cached on first use rather than precached, to keep the
          // install lean. See the CacheFirst rule below; it stays available offline thereafter.
          // The OneSignal worker is its own service worker (scope /app/onesignal/) — never precache it.
          globIgnores: ['**/*.map', '**/*.wasm', '**/OneSignalSDKWorker.js'],
          navigateFallback: `${base}index.html`,
          navigateFallbackDenylist: [
            /^\/svc\/v1\//,
            /^\/api\//,
            /^\/oauth\//,
            /^\/auth\//,
            /^\/webhooks\//,
          ],
          runtimeCaching: [
            {
              // Last-known integration status + public config render offline.
              urlPattern: ({ url }) =>
                url.pathname === '/svc/v1/public-config' || url.pathname === '/svc/v1/me/integrations',
              handler: 'StaleWhileRevalidate',
              method: 'GET',
              options: {
                cacheName: 'lntera-api',
                expiration: { maxEntries: 16, maxAgeSeconds: 3600 },
              },
            },
            {
              // Chat sessions + message pages — secondary offline layer behind the IndexedDB cache.
              // GET-only: thread create/rename/delete (POST/PATCH/DELETE) and the agent stream stay uncached.
              urlPattern: ({ url }) => url.pathname.startsWith('/svc/v1/chat/threads'),
              handler: 'StaleWhileRevalidate',
              method: 'GET',
              options: {
                cacheName: 'lntera-chat',
                expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 },
              },
            },
            {
              // Lottie player WASM — cache once on first use, then serve offline.
              urlPattern: ({ url }) => url.pathname.endsWith('.wasm'),
              handler: 'CacheFirst',
              options: {
                cacheName: 'lntera-wasm',
                expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
          cleanupOutdatedCaches: true,
        },
        devOptions: { enabled: false },
      }),
    ],
    build: {
      outDir: native || vercel ? 'dist' : '../src/mastra/public/app',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            // Lazy, heavy, chat-route-only libraries — must never reach the initial bundle.
            if (id.includes('@lottiefiles')) return 'lottie';
            if (id.includes('@mastra') || /[\\/]zod[\\/]/.test(id)) return 'chat-mastra';
            // Markdown rendering stack (react-markdown + the unified/remark/micromark/mdast/hast/unist ecosystem).
            if (
              /[\\/](react-markdown|remark|micromark|mdast|hast|unist|vfile|property-information|character-entities|decode-named-character-reference|space-separated-tokens|comma-separated-tokens|html-url-attributes|trim-lines|devlop|unified|bail|trough|is-plain-obj|zwitch|longest-streak|ccount|markdown-table|parse-entities|stringify-entities|style-to-object|style-to-js|web-namespaces|hastscript|estree-util-is-identifier-name)[\\/]/.test(id)
            )
              return 'chat-markdown';
            // Eager runtime + shell — stable, cacheable.
            if (id.includes('@supabase')) return 'supabase';
            if (/[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[\\/]/.test(id))
              return 'react-vendor';
            if (
              id.includes('@radix-ui') ||
              id.includes('/sonner/') ||
              id.includes('lucide-react') ||
              id.includes('class-variance-authority') ||
              id.includes('/clsx/') ||
              id.includes('tailwind-merge')
            )
              return 'ui-vendor';
            // No catch-all: misc transitive deps stay with the (lazy) chunk that needs them,
            // so they never bridge the eager shell to the chat-only libraries.
            return undefined;
          },
        },
      },
    },
  };
});
