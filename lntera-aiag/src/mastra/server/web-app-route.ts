import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApiRoute } from '@mastra/core/server';
import { serveStatic } from '@hono/node-server/serve-static';

/**
 * Serve the built Vite + React SPA at `/app/*` (monolith — same origin as the API).
 *
 * The built assets live at `src/mastra/public/app` in dev, and at `.mastra/output/public/app`
 * after `mastra build`. We resolve an ABSOLUTE root by probing candidates relative to BOTH
 * this module and the process cwd, so serving works regardless of where the server is launched
 * from. `serveStatic` serves real files; client-side routes (e.g. /app/login) fall through to
 * the handler, which returns index.html so the SPA router takes over.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the built SPA without depending on cwd. `mastra dev`/`build` run the server bundle
 * from `.mastra/output` (which is also the cwd), while the built SPA lives at
 * `src/mastra/public/app` (dev) or `.mastra/output/public/app` (after `mastra build` copies
 * the public dir). We walk up from the module dir and cwd, checking known sub-paths for an
 * actual `index.html`.
 */
const REL_CANDIDATES = ['src/mastra/public/app', 'public/app', '.mastra/output/public/app'];

function findWebRoot(): string | null {
  const envDir = process.env.WEB_DIST_DIR?.trim();
  if (envDir) {
    const abs = isAbsolute(envDir) ? envDir : resolve(process.cwd(), envDir);
    if (existsSync(join(abs, 'index.html'))) return abs;
  }
  for (const start of [HERE, process.cwd()]) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      for (const rel of REL_CANDIDATES) {
        const candidate = resolve(dir, rel);
        if (existsSync(join(candidate, 'index.html'))) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function resolveWebRoot(): string {
  return findWebRoot() ?? resolve(process.cwd(), 'src/mastra/public/app');
}

type HtmlCtx = {
  html: (s: string) => Response | Promise<Response>;
  text: (s: string, status?: number) => Response | Promise<Response>;
};

/** Frontend hosted standalone (e.g. Vercel) when WEB_APP_ORIGIN is set — don't serve /app here. */
const EXTERNAL_WEB_APP = process.env.WEB_APP_ORIGIN?.trim().replace(/\/+$/, '');

/** Monolith: serve the locally-built SPA at /app/* (same origin as the API). */
function buildMonolithRoutes() {
  const WEB_ROOT = resolveWebRoot();
  const INDEX_HTML = join(WEB_ROOT, 'index.html');

  if (!existsSync(INDEX_HTML)) {
    // eslint-disable-next-line no-console
    console.warn(`[web] SPA not found at ${WEB_ROOT}. Run \`npm run build:web\`. /app will 503 until then.`);
  }

  const serveIndexHtml = async (c: HtmlCtx): Promise<Response> => {
    try {
      const html = await readFile(INDEX_HTML, 'utf-8');
      return await c.html(html);
    } catch {
      return await c.text('Web app is not built yet. Run `npm run build:web`.', 503);
    }
  };

  const spaStatic = serveStatic({
    root: WEB_ROOT,
    index: 'index.html',
    rewriteRequestPath: (p) => p.replace(/^\/app/, '') || '/',
  });

  return [
    registerApiRoute('/app', { method: 'GET', requiresAuth: false, handler: async (c) => serveIndexHtml(c) }),
    registerApiRoute('/app/*', {
      method: 'GET',
      requiresAuth: false,
      middleware: [spaStatic],
      handler: async (c) => serveIndexHtml(c),
    }),
  ];
}

/** Standalone frontend: redirect any /app/* hit on the API origin to the real app (no SPA served). */
function buildRedirectRoutes(origin: string) {
  const redirect = (c: { req: { path: string }; redirect: (u: string, s?: number) => Response }) =>
    c.redirect(`${origin}${c.req.path.replace(/^\/app/, '') || '/'}`, 308);
  return [
    registerApiRoute('/app', { method: 'GET', requiresAuth: false, handler: async (c) => redirect(c) }),
    registerApiRoute('/app/*', { method: 'GET', requiresAuth: false, handler: async (c) => redirect(c) }),
  ];
}

export const webAppRoutes = EXTERNAL_WEB_APP
  ? buildRedirectRoutes(EXTERNAL_WEB_APP)
  : buildMonolithRoutes();
