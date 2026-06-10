import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { Alert, Button, Code, Input, Modal, Step, Steps } from '../ui';

type Status = { tone: 'success' | 'error' | 'neutral'; text: string } | null;

export interface ProviderConnectConfig {
  /** Display name, e.g. "Groq" or "Gemini". */
  name: string;
  /** Prefixes a valid key may start with, e.g. ["gsk_"] or ["AIza", "AQ."]. */
  keyPrefixes: string[];
  /** Human hint for the prefixes, e.g. "gsk_…" or "AIza… or AQ.…". */
  keyHint: string;
  /** Placeholder shown in the input, e.g. "gsk_..." or "AIza...". */
  keyPlaceholder: string;
  /** Where the user creates a free key. */
  consoleUrl: string;
  /** Button label for opening the console, e.g. "Open Groq console ↗". */
  consoleLabel: string;
  /** Short note about where the key comes from (step 1). */
  createHint: string;
}

/**
 * Guided BYO API-key onboarding for non-technical users (generalized from the Groq flow):
 * open the provider console, copy the key, and paste it — with clipboard auto-fill when the user
 * switches back to this tab, an explicit "Paste" button, and paste-event detection.
 */
export function ProviderConnect({
  open,
  onClose,
  onConnect,
  config,
}: {
  open: boolean;
  onClose: () => void;
  /** POSTs the key; should throw with a message on failure. On success the parent closes + refetches. */
  onConnect: (apiKey: string) => Promise<void>;
  config: ProviderConnectConfig;
}) {
  const { name, keyPrefixes, keyHint, keyPlaceholder, consoleUrl, consoleLabel, createHint } = config;
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [saving, setSaving] = useState(false);
  const openedConsole = useRef(false);
  const looksLikeKey = (v: string) => keyPrefixes.some((p) => v.startsWith(p));
  const valid = looksLikeKey(key.trim());

  // Reset state each time the modal opens.
  useEffect(() => {
    if (open) {
      setKey('');
      setStatus(null);
      setSaving(false);
      openedConsole.current = false;
    }
  }, [open]);

  async function tryClipboard(explicit: boolean) {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (looksLikeKey(text)) {
        setKey(text);
        setStatus({ tone: 'neutral', text: 'Pasted your key from the clipboard.' });
      } else if (explicit) {
        setStatus({ tone: 'error', text: `Your clipboard doesn’t contain a ${name} key (it should start with ${keyHint}).` });
      }
    } catch {
      if (explicit) {
        setStatus({ tone: 'error', text: 'Couldn’t read the clipboard — paste manually with Cmd/Ctrl+V.' });
      }
    }
  }

  // Auto-fill when the user returns to this tab after copying the key from the provider console.
  useEffect(() => {
    if (!open) return;
    const onFocus = () => {
      if (openedConsole.current && !key.trim()) void tryClipboard(false);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text').trim();
    if (looksLikeKey(text)) {
      e.preventDefault();
      setKey(text);
      setStatus(null);
    }
  }

  async function submit() {
    if (!valid) {
      setStatus({ tone: 'error', text: `That doesn’t look like a ${name} key — it should start with ${keyHint}.` });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await onConnect(key.trim());
    } catch (err) {
      setStatus({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Connect ${name}`}
      subtitle={`Bring your own ${name} API key. It’s stored securely in Portkey — never in our database.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || saving}>
            {saving ? 'Connecting…' : `Connect ${name}`}
          </Button>
        </>
      }
    >
      <Steps>
        <Step n={1} title={`Create a free ${name} API key`}>
          {createHint}
          <div className="mt-2">
            <Button
              variant="secondary"
              onClick={() => {
                window.open(consoleUrl, '_blank', 'noopener,noreferrer');
                openedConsole.current = true;
              }}
            >
              {consoleLabel}
            </Button>
          </div>
        </Step>
        <Step n={2} title="Copy the key">
          It starts with <Code>{keyHint}</Code>. Copy it to your clipboard.
        </Step>
        <Step n={3} title="Come back here">
          We’ll fill it in automatically — or paste it below.
        </Step>
      </Steps>

      <div className="mt-5">
        <div className="flex gap-2">
          <Input
            type="password"
            value={key}
            placeholder={keyPlaceholder}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            onPaste={onPaste}
          />
          <Button variant="secondary" type="button" onClick={() => void tryClipboard(true)}>
            Paste
          </Button>
        </div>
        {status ? <Alert tone={status.tone}>{status.text}</Alert> : null}
      </div>
    </Modal>
  );
}

/** Provider presets for the connect dialog (mirror of the server registry). */
export const PROVIDER_CONNECT_CONFIGS: Record<'groq' | 'gemini', ProviderConnectConfig> = {
  groq: {
    name: 'Groq',
    keyPrefixes: ['gsk_'],
    keyHint: 'gsk_…',
    keyPlaceholder: 'gsk_...',
    consoleUrl: 'https://console.groq.com/keys',
    consoleLabel: 'Open Groq console ↗',
    createHint: 'Sign in or create a Groq account, then click Create API Key.',
  },
  gemini: {
    name: 'Gemini',
    keyPrefixes: ['AIza', 'AQ.'],
    keyHint: 'AIza… or AQ.…',
    keyPlaceholder: 'AIza... or AQ....',
    consoleUrl: 'https://aistudio.google.com/apikey',
    consoleLabel: 'Open Google AI Studio ↗',
    createHint: 'Sign in with your Google account in AI Studio, then click Create API key (free tier).',
  },
};
