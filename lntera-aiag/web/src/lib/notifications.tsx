import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Session } from '@supabase/supabase-js';
import { useAuth } from '../auth';
import { getPublicConfig } from './supabase';
import { initPush } from './push';
import { notificationsThreadId } from './threads';
import { NotificationSettings } from '../components/NotificationSettings';

const INAPP_PREF_KEY = 'lntera-inapp-alerts';

/** Token-free action button (mirrors server broadcast.ts NotificationAction). */
export type NotificationActionKind =
  | 'sync_action'
  | 'propagate'
  | 'resync'
  | 'list_on_marketplace'
  | 'link'
  | 'dismiss';

export interface NotificationAction {
  id: string;
  label: string;
  kind: NotificationActionKind;
  style?: 'primary' | 'default' | 'danger';
  href?: string;
}

export interface NotificationContextRef {
  linkId?: string;
  internalProductId?: string;
  platform?: string;
  productId?: string;
  shopId?: string;
  /** Bidirectional-sync propagation proposal (the 'propagate' action targets this). */
  proposalId?: string;
  attribute?: 'stock' | 'price';
}

/** A tenant notification pushed from the server over Supabase Realtime (see server broadcast.ts). */
export interface TenantNotification {
  id: string;
  text: string;
  kind: 'marketplace' | 'connection' | 'product_sync' | 'insight';
  platform?: string;
  category?: string;
  code?: string;
  createdAt: string;
  /** Token-free interactive buttons (product-sync prompts). */
  actions?: NotificationAction[];
  contextRef?: NotificationContextRef;
  /** Charts for scheduled business-insight notifications. */
  charts?: import('./insights').ChartSpec[];
  deterministic?: boolean;
}

type Listener = (n: TenantNotification) => void;

interface NotificationsContextValue {
  /** Subscribe to live notifications (used by the chat for auto-writing). Returns an unsubscribe fn. */
  subscribe: (listener: Listener) => () => void;
  unread: number;
  markAllRead: () => void;
  /** Whether in-app pop-ups + chat auto-writing are shown (persisted preference). */
  inAppEnabled: boolean;
  setInAppEnabled: (value: boolean) => void;
  /** Open the notifications settings dialog (subscribe to push / toggle in-app alerts). */
  openSettings: () => void;
  /** The dedicated "Notifications" chat thread id for this tenant (null before tenant is known). */
  notificationsThreadId: string | null;
  /** Navigate to the Notifications chat. */
  openNotifications: () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

function tenantIdOf(session: Session | null): string | undefined {
  return (session?.user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
}

function prettyPlatform(p?: string): string {
  if (p === 'tiktok') return 'TikTok Shop';
  if (p === 'shopee') return 'Shopee';
  return p ?? 'Notification';
}

function headingFor(n: TenantNotification): string {
  if (n.kind === 'connection') return 'Integration update';
  const base = prettyPlatform(n.platform);
  return n.category ? `${base} · ${n.category}` : base;
}

function snippet(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function RealtimeNotificationsProvider({ children }: { children: ReactNode }) {
  const { supabase, session } = useAuth();
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inAppEnabled, setInAppEnabledState] = useState(() => {
    try {
      return localStorage.getItem(INAPP_PREF_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const inAppRef = useRef(inAppEnabled);
  inAppRef.current = inAppEnabled;

  const tenantId = tenantIdOf(session);
  const notifThreadId = tenantId ? notificationsThreadId(tenantId) : null;
  const token = session?.access_token;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const listenersRef = useRef<Set<Listener>>(new Set());

  const handle = useCallback(
    (n: TenantNotification) => {
      if (!n?.text) return;
      setUnread((u) => u + 1);
      // The "In-app alerts" preference mutes the pop-up + chat auto-writing (not push / unread count).
      if (!inAppRef.current) return;
      toast(headingFor(n), {
        description: snippet(n.text),
        duration: 6000,
        action: {
          label: 'View',
          onClick: () => navigate(notifThreadId ? `/c/${notifThreadId}` : '/'),
        },
      });
      listenersRef.current.forEach((l) => {
        try {
          l(n);
        } catch {
          /* a bad listener must not break delivery to others */
        }
      });
    },
    [navigate, notifThreadId],
  );
  const handleRef = useRef(handle);
  handleRef.current = handle;

  // Register for OneSignal push once we know the user + tenant (external id + tenant tag).
  useEffect(() => {
    const cfg = getPublicConfig();
    const userId = session?.user?.id;
    if (cfg?.oneSignalAppId && userId && tenantId) {
      void initPush({
        appId: cfg.oneSignalAppId,
        userId,
        tenantId,
        safariWebId: cfg.oneSignalSafariWebId,
      });
    }
  }, [session?.user?.id, tenantId]);

  // Keep the realtime socket's auth token fresh across refreshes (private channels need it).
  useEffect(() => {
    if (token) supabase.realtime.setAuth(token);
  }, [supabase, token]);

  // Subscribe to the tenant's private broadcast topic (re-subscribes only when the tenant changes).
  useEffect(() => {
    const authToken = tokenRef.current;
    if (!tenantId || !authToken) return;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    void (async () => {
      // Private channels authorize the join against the user JWT. setAuth is async — await it so
      // the token has propagated before .subscribe(), otherwise the join can race and CHANNEL_ERROR.
      await supabase.realtime.setAuth(authToken);
      if (cancelled) return;
      channel = supabase
        .channel(`tenant:${tenantId}`, { config: { private: true } })
        .on('broadcast', { event: 'notification' }, (msg) =>
          handleRef.current(msg.payload as TenantNotification),
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            if (import.meta.env.DEV) console.info(`[notifications] subscribed to tenant:${tenantId}`);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            // Almost always the Realtime authorization policy is missing — apply the migration
            // supabase/migrations/0009_realtime_tenant_broadcast.sql (RLS on realtime.messages).
            console.warn(
              `[notifications] realtime ${status} on tenant:${tenantId} — is the Realtime RLS policy applied (migration 0009)?`,
            );
          }
        });
    })();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase, tenantId]);

  // Stable identities so consumers (e.g. the chat's auto-write effect) don't re-subscribe on each tick.
  const subscribe = useCallback((listener: Listener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);
  const markAllRead = useCallback(() => setUnread(0), []);
  const setInAppEnabled = useCallback((value: boolean) => {
    setInAppEnabledState(value);
    try {
      localStorage.setItem(INAPP_PREF_KEY, value ? 'on' : 'off');
    } catch {
      /* private mode — keep the in-memory value */
    }
  }, []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const openNotifications = useCallback(
    () => navigate(notifThreadId ? `/c/${notifThreadId}` : '/'),
    [navigate, notifThreadId],
  );

  const value = useMemo<NotificationsContextValue>(
    () => ({
      subscribe,
      unread,
      markAllRead,
      inAppEnabled,
      setInAppEnabled,
      openSettings,
      notificationsThreadId: notifThreadId,
      openNotifications,
    }),
    [subscribe, unread, markAllRead, inAppEnabled, setInAppEnabled, openSettings, notifThreadId, openNotifications],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      <NotificationSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        inAppEnabled={inAppEnabled}
        setInAppEnabled={setInAppEnabled}
      />
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used within a RealtimeNotificationsProvider');
  return ctx;
}
