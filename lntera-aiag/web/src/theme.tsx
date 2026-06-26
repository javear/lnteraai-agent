import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useT } from './i18n';

type Theme = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

const STORAGE_KEY = 'lntera-theme';

function systemTheme(): Resolved {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolve(theme: Theme): Resolved {
  return theme === 'system' ? systemTheme() : theme;
}

/** Applied synchronously by an inline script in index.html before paint, then kept in sync here. */
function applyResolved(resolved: Resolved) {
  const el = document.documentElement;
  el.classList.toggle('dark', resolved === 'dark');
  el.style.colorScheme = resolved;
}

interface ThemeContextValue {
  theme: Theme;
  resolved: Resolved;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'light';
  });
  const [resolved, setResolved] = useState<Resolved>(() => resolve(theme));

  // Persist + apply whenever the preference changes.
  useEffect(() => {
    const next = resolve(theme);
    setResolved(next);
    applyResolved(next);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  // Follow OS changes while tracking the system preference.
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const next = systemTheme();
      setResolved(next);
      applyResolved(next);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}

/** Compact icon toggle that flips between light and dark (used in the mobile top bar). */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setTheme } = useTheme();
  const t = useT();
  return (
    <button
      type="button"
      aria-label={resolved === 'dark' ? t('theme.toLight') : t('theme.toDark')}
      onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
      className={
        'relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors ease-soft hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 ' +
        (className ?? '')
      }
    >
      <Sun className="h-[1.1rem] w-[1.1rem] rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-[1.1rem] w-[1.1rem] rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
    </button>
  );
}

// `label` is an i18n key (theme.light/dark/system) — translate at the render site via t(opt.label).
export const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'theme.light', icon: Sun },
  { value: 'dark', label: 'theme.dark', icon: Moon },
  { value: 'system', label: 'theme.system', icon: Monitor },
];
