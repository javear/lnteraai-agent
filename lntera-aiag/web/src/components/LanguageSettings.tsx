// Language section of the Active Agent settings modal: a segmented switcher (English / Bahasa Indonesia)
// that updates the app UI instantly and persists the per-tenant preference (which also drives the
// assistant's reply language). LanguageSync adopts the server preference on login so it's consistent
// across devices. Adding a language = a new locale file + LANGUAGES entry; this UI maps over LANGUAGES.
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { isLang, LANG_CODES, LANGUAGES, useI18n, type Lang } from '../i18n';
import { getLanguage, putLanguage } from '../lib/language';
import { cn } from '@/lib/utils';

export function LanguageSettings() {
  const { api } = useAuth();
  const online = useOnlineStatus();
  const { t, lang, setLang } = useI18n();
  const [saving, setSaving] = useState<Lang | null>(null);

  async function choose(next: Lang) {
    if (next === lang) return;
    const prev = lang;
    setLang(next); // instant UI switch
    setSaving(next);
    try {
      await putLanguage(api, next);
      toast.success(t('language.saved'));
    } catch {
      setLang(prev); // revert on failure
      toast.error(t('language.error'));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-sm font-medium text-foreground">{t('language.title')}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{t('language.description')}</p>
      </div>
      <div className="inline-flex w-fit rounded-lg border border-input bg-background p-0.5">
        {LANG_CODES.map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => void choose(code)}
            disabled={!online || saving !== null}
            className={cn(
              'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-60',
              code === lang ? 'bg-brand text-white shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={code === lang}
          >
            {LANGUAGES[code].label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** App-wide: adopt the tenant's saved language (source of truth) once per session after login. */
export function LanguageSync() {
  const { session, api } = useAuth();
  const { lang, setLang } = useI18n();
  const synced = useRef(false);

  useEffect(() => {
    if (!session) {
      synced.current = false;
      return;
    }
    if (synced.current) return;
    synced.current = true;
    getLanguage(api)
      .then((server) => {
        if (isLang(server) && server !== lang) setLang(server);
      })
      .catch(() => {
        /* keep the locally-detected language */
      });
  }, [session, api, lang, setLang]);

  return null;
}
