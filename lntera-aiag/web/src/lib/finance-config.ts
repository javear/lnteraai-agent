// Client for the finance settings + tax profile endpoints (/svc/v1/finance/*).
type Api = (path: string, init?: RequestInit) => Promise<Response>;

export interface FinanceSettings {
  accountingEnabled: boolean;
  baseCurrency: string;
  fiscalYearStartMonth: number;
}

export interface WithholdingRule {
  type: string;
  rate?: number;
}

export interface TaxProfile {
  npwp: string | null;
  config: {
    ppnEnabled?: boolean;
    ppnRate?: number;
    withholding?: WithholdingRule[];
  };
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

export const getFinanceSettings = (api: Api) => getJson<FinanceSettings>(api, '/svc/v1/finance/settings');
export const putFinanceSettings = (api: Api, accountingEnabled: boolean) =>
  putJson<FinanceSettings & { backfill?: { posted: number } }>(api, '/svc/v1/finance/settings', { accountingEnabled });

export const getTaxProfile = (api: Api) => getJson<TaxProfile>(api, '/svc/v1/finance/tax');
export const putTaxProfile = (
  api: Api,
  patch: { npwp?: string | null; ppnEnabled?: boolean; ppnRate?: number; withholding?: WithholdingRule[] },
) => putJson<TaxProfile>(api, '/svc/v1/finance/tax', patch);
