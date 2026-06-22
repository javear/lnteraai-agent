import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../lib/pwa';
import { Badge, Button, Card } from '../ui';
import { ProviderConnect, PROVIDER_CONNECT_CONFIGS } from '../components/ProviderConnect';
import { useApp } from '../components/AppLayout';
import { IntegrationListSkeleton } from '../components/Skeletons';
import { SuccessArt } from '../components/Lottie';
import { apiErrorMessage, type IntegrationStatus } from '../lib/integrations';
import { openAuthPopup } from '../lib/oauth-popup';
import { useNotifications } from '../lib/notifications';
import { IS_NATIVE } from '../lib/runtime';

function label(key: string): string {
  return { discord: 'Discord', groq: 'Groq', gemini: 'Gemini', tiktok: 'TikTok Shop', shopee: 'Shopee' }[key] ?? key;
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

  // Show a toast when returning from an OAuth callback (?connected=…&status=…), then clean the URL
  // (router-aware so it works under both the /app basename and native hash routing).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    if (!connected) return;
    const ok = params.get('status') !== 'error';
    if (ok) celebrate(label(connected));
    else toast.error(`${label(connected)} failed`, { description: params.get('message') ?? 'Unknown error' });
    navigate('/integrations', { replace: true });
    void refreshStatus(true);
  }, [refreshStatus, navigate]);

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

      // Native shell: open the system browser; the app stays alive and refreshes on the realtime
      // `connection` event above when the user returns. (Installing @capacitor/browser would enable an
      // in-app browser that auto-dismisses — see NATIVE.md.)
      if (IS_NATIVE) {
        window.open(data.url, '_blank');
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
          <MarketplaceCard
            name="TikTok Shop"
            platform="tiktok"
            stores={(status?.tiktok ?? []).map((s) => ({ id: s.openId, shopName: s.shopName, region: s.region }))}
            busy={busy}
            disabled={!online}
            onConnect={() => connectOAuth('tiktok')}
            onRemove={(id, dn) => disconnectStore('tiktok', id, dn)}
          />
          <MarketplaceCard
            name="Shopee"
            platform="shopee"
            stores={(status?.shopee ?? []).map((s) => ({ id: s.shopId, shopName: s.shopName, region: null }))}
            busy={busy}
            disabled={!online}
            onConnect={() => connectOAuth('shopee')}
            onRemove={(id, dn) => disconnectStore('shopee', id, dn)}
          />
        </div>
      )}
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
  onDone,
  onDisconnect,
}: {
  code: 'groq' | 'gemini';
  title: string;
  desc: string;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  onDone: () => Promise<void> | void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const cfg = PROVIDER_CONNECT_CONFIGS[code];

  async function connect(apiKey: string) {
    const res = await api(`/svc/v1/me/integrations/llm/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    if (!res.ok) {
      throw new Error(await apiErrorMessage(res, `Connect failed (${res.status}).`));
    }
    setOpen(false);
    await onDone();
    celebrate(cfg.name);
  }

  return (
    <>
      <Row
        title={title}
        desc={desc}
        badge={active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Not connected</Badge>}
        actions={
          active ? (
            <Button variant="danger" disabled={busy} onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : (
            <Button disabled={disabled} onClick={() => setOpen(true)}>
              Connect
            </Button>
          )
        }
      />
      <ProviderConnect open={open} onClose={() => setOpen(false)} onConnect={connect} config={cfg} />
    </>
  );
}

interface MarketplaceStore {
  id: string;
  shopName: string | null;
  region: string | null;
}

/** Marketplace card supporting MULTIPLE stores per platform: list each, add more, remove one. */
function MarketplaceCard({
  name,
  platform,
  stores,
  busy,
  disabled,
  onConnect,
  onRemove,
}: {
  name: string;
  platform: 'shopee' | 'tiktok';
  stores: MarketplaceStore[];
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
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">{display}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {s.region ? `${s.region} · ` : ''}
                      {s.id}
                    </div>
                  </div>
                  <Button
                    variant="danger"
                    disabled={removing || disabled}
                    onClick={() => onRemove(s.id, display)}
                  >
                    {removing ? 'Removing…' : 'Remove'}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
