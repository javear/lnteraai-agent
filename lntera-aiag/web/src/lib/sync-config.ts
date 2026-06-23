// Client for the bidirectional-sync config endpoints (/svc/v1/sync/*). The computePushed* helpers
// MIRROR the server's store-transforms.ts so the per-store editor preview matches what will be pushed.
type Api = (path: string, init?: RequestInit) => Promise<Response>;

export interface AutopilotPrefs {
  autopilotStock: boolean;
  autopilotPrice: boolean;
  propagateMode: 'notify' | 'autopilot';
}

export interface RecognitionPrefs {
  autoCreateNew: boolean;
  autoMapHighConfidence: boolean;
  highThreshold: number;
  mediumThreshold: number;
}

export interface StoreSyncRow {
  connectionId: string;
  platform: string;
  shopName: string | null;
  region: string | null;
  priceFeeFlat: number;
  priceFeeUpPct: number;
  priceFeeOtherPct: number;
  feeCurrency: string | null;
  stockCapPct: number;
}

async function getJson<T>(api: Api, path: string): Promise<T> {
  const res = await api(path);
  if (!res.ok) throw new Error(`Failed to load (${res.status}).`);
  return (await res.json()) as T;
}

async function putJson<T>(api: Api, path: string, body: unknown): Promise<T> {
  const res = await api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string }; message?: string };
  if (!res.ok) throw new Error((data as { error?: { message?: string } }).error?.message || (data as { message?: string }).message || `Failed (${res.status}).`);
  return data as T;
}

export const getAutopilot = (api: Api) => getJson<AutopilotPrefs>(api, '/svc/v1/sync/autopilot');
export const putAutopilot = (api: Api, patch: Partial<AutopilotPrefs>) => putJson<AutopilotPrefs>(api, '/svc/v1/sync/autopilot', patch);

export const getRecognitionPrefs = (api: Api) => getJson<RecognitionPrefs>(api, '/svc/v1/sync/prefs');
export const putRecognitionPrefs = (api: Api, patch: Partial<RecognitionPrefs>) =>
  putJson<RecognitionPrefs>(api, '/svc/v1/sync/prefs', patch);

export const getStores = (api: Api) => getJson<{ stores: StoreSyncRow[] }>(api, '/svc/v1/sync/stores').then((d) => d.stores);
export const putStore = (api: Api, connectionId: string, patch: Partial<Omit<StoreSyncRow, 'connectionId' | 'platform' | 'shopName' | 'region'>>) =>
  putJson<StoreSyncRow>(api, `/svc/v1/sync/stores/${encodeURIComponent(connectionId)}`, patch);

// ── Preview math (mirror server store-transforms.ts) ──────────────────────────
const ZERO_DECIMAL = new Set(['IDR', 'VND', 'JPY', 'KRW', 'CLP', 'TWD', 'HUF']);

export function roundForCurrency(value: number, currency?: string | null): number {
  return ZERO_DECIMAL.has((currency ?? '').toUpperCase()) ? Math.round(value) : Math.round(value * 100) / 100;
}

/** pushed = base × (1 + up%/100 + other%/100) + flat. */
export function computePushedPrice(
  base: number,
  cfg: { priceFeeFlat: number; priceFeeUpPct: number; priceFeeOtherPct: number },
  currency?: string | null,
): number {
  if (!Number.isFinite(base) || base <= 0) return 0;
  const value = base * (1 + (cfg.priceFeeUpPct || 0) / 100 + (cfg.priceFeeOtherPct || 0) / 100) + (cfg.priceFeeFlat || 0);
  return roundForCurrency(value, currency);
}

/** pushed = floor(internalQty × cap%/100); internal>0 but rounds to 0 → 1; internal=0 → 0. */
export function computePushedStock(internalQty: number, stockCapPct: number): number {
  if (!Number.isFinite(internalQty) || internalQty <= 0) return 0;
  const capped = Math.floor((internalQty * (stockCapPct ?? 100)) / 100);
  return capped < 1 ? 1 : capped;
}
