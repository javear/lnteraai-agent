import { registerApiRoute } from '@mastra/core/server';
import {
  resolveSyncPrefs,
  setSyncPrefs,
  setStoreSyncConfig,
  listStoreTransforms,
  STORE_TRANSFORM_DEFAULTS,
  type PriceAdjustment,
} from '../../../integrations/shared/sync-prefs';
import { listConnectionsByTenant } from '../../../integrations/shared/supabase';
import { OPEN_API_PREFIX, OPENAPI_TAGS } from '../constants';
import { openApiJsonError, resolveTenantFromBearer, type OpenApiHandlerContext } from '../middleware/bearer-tenant';

type Ctx = OpenApiHandlerContext & { req: { param: (name: string) => string | undefined } };

const authHeaderParam = {
  name: 'Authorization',
  in: 'header' as const,
  required: true,
  schema: { type: 'string' as const, description: 'Bearer <supabase access token>' },
};

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

// ── Autopilot prefs (tenant-wide) ─────────────────────────────────────────────
const autopilotGet = registerApiRoute(`${OPEN_API_PREFIX}/sync/autopilot`, {
  method: 'GET',
  requiresAuth: false,
  openapi: { summary: 'Get sync autopilot prefs', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'OK' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const p = await resolveSyncPrefs(auth.tenantId);
    return c.json({ autopilotStock: p.autopilotStock, autopilotPrice: p.autopilotPrice, propagateMode: p.propagateMode });
  },
});

const autopilotPut = registerApiRoute(`${OPEN_API_PREFIX}/sync/autopilot`, {
  method: 'PUT',
  requiresAuth: false,
  openapi: { summary: 'Update sync autopilot prefs', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'OK' }, 400: { description: 'Bad request' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const mode = typeof body.propagateMode === 'string' ? body.propagateMode : undefined;
    if (mode !== undefined && mode !== 'notify' && mode !== 'autopilot') {
      return openApiJsonError(c, 400, 'bad_request', "propagateMode must be 'notify' or 'autopilot'.");
    }
    await setSyncPrefs(auth.tenantId, {
      ...(typeof body.autopilotStock === 'boolean' ? { autopilotStock: body.autopilotStock } : {}),
      ...(typeof body.autopilotPrice === 'boolean' ? { autopilotPrice: body.autopilotPrice } : {}),
      ...(mode ? { propagateMode: mode } : {}),
    });
    const p = await resolveSyncPrefs(auth.tenantId);
    return c.json({ autopilotStock: p.autopilotStock, autopilotPrice: p.autopilotPrice, propagateMode: p.propagateMode });
  },
});

// ── Recognition prefs (auto-create / auto-map / thresholds) ───────────────────
const prefsGet = registerApiRoute(`${OPEN_API_PREFIX}/sync/prefs`, {
  method: 'GET',
  requiresAuth: false,
  openapi: { summary: 'Get product-recognition prefs', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'OK' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const p = await resolveSyncPrefs(auth.tenantId);
    return c.json({
      autoCreateNew: p.autoCreateNew,
      autoMapHighConfidence: p.autoMapHighConfidence,
      highThreshold: p.highThreshold,
      mediumThreshold: p.mediumThreshold,
    });
  },
});

const prefsPut = registerApiRoute(`${OPEN_API_PREFIX}/sync/prefs`, {
  method: 'PUT',
  requiresAuth: false,
  openapi: { summary: 'Update product-recognition prefs', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'OK' }, 400: { description: 'Bad request' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const high = num(body.highThreshold);
    const medium = num(body.mediumThreshold);
    for (const [name, val] of [['highThreshold', high], ['mediumThreshold', medium]] as const) {
      if (val !== undefined && (val <= 0 || val > 1)) {
        return openApiJsonError(c, 400, 'bad_request', `${name} must be in (0, 1].`);
      }
    }
    if (high !== undefined && medium !== undefined && medium > high) {
      return openApiJsonError(c, 400, 'bad_request', 'mediumThreshold cannot exceed highThreshold.');
    }
    await setSyncPrefs(auth.tenantId, {
      ...(typeof body.autoCreateNew === 'boolean' ? { autoCreateNew: body.autoCreateNew } : {}),
      ...(typeof body.autoMapHighConfidence === 'boolean' ? { autoMapHighConfidence: body.autoMapHighConfidence } : {}),
      ...(high !== undefined ? { highThreshold: high } : {}),
      ...(medium !== undefined ? { mediumThreshold: medium } : {}),
    });
    const p = await resolveSyncPrefs(auth.tenantId);
    return c.json({
      autoCreateNew: p.autoCreateNew,
      autoMapHighConfidence: p.autoMapHighConfidence,
      highThreshold: p.highThreshold,
      mediumThreshold: p.mediumThreshold,
    });
  },
});

// ── Per-store transforms (price margin + stock cap) ───────────────────────────
const storesGet = registerApiRoute(`${OPEN_API_PREFIX}/sync/stores`, {
  method: 'GET',
  requiresAuth: false,
  openapi: { summary: 'List per-store sync transforms', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'OK' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const conns = await listConnectionsByTenant(auth.tenantId, ['shopee', 'tiktok']);
    const transforms = await listStoreTransforms(auth.tenantId);
    const stores = conns.map((conn) => {
      const t = transforms.get(conn.id) ?? STORE_TRANSFORM_DEFAULTS;
      return {
        connectionId: conn.id,
        platform: conn.platform,
        shopName: conn.shop_name ?? null,
        region: conn.region ?? null,
        ...t,
      };
    });
    return c.json({ stores });
  },
});

const storesPut = registerApiRoute(`${OPEN_API_PREFIX}/sync/stores/:connectionId`, {
  method: 'PUT',
  requiresAuth: false,
  openapi: { summary: 'Update a store sync transform', tags: [...OPENAPI_TAGS.root], parameters: [authHeaderParam], responses: { 200: { description: 'OK' }, 400: { description: 'Bad request' }, 404: { description: 'Store not found' } } },
  handler: async (c: Ctx) => {
    const auth = await resolveTenantFromBearer(c);
    if (auth instanceof Response) return auth;
    const connectionId = c.req.param('connectionId');
    if (!connectionId) return openApiJsonError(c, 400, 'bad_request', 'A connectionId is required.');

    const conns = await listConnectionsByTenant(auth.tenantId, ['shopee', 'tiktok']);
    if (!conns.some((conn) => conn.id === connectionId)) {
      return openApiJsonError(c, 404, 'not_found', 'No such store for this tenant.');
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const cap = num(body.stockCapPct);
    if (cap !== undefined && (cap <= 0 || cap > 100)) {
      return openApiJsonError(c, 400, 'bad_request', 'stockCapPct must be in (0, 100].');
    }

    // Dynamic price adjustments: a list of { kind: 'percent'|'fixed', value, label? }.
    let priceAdjustments: PriceAdjustment[] | undefined;
    if (body.priceAdjustments !== undefined) {
      if (!Array.isArray(body.priceAdjustments)) {
        return openApiJsonError(c, 400, 'bad_request', 'priceAdjustments must be an array.');
      }
      const cleaned: PriceAdjustment[] = [];
      for (const raw of body.priceAdjustments) {
        const o = (raw ?? {}) as Record<string, unknown>;
        const kind = o.kind === 'fixed' ? 'fixed' : o.kind === 'percent' ? 'percent' : null;
        const value = Number(o.value);
        if (!kind || !Number.isFinite(value)) {
          return openApiJsonError(c, 400, 'bad_request', 'Each adjustment needs kind ("percent"|"fixed") and a numeric value.');
        }
        if (kind === 'percent' && (value <= -100 || value > 1000)) {
          return openApiJsonError(c, 400, 'bad_request', 'A percent adjustment must be between -100 and 1000.');
        }
        cleaned.push({ kind, value, ...(typeof o.label === 'string' && o.label.trim() ? { label: o.label.trim().slice(0, 60) } : {}) });
      }
      if (cleaned.length > 20) return openApiJsonError(c, 400, 'bad_request', 'Too many adjustments (max 20).');
      priceAdjustments = cleaned;
    }

    await setStoreSyncConfig(auth.tenantId, connectionId, {
      ...(priceAdjustments !== undefined ? { priceAdjustments } : {}),
      ...(cap !== undefined ? { stockCapPct: cap } : {}),
      ...(typeof body.feeCurrency === 'string' ? { feeCurrency: body.feeCurrency.trim() || null } : {}),
    });
    const transforms = await listStoreTransforms(auth.tenantId);
    return c.json({ connectionId, ...(transforms.get(connectionId) ?? STORE_TRANSFORM_DEFAULTS) });
  },
});

export const syncConfigRoutes = [autopilotGet, autopilotPut, prefsGet, prefsPut, storesGet, storesPut];
