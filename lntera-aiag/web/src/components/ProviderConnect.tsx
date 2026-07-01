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
  /** Advanced/BYOK provider: the user must also type the model codes they're allowed to use. */
  advanced?: boolean;
  /** Example model codes shown as a hint for advanced providers. */
  modelHint?: string;
}

/** Split a free-form model list (commas / whitespace / newlines) into clean, de-duped codes. */
export function parseModelCodes(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,]+/)) {
    const code = raw.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
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
  /** POSTs the key (+ models for advanced providers); throw with a message on failure. */
  onConnect: (apiKey: string, selectedModels?: string[]) => Promise<void>;
  config: ProviderConnectConfig;
}) {
  const { name, keyPrefixes, keyHint, keyPlaceholder, consoleUrl, consoleLabel, createHint } = config;
  const [key, setKey] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [saving, setSaving] = useState(false);
  const openedConsole = useRef(false);
  const looksLikeKey = (v: string) => keyPrefixes.some((p) => v.startsWith(p));
  const models = parseModelCodes(modelsText);
  const modelsOk = !config.advanced || models.length > 0;
  const valid = looksLikeKey(key.trim()) && modelsOk;

  // Reset state each time the modal opens.
  useEffect(() => {
    if (open) {
      setKey('');
      setModelsText('');
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
    if (!looksLikeKey(key.trim())) {
      setStatus({ tone: 'error', text: `That doesn’t look like a ${name} key — it should start with ${keyHint}.` });
      return;
    }
    if (!modelsOk) {
      setStatus({ tone: 'error', text: `Enter at least one ${name} model code you want to allow.` });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await onConnect(key.trim(), config.advanced ? models : undefined);
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
        <Step n={1} title={config.advanced ? `Create a ${name} API key` : `Create a free ${name} API key`}>
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

        {config.advanced ? (
          <div className="mt-3">
            <label className="text-[13px] font-medium">Allowed model codes</label>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              One per line (or comma-separated). You'll pick from these in the chat box.
              {config.modelHint ? <> e.g. <Code>{config.modelHint}</Code></> : null}
            </p>
            <textarea
              value={modelsText}
              placeholder={config.modelHint ?? 'model-code'}
              autoComplete="off"
              spellCheck={false}
              rows={3}
              onChange={(e) => setModelsText(e.target.value)}
              className="mt-1.5 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            {models.length > 0 ? (
              <p className="mt-1 text-[12px] text-muted-foreground">{models.length} model{models.length === 1 ? '' : 's'}: {models.join(', ')}</p>
            ) : null}
          </div>
        ) : null}

        {status ? <Alert tone={status.tone}>{status.text}</Alert> : null}
      </div>
    </Modal>
  );
}

/**
 * Edit an advanced provider's allowed model list WITHOUT re-entering the key (PUT …/models).
 * Prefilled with the current codes; saving replaces the set.
 */
export function EditModelsModal({
  open,
  onClose,
  onSave,
  name,
  initial,
  modelHint,
}: {
  open: boolean;
  onClose: () => void;
  /** PUTs the new codes; throw with a message on failure. */
  onSave: (selectedModels: string[]) => Promise<void>;
  name: string;
  initial: string[];
  modelHint?: string;
}) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [saving, setSaving] = useState(false);
  const models = parseModelCodes(text);

  useEffect(() => {
    if (open) {
      setText(initial.join('\n'));
      setStatus(null);
      setSaving(false);
    }
  }, [open, initial]);

  async function submit() {
    if (models.length === 0) {
      setStatus({ tone: 'error', text: `Enter at least one ${name} model code.` });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await onSave(models);
    } catch (err) {
      setStatus({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${name} models`}
      subtitle="Choose which model codes this provider is allowed to use in chat."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={models.length === 0 || saving}>
            {saving ? 'Saving…' : 'Save models'}
          </Button>
        </>
      }
    >
      <label className="text-[13px] font-medium">Allowed model codes</label>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        One per line (or comma-separated).
        {modelHint ? <> e.g. <Code>{modelHint}</Code></> : null}
      </p>
      <textarea
        value={text}
        placeholder={modelHint ?? 'model-code'}
        autoComplete="off"
        spellCheck={false}
        rows={4}
        onChange={(e) => setText(e.target.value)}
        className="mt-1.5 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      {status ? <Alert tone={status.tone}>{status.text}</Alert> : null}
    </Modal>
  );
}

/** Provider presets for the connect dialog (mirror of the server registry). */
export const PROVIDER_CONNECT_CONFIGS: Record<string, ProviderConnectConfig> = {
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
  // Advanced (BYOK): paid keys, user-supplied models, pin-only in chat.
  openai: {
    name: 'OpenAI',
    keyPrefixes: ['sk-'],
    keyHint: 'sk-…',
    keyPlaceholder: 'sk-...',
    consoleUrl: 'https://platform.openai.com/api-keys',
    consoleLabel: 'Open OpenAI API keys ↗',
    createHint: 'Sign in to the OpenAI platform, then create a new secret key.',
    advanced: true,
    modelHint: 'gpt-4o, gpt-4o-mini',
  },
  anthropic: {
    name: 'Anthropic',
    keyPrefixes: ['sk-ant-'],
    keyHint: 'sk-ant-…',
    keyPlaceholder: 'sk-ant-...',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    consoleLabel: 'Open Anthropic console ↗',
    createHint: 'Sign in to the Anthropic console, then create an API key.',
    advanced: true,
    modelHint: 'claude-sonnet-4-5, claude-haiku-4-5',
  },
  openrouter: {
    name: 'OpenRouter',
    keyPrefixes: ['sk-or-'],
    keyHint: 'sk-or-…',
    keyPlaceholder: 'sk-or-...',
    consoleUrl: 'https://openrouter.ai/keys',
    consoleLabel: 'Open OpenRouter keys ↗',
    createHint: 'Sign in to OpenRouter, then create an API key.',
    advanced: true,
    modelHint: 'anthropic/claude-3.5-sonnet, openai/gpt-4o',
  },
};
