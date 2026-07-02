import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * Read-only terminal view: renders the sandbox's command output stream (xterm + fit addon). Input
 * isn't wired — v1 is agent-driven, the user watches commands run.
 */
export function TerminalView({ subscribe }: { subscribe: (cb: (chunk: string) => void) => () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0b0b0f' },
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host not laid out yet */
    }

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('resize', onResize);
    const unsubscribe = subscribe((chunk) => term.write(chunk));

    return () => {
      window.removeEventListener('resize', onResize);
      unsubscribe();
      term.dispose();
    };
  }, [subscribe]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden rounded-lg bg-[#0b0b0f] p-2" />;
}
