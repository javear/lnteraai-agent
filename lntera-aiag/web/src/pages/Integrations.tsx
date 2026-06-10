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

  async function connectOAuth(platform: 'discord' | 'shopee' | 'tiktok') {
    setBusy(platform);
    try {
      const res = await api(`/svc/v1/me/integrations/${platform}/connect-url`, { method: 'POST' });
      const data = (await res.json()) as { url?: string; message?: string };
      if (!res.ok || !data.url) throw new Error(data.message || `Could not start ${label(platform)} connect.`);
      window.location.href = data.url;
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

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-6 sm:py-10">
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
          <ShopCard
            name="TikTok Shop"
            connected={(status?.tiktok.length ?? 0) > 0}
            detail={status?.tiktok.map((s) => s.shopName || s.openId).join(', ')}
            busy={busy === 'tiktok'}
            disabled={!online}
            onConnect={() => connectOAuth('tiktok')}
            onDisconnect={() => disconnect('tiktok')}
          />
          <ShopCard
            name="Shopee"
            connected={(status?.shopee.length ?? 0) > 0}
            detail={status?.shopee.map((s) => s.shopName || s.shopId).join(', ')}
            busy={busy === 'shopee'}
            disabled={!online}
            onConnect={() => connectOAuth('shopee')}
            onDisconnect={() => disconnect('shopee')}
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

function ShopCard({
  name,
  connected,
  detail,
  busy,
  disabled,
  onConnect,
  onDisconnect,
}: {
  name: string;
  connected: boolean;
  detail?: string;
  busy: boolean;
  disabled: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <Row
      title={name}
      desc={connected && detail ? detail : `Connect your ${name} shop via OAuth.`}
      badge={connected ? <Badge tone="success">Connected</Badge> : <Badge tone="neutral">Not connected</Badge>}
      actions={
        connected ? (
          <Button variant="danger" disabled={busy} onClick={onDisconnect}>
            Disconnect
          </Button>
        ) : (
          <Button disabled={busy || disabled} onClick={onConnect}>
            Connect
          </Button>
        )
      }
    />
  );
}
