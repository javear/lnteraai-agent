import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useMatch, useNavigate, useOutletContext } from 'react-router-dom';
import { Bell, ChevronsUpDown, LogOut, Menu, Plug, Sparkles, SquarePen, Trash2, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { fetchIntegrationStatus, type AppOutletContext, type IntegrationStatus } from '../lib/integrations';
import { useOnlineStatus } from '../lib/pwa';
import { ChatSessionsProvider, useChats } from '../lib/chat-store';
import { RealtimeNotificationsProvider, useNotifications } from '../lib/notifications';
import { THEME_OPTIONS, ThemeToggle, useTheme } from '../theme';
import { Avatar, Logo } from '../ui';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SidebarSkeleton } from './Skeletons';

/** Pages read shared status via `const { status, refreshStatus } = useApp()`. */
export function useApp(): AppOutletContext {
  return useOutletContext<AppOutletContext>();
}

function connectionRows(status: IntegrationStatus | null) {
  return [
    { key: 'groq', label: 'Groq', on: status?.groq.status === 'active' },
    { key: 'gemini', label: 'Gemini', on: status?.gemini?.status === 'active' },
    { key: 'discord', label: 'Discord', on: Boolean(status?.discord.connected) },
    { key: 'tiktok', label: 'TikTok Shop', on: (status?.tiktok.length ?? 0) > 0 },
    { key: 'shopee', label: 'Shopee', on: (status?.shopee.length ?? 0) > 0 },
  ];
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.round(d / 7)}w`;
}

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
    isActive
      ? 'bg-background text-foreground shadow-sm ring-1 ring-border [&_svg]:text-[hsl(var(--brand))]'
      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
  );

/** Bell with an unread dot, fed by the realtime notifications provider. */
function NotificationBell() {
  const { unread, markAllRead, openNotifications } = useNotifications();
  return (
    <button
      aria-label={unread > 0 ? `${unread} new notifications` : 'Notifications'}
      onClick={() => {
        markAllRead();
        openNotifications();
      }}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Bell className="h-5 w-5" />
      {unread > 0 ? (
        <span className="absolute right-1.5 top-1.5 inline-flex h-2 w-2 rounded-full bg-destructive ring-2 ring-background" />
      ) : null}
    </button>
  );
}

/** The user's chat sessions — scrollable, newest first, with the pinned Notifications feed on top. */
function ChatSessionList({ activeId, onNavigate }: { activeId?: string; onNavigate?: () => void }) {
  const { threads, loading, deleteSession } = useChats();
  const { notificationsThreadId: notifId } = useNotifications();
  const navigate = useNavigate();

  async function onDelete(id: string) {
    try {
      await deleteSession(id);
      toast.success('Chat deleted');
      if (activeId === id) navigate('/');
    } catch {
      toast.error('Could not delete chat');
    }
  }

  return (
    <div className="flex flex-col gap-0.5">
      {notifId ? (
        <NavLink
          to={`/c/${notifId}`}
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
            activeId === notifId
              ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Sparkles className="text-[hsl(var(--brand))]" />
          <span className="flex-1 truncate font-medium">Active Agent</span>
        </NavLink>
      ) : null}

      {loading && threads.length === 0 ? (
        <div className="flex flex-col gap-1 px-1 pt-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8" style={{ width: `${88 - i * 8}%` }} />
          ))}
        </div>
      ) : threads.length === 0 ? (
        <p className="px-3 py-2 text-[13px] text-muted-foreground">No chats yet. Start a new one.</p>
      ) : (
        threads.map((t) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              'group flex items-center rounded-lg transition-colors',
              active ? 'bg-background shadow-sm ring-1 ring-border' : 'hover:bg-accent',
            )}
          >
            <NavLink
              to={`/c/${t.id}`}
              onClick={onNavigate}
              title={t.title}
              className={cn(
                'min-w-0 flex-1 truncate px-3 py-2 text-sm',
                active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
              )}
            >
              {t.title || 'New chat'}
            </NavLink>
            <span className="shrink-0 pr-2 text-[11px] tabular-nums text-muted-foreground group-hover:hidden group-focus-within:hidden">
              {relativeTime(t.updatedAt)}
            </span>
            <button
              aria-label="Delete chat"
              onClick={() => void onDelete(t.id)}
              className="hidden shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:mr-1 group-hover:inline-flex group-focus-within:mr-1 group-focus-within:inline-flex"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          );
        })
      )}
    </div>
  );
}

/** Sidebar body — rendered in both the desktop aside and the mobile drawer. */
function SidebarContent({
  status,
  loading,
  email,
  activeThreadId,
  onSignOut,
  onNavigate,
}: {
  status: IntegrationStatus | null;
  loading: boolean;
  email: string;
  activeThreadId?: string;
  onSignOut: () => void;
  onNavigate?: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const { openSettings } = useNotifications();

  return (
    <div className="flex h-full flex-col">
      <div className="px-2">
        <Logo />
      </div>

      <div className="mt-6 flex flex-col gap-1">
        <NavLink to="/" end onClick={onNavigate} className={navItemClass}>
          <SquarePen />
          New chat
        </NavLink>
        <NavLink to="/integrations" onClick={onNavigate} className={navItemClass}>
          <Plug />
          Integrations
        </NavLink>
      </div>

      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <div className="mb-1.5 px-3 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Chats
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          <ChatSessionList activeId={activeThreadId} onNavigate={onNavigate} />
        </div>
      </div>

      <div className="mt-3 shrink-0 border-t px-3 pt-3">
        <div className="mb-2 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Connections
        </div>
        {loading ? (
          <SidebarSkeleton />
        ) : (
          <div className="flex flex-col gap-2">
            {connectionRows(status).map((c) => (
              <Tooltip key={c.key}>
                <TooltipTrigger asChild>
                  <div className="flex cursor-default items-center gap-2 text-[13px]">
                    <span
                      className={cn('h-1.5 w-1.5 rounded-full', c.on ? 'bg-success' : 'bg-muted-foreground/40')}
                    />
                    <span className={c.on ? 'text-foreground' : 'text-muted-foreground'}>{c.label}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right">{c.on ? 'Connected' : 'Not connected'}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 shrink-0 border-t pt-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              <Avatar label={email} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={email}>
                {email}
              </span>
              <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width] min-w-56">
            <DropdownMenuItem onSelect={openSettings}>
              <Bell className="text-muted-foreground" />
              Notification settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            {THEME_OPTIONS.map((opt) => (
              <DropdownMenuItem key={opt.value} onSelect={() => setTheme(opt.value)}>
                <opt.icon className="text-muted-foreground" />
                <span className="flex-1">{opt.label}</span>
                {theme === opt.value ? <span className="h-1.5 w-1.5 rounded-full bg-foreground" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSignOut} className="text-destructive focus:text-destructive">
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function AppLayout() {
  const { api, session, signOut } = useAuth();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const online = useOnlineStatus();
  const activeThreadId = useMatch('/c/:threadId')?.params.threadId;

  const refreshStatus = useCallback(async (fresh = false) => {
    try {
      setStatus(await fetchIntegrationStatus(api, fresh));
    } catch {
      /* pages surface their own errors */
    } finally {
      setLoadingStatus(false);
    }
  }, [api]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Close the drawer on route change (Radix handles Escape + overlay + focus trap).
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const email = session?.user.email ?? 'Workspace';
  const anyConnected = connectionRows(status).some((c) => c.on);

  return (
    <RealtimeNotificationsProvider>
      <ChatSessionsProvider>
        <TooltipProvider delayDuration={200}>
        <div className="flex h-dvh overflow-hidden">
          {/* Desktop sidebar */}
          <aside className="hidden w-64 shrink-0 border-r bg-muted/40 px-4 py-6 sm:flex sm:flex-col">
            <SidebarContent
              status={status}
              loading={loadingStatus}
              email={email}
              activeThreadId={activeThreadId}
              onSignOut={() => void signOut()}
            />
          </aside>

          {/* Mobile drawer */}
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetContent side="left" className="flex flex-col px-4 py-6 safe-t">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SidebarContent
                status={status}
                loading={loadingStatus}
                email={email}
                activeThreadId={activeThreadId}
                onSignOut={() => void signOut()}
                onNavigate={() => setDrawerOpen(false)}
              />
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* Mobile top bar — fixed height, brand left, controls clustered right. */}
            <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur safe-t sm:hidden">
              <button
                aria-label="Open menu"
                onClick={() => setDrawerOpen(true)}
                className="-ml-1 inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Menu className="h-5 w-5" />
              </button>
              <Logo />
              <div className="ml-auto flex items-center gap-0.5">
                {!online ? (
                  <WifiOff className="mr-1 h-4 w-4 text-muted-foreground" aria-label="Offline" />
                ) : null}
                <NotificationBell />
                <ThemeToggle />
                <span
                  className={cn('ml-1 h-2 w-2 rounded-full', anyConnected ? 'bg-success' : 'bg-muted-foreground/40')}
                  title={anyConnected ? 'Integrations connected' : 'No integrations connected'}
                />
              </div>
            </header>

            {!online ? (
              <div className="hidden items-center justify-center gap-1.5 border-b bg-muted/60 py-1 text-xs text-muted-foreground sm:flex">
                <WifiOff className="h-3.5 w-3.5" />
                You're offline — showing cached data
              </div>
            ) : null}

            <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <Outlet context={{ status, loadingStatus, refreshStatus } satisfies AppOutletContext} />
            </main>
          </div>
        </div>
        </TooltipProvider>
      </ChatSessionsProvider>
    </RealtimeNotificationsProvider>
  );
}
