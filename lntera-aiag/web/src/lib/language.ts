// Client for the per-tenant language preference (/svc/v1/preferences/language).
import type { Lang } from '../i18n';

type Api = (path: string, init?: RequestInit) => Promise<Response>;

export async function getLanguage(api: Api): Promise<Lang> {
  const res = await api('/svc/v1/preferences/language');
  if (!res.ok) throw new Error(`Failed to load language (${res.status}).`);
  const data = (await res.json()) as { language: Lang };
  return data.language;
}

export async function putLanguage(api: Api, language: Lang): Promise<Lang> {
  const res = await api('/svc/v1/preferences/language', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
  });
  const data = (await res.json().catch(() => ({}))) as { language?: Lang; error?: string };
  if (!res.ok) throw new Error(data.error || `Failed (${res.status}).`);
  return (data.language as Lang) ?? language;
}
