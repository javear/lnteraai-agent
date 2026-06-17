import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Resolve the canonical site URL once (override via Vercel env VITE_SITE_URL; placeholder fallback
// for local/preview builds). Replaces the %SITE_URL% token in index.html (canonical/OG/JSON-LD) and
// emits a matching robots.txt + sitemap.xml so the crawl URLs always agree with the meta tags.
function seoAssets(): Plugin {
  const siteUrl = (process.env.VITE_SITE_URL || 'https://lntera.vercel.app').replace(/\/$/, '');
  return {
    name: 'lntera-seo-assets',
    transformIndexHtml(html) {
      return html.replaceAll('%SITE_URL%', siteUrl);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\nDisallow: /c/\nDisallow: /integrations\n\nSitemap: ${siteUrl}/sitemap.xml\n`,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source:
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          `  <url>\n    <loc>${siteUrl}/</loc>\n    <changefreq>monthly</changefreq>\n    <priority>1.0</priority>\n  </url>\n` +
          `</urlset>\n`,
      });
    },
  };
}

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
      seoAssets(),
      // Vercel Speed Insights — ONLY on the Vercel deployment, where the /_vercel/speed-insights/*
      // endpoints are injected by the platform (the Railway monolith + native shells have no such
      // endpoint). Added as Vercel's official script rather than the @vercel/speed-insights npm
      // package because the corporate proxy blocks installing new deps; the script is the
      // dependency-free equivalent and auto-tracks SPA route changes via the History API.
      vercel &&
        ({
          name: 'lntera-speed-insights',
          transformIndexHtml(html: string) {
            return html.replace(
              '</head>',
              `    <script defer src="/_vercel/speed-insights/script.js"></script>\n  </head>`,
            );
          },
        } as Plugin),
      // Preload the primary Geist (latin, variable-weight) woff2. fontsource injects its @font-face
      // from JS, so the browser otherwise only discovers the font after parsing the main chunk →
      // boot FOUT. We resolve the hashed filename from the emitted bundle and inject a <link preload>.
      {
        name: 'lntera-font-preload',
        apply: 'build',
        enforce: 'post',
        transformIndexHtml(html, ctx) {
          const files = ctx.bundle ? Object.keys(ctx.bundle) : [];
          const woff2 = files.find((f) => /geist-latin-wght-normal[^/]*\.woff2$/i.test(f));
          if (!woff2) return html;
          const tag = `<link rel="preload" as="font" type="font/woff2" href="${base}${woff2}" crossorigin>`;
          return html.replace('</head>', `    ${tag}\n  </head>`);
        },
      } as Plugin,
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
              // Chat sessions + message pages. NetworkFirst (not SWR): when online we always show the
              // fresh list/messages — so a just-created session or turn appears immediately on reload —
              // and the cache is only an offline fallback. GET-only; mutations + the stream stay uncached.
              urlPattern: ({ url }) => url.pathname.startsWith('/svc/v1/chat/threads'),
              handler: 'NetworkFirst',
              method: 'GET',
              options: {
                cacheName: 'lntera-chat',
                networkTimeoutSeconds: 3,
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
