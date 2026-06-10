const ALLOWED_PLATFORMS = new Set(['shopee', 'tiktok']);

const LOCAL_CALLBACKS: Record<string, string> = {
  shopee: 'http://localhost:4111/oauth/shopee/callback',
  tiktok: 'http://localhost:4111/oauth/tiktok/callback',
};

function json(body: Record<string, unknown>, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

Deno.serve((req) => {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed. Use GET.' }, 405);
  }

  const url = new URL(req.url);
  // Expected invoke path: /oauth-bridge/:platform/callback
  const parts = url.pathname.split('/').filter(Boolean);
  const fnIndex = parts.findIndex((segment) => segment === 'oauth-bridge');
  const platform = fnIndex >= 0 ? parts[fnIndex + 1] : undefined;
  const callbackSegment = fnIndex >= 0 ? parts[fnIndex + 2] : undefined;

  if (!platform || callbackSegment !== 'callback') {
    return json({
      error:
        'Invalid path. Expected /oauth-bridge/{platform}/callback where platform is shopee or tiktok.',
    });
  }

  if (!ALLOWED_PLATFORMS.has(platform)) {
    return json({ error: `Unsupported platform "${platform}".` }, 400);
  }

  const localBase = LOCAL_CALLBACKS[platform];
  const target = new URL(localBase);
  target.search = url.search;

  return Response.redirect(target.toString(), 302);
});
