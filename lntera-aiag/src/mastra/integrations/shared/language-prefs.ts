// Per-tenant language preference (tenant_master.language). Drives the agent's reply language, the app's
// UI labels, and the language of server-initiated messages. Supported languages are validated here (the
// app's locale registry mirrors this) — adding a language is just extending SUPPORTED_LANGUAGES + the
// frontend locale, never a schema change.
import { getSupabase } from './supabase';

export const SUPPORTED_LANGUAGES = {
  en: 'English',
  id: 'Bahasa Indonesia',
} as const;

export type LanguageCode = keyof typeof SUPPORTED_LANGUAGES;
export const DEFAULT_LANGUAGE: LanguageCode = 'en';

/** Coerce arbitrary input to a supported language code, or null if unrecognized. */
export function normalizeLanguage(input: unknown): LanguageCode | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s in SUPPORTED_LANGUAGES) return s as LanguageCode;
  // Lenient natural-language mapping (the AI tool / users may say "indonesian", "bahasa", "english").
  if (/^(id|ind|indo|indonesia|indonesian|bahasa|bahasa indonesia)$/.test(s)) return 'id';
  if (/^(en|eng|english|inggris|bahasa inggris)$/.test(s)) return 'en';
  return null;
}

/** Human label for a language code (for confirmations). */
export function languageLabel(code: LanguageCode): string {
  return SUPPORTED_LANGUAGES[code];
}

export async function getTenantLanguage(tenantId: string): Promise<LanguageCode> {
  try {
    const { data } = await getSupabase().from('tenant_master').select('language').eq('id', tenantId).maybeSingle();
    return normalizeLanguage((data as { language?: string } | null)?.language) ?? DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export async function setTenantLanguage(tenantId: string, language: LanguageCode): Promise<LanguageCode> {
  const { error } = await getSupabase().from('tenant_master').update({ language }).eq('id', tenantId);
  if (error) throw new Error(`Failed to set language: ${error.message}`);
  return language;
}
