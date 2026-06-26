// Lightweight, dependency-free i18n. A flat key→string dictionary per language; t(key, vars?) looks up
// the current language, falls back to English, then to the key itself — so a missing translation degrades
// gracefully. Adding a NEW language is just: add a locale file + one entry in LANGUAGES (no structural
// change anywhere else). The language preference also drives the assistant's reply language (synced to the
// server in LanguageSync) and is passed to the agent per chat turn.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en } from './locales/en';
import { id } from './locales/id';

export type Lang = 'en' | 'id';

/** The language registry — add a new language by adding one entry (label + dict). Nothing else changes. */
export const LANGUAGES: Record<Lang, { label: string; dict: Record<string, string> }> = {
  en: { label: 'English', dict: en },
  id: { label: 'Bahasa Indonesia', dict: id },
};
export const LANG_CODES = Object.keys(LANGUAGES) as Lang[];

const STORAGE_KEY = 'lntera-lang';

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && v in LANGUAGES;
}

/** Initial language: saved choice → browser locale (id*) → English. */
function detectInitial(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* ignore */
  }
  try {
    if ((navigator.language || '').toLowerCase().startsWith('id')) return 'id';
  } catch {
    /* ignore */
  }
  return 'en';
}

type Vars = Record<string, string | number>;
interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitial);

  useEffect(() => {
    try {
      document.documentElement.lang = lang;
    } catch {
      /* ignore */
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    if (!isLang(l)) return;
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Vars) => {
      let s = LANGUAGES[lang].dict[key] ?? LANGUAGES.en.dict[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      return s;
    },
    [lang],
  );

  const value = useMemo<I18nValue>(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>');
  return ctx;
}

/** Shorthand for components that only need the translate fn: `const t = useT();` */
export function useT(): (key: string, vars?: Vars) => string {
  return useI18n().t;
}
