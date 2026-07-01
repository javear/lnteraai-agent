import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { Badge, Button, Card } from '../ui';
import { ProviderConnect, EditModelsModal, PROVIDER_CONNECT_CONFIGS } from '../components/ProviderConnect';
import { useApp } from '../components/AppLayout';
import { IntegrationListSkeleton } from '../components/Skeletons';
import { SuccessArt } from '../components/Lottie';
import { apiErrorMessage, type AdvancedLlmStatus, type IntegrationStatus } from '../lib/integrations';
import { openAuthPopup } from '../lib/oauth-popup';
import { useNotifications } from '../lib/notifications';
import { IS_NATIVE } from '../lib/runtime';
import { SyncPrefsSettings } from '../components/SyncPrefsSettings';
import { StoreSyncConfig } from '../components/StoreSyncConfig';
import { BuildTag } from '../components/BuildTag';
import { getStores, type StoreSyncRow } from '../lib/sync-config';

function label(key: string): string {
  return (
    {
      discord: 'Discord',
      groq: 'Groq',
      gemini: 'Gemini',
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      openrouter: 'OpenRouter',
      tiktok: 'TikTok Shop',
      shopee: 'Shopee',
    }[key] ?? key
  );
}

/** A celebratory toast with the success Lottie (lazy — only loads when something connects). */
function celebrate(name: string) {
  toast.custom(
    () => (
      <div className="flex items-center gap-3 rounded-lg border bg-popover px-4 py-3 text-popover-foreground shadow-lg">
        <SuccessArt className="h-10 w-10 shrink-0" />
        <div className="text-sm font-medium">{name} connected</div>
      </div>
    ),
    { duration: 3500 },
  );
}

export default function Integrations() {
  const { api } = useAuth();
  const { status, loadingStatus, refreshStatus } = useApp();
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const { subscribe } = useNotifications();
  const [busy, setBusy] = useState<string | null>(null);
  const [storeCfgs, setStoreCfgs] = useState<Map<string, StoreSyncRow>>(new Map());

  // Per-store sync transforms (margins / stock cap), keyed by connectionId. Reload when stores change.
  useEffect(() => {
    let cancelled = false;
    getStores(api)
      .then((rows) => {
        if (!cancelled) setStoreCfgs(new Map(rows.map((r) => [r.connectionId, r])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, status]);

  const onStoreCfgSaved = (saved: StoreSyncRow) =>
    setStoreCfgs((m) => new Map(m).set(saved.connectionId, saved));

  // Show a toast when returning from an OAuth callback (?connected=…&status=…), then clean the URL.
  // Reads the ROUTER query (useSearchParams) so it works under both the /app basename and native hash
  // routing — on native the App Link return is navigated in via NativeDeepLinks, not the page URL.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const connected = searchParams.get('connected');
    if (!connected) return;
    const ok = searchParams.get('status') !== 'error';
    if (ok) celebrate(label(connected));
    else toast.error(`${label(connected)} failed`, { description: searchParams.get('message') ?? 'Unknown error' });
    navigate('/integrations', { replace: true });
    void refreshStatus(true);
  }, [searchParams, refreshStatus, navigate]);

  // Backstop for the seamless connect flow: when the backend broadcasts a `connection` event (a store
  // linked), refresh the list and clear any spinner — covers mobile, where the OAuth tab can't always
  // postMessage/auto-close back to the app.
  useEffect(
    () =>
      subscribe((n) => {
        if (n.kind === 'connection') {
          setBusy(null);
          void refreshStatus(true);
        }
      }),
    [subscribe, refreshStatus],
  );

  async function connectOAuth(platform: 'discord' | 'shopee' | 'tiktok') {
    setBusy(platform);
    try {
      const res = await api(`/svc/v1/me/integrations/${platform}/connect-url`, { method: 'POST' });
      const data = (await res.json()) as { url?: string; message?: string };
      if (!res.ok || !data.url) throw new Error(data.message || `Could not start ${label(platform)} connect.`);

      // Native shell: open the OAuth flow in the Capacitor Browser (Chrome Custom Tab). The backend
      // redirects back to https://lntera.ai/integrations?connected=… — a verified App Link reopens THIS
      // app, where NativeDeepLinks dismisses the tab + routes here (and the realtime `connection` event
      // is the backstop refresh).
      if (IS_NATIVE) {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url: data.url });
        window.setTimeout(() => setBusy((b) => (b === platform ? null : b)), 1500);
        return;
      }

      // Web/PWA: open a popup (desktop) / new tab (mobile) so the app never unloads. The backend result
      // page messages the outcome back and closes itself; the realtime handler above is the backstop.
      const { opened } = openAuthPopup(data.url, {
        onResult: (r) => {
          setBusy(null);
          if (r.status === 'ok') {
            celebrate(label(platform));
            void refreshStatus(true);
          } else {
            toast.error(`${label(platform)} failed`, { description: r.message || 'Please try again.' });
          }
        },
        onClose: () => {
          // Closed without a message (cancel, or a mobile tab that couldn't postMessage). Refresh in
          // case it actually succeeded.
          setBusy(null);
          void refreshStatus(true);
        },
      });
      if (!opened) {
        // Popup blocked → fall back to the classic full-page redirect.
        window.location.href = data.url;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  async function disconnect(integration: string) {
    setBusy(integration);
    try {
      const res = await api(`/svc/v1/me/integrations/${integration}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, `Disconnect failed (${res.status}).`));
      }
      await refreshStatus(true);
      toast.success(`${label(integration)} disconnected.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /** Remove ONE marketplace store (a platform can have several connected). */
  async function disconnectStore(platform: 'shopee' | 'tiktok', shopId: string, displayName: string) {
    setBusy(`${platform}:${shopId}`);
    try {
      const res = await api(`/svc/v1/me/integrations/${platform}/${encodeURIComponent(shopId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, `Remove failed (${res.status}).`));
      }
      await refreshStatus(true);
      toast.success(`${displayName} removed.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pb-16 pt-8 sm:px-6 sm:pb-24 sm:pt-10">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-[26px]">Integrations</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">
        Connect the channels and models your agent works with.
      </p>
      {!online ? (
        <div className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <WifiOff className="h-3.5 w-3.5" />
          Offline — showing last-known status. Connecting needs a connection.
        </div>
      ) : null}

      {loadingStatus ? (
        <IntegrationListSkeleton />
      ) : (
        <div className="mt-6 grid gap-3">
          <DiscordCard
            status={status}
            busy={busy}
            disabled={!online}
            onConnect={() => connectOAuth('discord')}
            onDisconnect={() => disconnect('discord')}
          />
          <LlmProviderCard
            code="groq"
            title="Groq (Portkey)"
            desc="Bring your own Groq API key to power the agent's model."
            active={status?.groq.status === 'active'}
            busy={busy === 'groq'}
            disabled={!online}
            api={api}
            onDone={() => refreshStatus(true)}
            onDisconnect={() => disconnect('groq')}
          />
          <LlmProviderCard
            code="gemini"
            title="Google Gemini (Portkey)"
            desc="Bring your own free Gemini API key. When both are connected, the agent rolls across providers."
            active={status?.gemini?.status === 'active'}
            busy={busy === 'gemini'}
            disabled={!online}
            api={api}
            onDone={() => refreshStatus(true)}
            onDisconnect={() => disconnect('gemini')}
          />

          <div className="mt-2">
            <h2 className="text-[15px] font-semibold">Advanced (bring your own key)</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Connect a paid provider with your own key and choose which models to allow. These aren't used by
              the free auto-rotation — pick one in the chat box when you want it.
            </p>
          </div>
          <LlmProviderCard
            code="openai"
            title="OpenAI (Portkey)"
            desc="Bring your own OpenAI key and pick the models you want to use."
            active={status?.openai?.status === 'active'}
            busy={busy === 'openai'}
            disabled={!online}
            api={api}
            advancedStatus={status?.openai}
            onDone={() => refreshStatus(true)}
            onDisconnect={() => disconnect('openai')}
          />
          <LlmProviderCard
            code="anthropic"
            title="Anthropic (Portkey)"
            desc="Bring your own Anthropic key and pick the Claude models you want to use."
            active={status?.anthropic?.status === 'active'}
            busy={busy === 'anthropic'}
            disabled={!online}
            api={api}
            advancedStatus={status?.anthropic}
            onDone={() => refreshStatus(true)}
            onDisconnect={() => disconnect('anthropic')}
          />
          <LlmProviderCard
            code="openrouter"
            title="OpenRouter (Portkey)"
            desc="Bring your own OpenRouter key and pick the models you want to route to."
            active={status?.openrouter?.status === 'active'}
            busy={busy === 'openrouter'}
            disabled={!online}
            api={api}
            advancedStatus={status?.openrouter}
            onDone={() => refreshStatus(true)}
            onDisconnect={() => disconnect('openrouter')}
          />

          <MarketplaceCard
            name="TikTok Shop"
            platform="tiktok"
            stores={(status?.tiktok ?? []).map((s) => ({
              id: s.openId,
              connectionId: s.connectionId,
              shopName: s.shopName,
              region: s.region,
            }))}
            storeCfgs={storeCfgs}
            onStoreCfgSaved={onStoreCfgSaved}
            busy={busy}
            disabled={!online}
            onConnect={() => connectOAuth('tiktok')}
            onRemove={(id, dn) => disconnectStore('tiktok', id, dn)}
          />
          <MarketplaceCard
            name="Shopee"
            platform="shopee"
            stores={(status?.shopee ?? []).map((s) => ({
              id: s.shopId,
              connectionId: s.connectionId,
              shopName: s.shopName,
              region: null,
            }))}
            storeCfgs={storeCfgs}
            onStoreCfgSaved={onStoreCfgSaved}
            busy={busy}
            disabled={!online}
            onConnect={() => connectOAuth('shopee')}
            onRemove={(id, dn) => disconnectStore('shopee', id, dn)}
          />
          <SyncPrefsSettings />
        </div>
      )}
      <BuildTag />
    </div>
  );
}

function Row({ title, desc, badge, actions }: { title: string; desc: string; badge: ReactNode; actions: ReactNode }) {
  return (
    <Card className="transition-shadow hover:shadow-md">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="text-[15px] font-semibold">{title}</h3>
            {badge}
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">{desc}</p>
        </div>
        <div className="flex shrink-0 gap-2">{actions}</div>
      </div>
    </Card>
  );
}

function DiscordCard({
  status,
  busy,
  disabled,
  onConnect,
  onDisconnect,
}: {
  status: IntegrationStatus | null;
  busy: string | null;
  disabled: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connected = Boolean(status?.discord.connected);
  return (
    <Row
      title="Discord"
      desc={connected ? `Linked to guild ${status?.discord.guildId}` : 'Install the bot into a server channel.'}
      badge={connected ? <Badge tone="success">Connected</Badge> : <Badge tone="neutral">Not connected</Badge>}
      actions={
        connected ? (
          <Button variant="danger" disabled={busy === 'discord'} onClick={onDisconnect}>
            Disconnect
          </Button>
        ) : (
          <Button disabled={busy === 'discord' || disabled} onClick={onConnect}>
            Connect
          </Button>
        )
      }
    />
  );
}

function LlmProviderCard({
  code,
  title,
  desc,
  active,
  busy,
  disabled,
  api,
  advancedStatus,
  onDone,
  onDisconnect,
}: {
  code: string;
  title: string;
  desc: string;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  /** For advanced/BYOK providers: their allowed model list (drives the "Edit models" button). */
  advancedStatus?: AdvancedLlmStatus;
  onDone: () => Promise<void> | void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const cfg = PROVIDER_CONNECT_CONFIGS[code];

  async function connect(apiKey: string, selectedModels?: string[]) {
    const res = await api(`/svc/v1/me/integrations/llm/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, ...(selectedModels ? { selectedModels } : {}) }),
    });
    if (!res.ok) {
      throw new Error(await apiErrorMessage(res, `Connect failed (${res.status}).`));
    }
    setOpen(false);
    await onDone();
    celebrate(cfg.name);
  }

  async function saveModels(selectedModels: string[]) {
    const res = await api(`/svc/v1/me/integrations/llm/${code}/models`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedModels }),
    });
    if (!res.ok) {
      throw new Error(await apiErrorMessage(res, `Update failed (${res.status}).`));
    }
    setEditOpen(false);
    await onDone();
    toast.success(`${cfg.name} models updated.`);
  }

  const models = advancedStatus?.selectedModels ?? [];
  const cardDesc = active && cfg.advanced && models.length > 0 ? `${desc} Models: ${models.join(', ')}` : desc;

  return (
    <>
      <Row
        title={title}
        desc={cardDesc}
        badge={active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Not connected</Badge>}
        actions={
          active ? (
            <>
              {cfg.advanced ? (
                <Button variant="secondary" disabled={busy || disabled} onClick={() => setEditOpen(true)}>
                  Edit models
                </Button>
              ) : null}
              <Button variant="danger" disabled={busy} onClick={onDisconnect}>
                Disconnect
              </Button>
            </>
          ) : (
            <Button disabled={disabled} onClick={() => setOpen(true)}>
              Connect
            </Button>
          )
        }
      />
      <ProviderConnect open={open} onClose={() => setOpen(false)} onConnect={connect} config={cfg} />
      {cfg.advanced ? (
        <EditModelsModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSave={saveModels}
          name={cfg.name}
          initial={models}
          modelHint={cfg.modelHint}
        />
      ) : null}
    </>
  );
}

interface MarketplaceStore {
  id: string;
  connectionId: string;
  shopName: string | null;
  region: string | null;
}

/** Marketplace card supporting MULTIPLE stores per platform: list each, add more, remove one. */
function MarketplaceCard({
  name,
  platform,
  stores,
  storeCfgs,
  onStoreCfgSaved,
  busy,
  disabled,
  onConnect,
  onRemove,
}: {
  name: string;
  platform: 'shopee' | 'tiktok';
  stores: MarketplaceStore[];
  storeCfgs: Map<string, StoreSyncRow>;
  onStoreCfgSaved: (s: StoreSyncRow) => void;
  busy: string | null;
  disabled: boolean;
  onConnect: () => void;
  onRemove: (shopId: string, displayName: string) => void;
}) {
  const count = stores.length;
  const connecting = busy === platform;
  return (
    <Card className="transition-shadow hover:shadow-md">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-[15px] font-semibold">{name}</h3>
              {count > 0 ? (
                <Badge tone="success">{count} connected</Badge>
              ) : (
                <Badge tone="neutral">Not connected</Badge>
              )}
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {count > 0
                ? 'Add more stores or remove them individually.'
                : `Connect your ${name} store via OAuth.`}
            </p>
          </div>
          <div className="shrink-0">
            <Button disabled={connecting || disabled} onClick={onConnect}>
              {connecting ? 'Connecting…' : count > 0 ? 'Add store' : 'Connect'}
            </Button>
          </div>
        </div>

        {count > 0 ? (
          <ul className="flex flex-col gap-2 border-t pt-3">
            {stores.map((s) => {
              const display = s.shopName || s.id;
              const removing = busy === `${platform}:${s.id}`;
              return (
                <li key={s.id} className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium">{display}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {s.region ? `${s.region} · ` : ''}
                        {s.id}
                      </div>
                    </div>
                    <Button variant="danger" disabled={removing || disabled} onClick={() => onRemove(s.id, display)}>
                      {removing ? 'Removing…' : 'Remove'}
                    </Button>
                  </div>
                  {storeCfgs.get(s.connectionId) ? (
                    <StoreSyncConfig store={storeCfgs.get(s.connectionId)!} onSaved={onStoreCfgSaved} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
