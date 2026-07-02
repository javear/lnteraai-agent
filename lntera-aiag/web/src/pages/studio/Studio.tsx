import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '../../auth';
import { useMastra } from '../../lib/mastra';
import { Alert, Badge, Button, Card } from '../../ui';
import {
  connectMcpProject,
  createProject,
  deployProject,
  initProject,
  listProjects,
  type StudioProject,
  type StudioProjectKind,
} from '../../lib/studio/api';
import { newStudioSessionId } from '../../lib/studio/session';
import { runStudioBridge } from '../../lib/studio/bridge';
import { BrowserPodProvider, type SandboxProvider } from '../../lib/studio/sandbox';
import { streamStudioChat } from '../../lib/studio/chat';
import { TerminalView } from './Terminal';

type StudioMessage = { id: string; role: 'user' | 'assistant'; content: string; pending?: boolean };

export default function Studio() {
  const { session } = useAuth();
  const [projects, setProjects] = useState<StudioProject[] | null>(null);
  const [selected, setSelected] = useState<StudioProject | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1024);
  const { api } = useAuth();

  // BrowserPod needs cross-origin isolation (SharedArrayBuffer). The server sends COOP/COEP only on the
  // /studio document, so if we arrived via client-side nav from a non-isolated page, hard-reload once to
  // fetch the isolated document. 'failed' means the headers aren't being served (deployment gap).
  const [coi] = useState<'ok' | 'reloading' | 'failed'>(() => {
    if (typeof window === 'undefined' || window.crossOriginIsolated) return 'ok';
    return sessionStorage.getItem('studio-coi-reload') ? 'failed' : 'reloading';
  });
  useEffect(() => {
    if (coi === 'ok') {
      sessionStorage.removeItem('studio-coi-reload');
    } else if (coi === 'reloading') {
      sessionStorage.setItem('studio-coi-reload', '1');
      window.location.reload();
    }
  }, [coi]);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const reload = useCallback(() => {
    void listProjects(api)
      .then(setProjects)
      .catch((e) => {
        setProjects([]);
        toast.error(e instanceof Error ? e.message : String(e));
      });
  }, [api]);

  useEffect(() => reload(), [reload]);

  if (narrow) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">Studio is desktop-only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The builder runs your project inside this browser and needs a larger screen. Open Studio on a
          desktop browser to continue.
        </p>
      </div>
    );
  }

  if (coi === 'reloading') {
    return <div className="px-6 py-16 text-center text-sm text-muted-foreground">Preparing Studio…</div>;
  }
  if (coi === 'failed') {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">Studio can't start here</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The in-browser sandbox needs cross-origin isolation, which requires the <code>/studio</code> page
          to be served with COOP/COEP headers. If you're seeing this in production, those headers aren't
          being sent yet.
        </p>
      </div>
    );
  }

  if (selected) {
    return <Workspace key={selected.id} project={selected} onBack={() => { setSelected(null); reload(); }} />;
  }

  return (
    <ProjectList
      projects={projects}
      onOpen={setSelected}
      onCreate={async (name, kind) => {
        try {
          const p = await createProject(api, { name, kind });
          setSelected(p);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
        }
      }}
      hasSession={Boolean(session)}
    />
  );
}

function ProjectList({
  projects,
  onOpen,
  onCreate,
  hasSession,
}: {
  projects: StudioProject[] | null;
  onOpen: (p: StudioProject) => void;
  onCreate: (name: string, kind: StudioProjectKind) => void;
  hasSession: boolean;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<StudioProjectKind>('webapp');

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Studio</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">
        Describe what you want and the technical agent builds it — a web app for your business, or an MCP
        extension for your assistant. Everything runs in your browser.
      </p>

      <Card className="mt-6">
        <div className="text-sm font-semibold">New project</div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My storefront"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Type</label>
            <div className="mt-1 flex gap-2">
              <Button variant={kind === 'webapp' ? 'primary' : 'secondary'} onClick={() => setKind('webapp')}>
                Web app
              </Button>
              <Button variant={kind === 'mcp' ? 'primary' : 'secondary'} onClick={() => setKind('mcp')}>
                Assistant extension (MCP)
              </Button>
            </div>
          </div>
          <Button disabled={!name.trim() || !hasSession} onClick={() => onCreate(name.trim(), kind)}>
            Create
          </Button>
        </div>
      </Card>

      <div className="mt-6 grid gap-3">
        {projects === null ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="text-sm text-muted-foreground">No projects yet — create one above.</div>
        ) : (
          projects.map((p) => (
            <Card key={p.id} className="flex items-center justify-between transition-shadow hover:shadow-md">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <Badge tone="neutral">{p.kind === 'mcp' ? 'MCP' : 'Web app'}</Badge>
                  <Badge tone={p.status === 'connected' || p.status === 'deployed' ? 'success' : 'neutral'}>
                    {p.status}
                  </Badge>
                </div>
                {p.deploy_url || p.mcp_url ? (
                  <a
                    href={p.deploy_url ?? p.mcp_url ?? '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-muted-foreground underline"
                  >
                    {p.deploy_url ?? p.mcp_url}
                  </a>
                ) : null}
              </div>
              <Button variant="secondary" onClick={() => onOpen(p)}>
                Open
              </Button>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

let msgSeq = 0;
const newMsgId = () => `sm${++msgSeq}-${Date.now()}`;

function Workspace({ project, onBack }: { project: StudioProject; onBack: () => void }) {
  const { session, api } = useAuth();
  const client = useMastra();
  const supabase = useAuth().supabase;

  const resource =
    (session?.user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id ??
    session?.user.id ??
    'web:anon';
  const tenantId = (session?.user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id ?? '';
  const authToken = session?.access_token ?? '';
  const sessionId = useMemo(() => newStudioSessionId(), []);

  const providerRef = useRef<SandboxProvider | null>(null);
  const [status, setStatus] = useState<'booting' | 'ready' | 'error'>('booting');
  const [bootError, setBootError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [tab, setTab] = useState<'preview' | 'terminal'>('terminal');
  const [messages, setMessages] = useState<StudioMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [proj, setProj] = useState<StudioProject>(project);
  const stopRef = useRef(false);

  // Boot the sandbox, wire the bridge, and bring the repo into the pod (clone if empty).
  useEffect(() => {
    const provider = new BrowserPodProvider({ storageKey: project.id });
    providerRef.current = provider;
    const stopBridge = runStudioBridge({ supabase, authToken, tenantId, sessionId, provider });
    const offPreview = provider.onPreview((url) => {
      setPreviewUrl(url);
      setTab('preview');
    });

    (async () => {
      await provider.boot();
      const { cloneUrl } = await initProject(api, project.id);
      const hasGit = (await provider.exec('test', ['-d', '.git'])).exitCode === 0;
      if (!hasGit) await provider.gitClone(cloneUrl);
      await provider.exec('git', ['config', 'user.email', 'studio@lntera.ai']);
      await provider.exec('git', ['config', 'user.name', 'Lntera Studio']);
      setStatus('ready');
    })().catch((e) => {
      setBootError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    });

    return () => {
      offPreview();
      stopBridge();
      void provider.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const subscribeOutput = useCallback(
    (cb: (chunk: string) => void) => providerRef.current?.subscribeOutput(cb) ?? (() => undefined),
    [],
  );

  async function send() {
    const text = input.trim();
    if (!text || streaming || status !== 'ready') return;
    setInput('');
    const userId = newMsgId();
    const aiId = newMsgId();
    setMessages((m) => [
      ...m,
      { id: userId, role: 'user', content: text },
      { id: aiId, role: 'assistant', content: '', pending: true },
    ]);
    setStreaming(true);
    stopRef.current = false;
    let acc = '';
    await streamStudioChat(
      client,
      text,
      { threadId: project.id, resource, sessionId, kind: project.kind },
      {
        onText: (d) => {
          acc += d;
          setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: acc, pending: false } : x)));
        },
        onToolStart: (tool) =>
          setMessages((m) =>
            m.map((x) => (x.id === aiId && !acc ? { ...x, content: `⚙️ ${tool}…`, pending: true } : x)),
          ),
        onError: (msg) =>
          setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: msg, pending: false } : x))),
        onTripwire: (_c, reason) =>
          setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: reason, pending: false } : x))),
      },
      () => stopRef.current,
    );
    setStreaming(false);
  }

  async function publish() {
    const provider = providerRef.current;
    if (!provider || publishing) return;
    setPublishing(true);
    setTab('terminal');
    try {
      const install = await provider.exec('npm', ['install']);
      if (install.exitCode !== 0) throw new Error('npm install failed — check the terminal.');
      const build = await provider.exec('npm', ['run', 'build']);
      if (build.exitCode !== 0) throw new Error('Build failed — check the terminal.');
      const { zipBase64 } = await provider.buildZip('dist');
      const { project: updated, url } = await deployProject(api, project.id, zipBase64);
      setProj(updated);
      toast.success(`Published: ${url}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  }

  async function connect() {
    try {
      const updated = await connectMcpProject(api, project.id);
      setProj(updated);
      toast.success('Connected to your assistant.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const liveUrl = proj.deploy_url ?? proj.mcp_url ?? null;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <Button variant="ghost" onClick={onBack}>
          ← Projects
        </Button>
        <span className="font-medium">{proj.name}</span>
        <Badge tone="neutral">{proj.kind === 'mcp' ? 'MCP' : 'Web app'}</Badge>
        <span className="text-xs text-muted-foreground">
          {status === 'booting' ? 'Starting sandbox…' : status === 'error' ? 'Sandbox error' : 'Ready'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {liveUrl ? (
            <a href={liveUrl} target="_blank" rel="noreferrer" className="text-xs underline">
              {proj.kind === 'mcp' ? 'MCP endpoint' : 'Live site'} ↗
            </a>
          ) : null}
          <Button variant="secondary" disabled={publishing || status !== 'ready'} onClick={publish}>
            {publishing ? 'Publishing…' : 'Publish'}
          </Button>
          {proj.kind === 'mcp' && proj.status === 'deployed' ? (
            <Button onClick={connect}>Connect to my assistant</Button>
          ) : null}
        </div>
      </div>

      {bootError ? (
        <div className="px-4 pt-3">
          <Alert tone="error">{bootError}</Alert>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Chat */}
        <div className="flex w-[42%] min-w-[360px] flex-col border-r">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Tell the agent what to build. It writes files, runs commands, and commits — you'll see the
                terminal and preview update on the right.
              </p>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    m.role === 'user'
                      ? 'ml-auto max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground'
                      : 'max-w-[95%] whitespace-pre-wrap rounded-2xl bg-muted px-3 py-2 text-sm'
                  }
                >
                  {m.content || (m.pending ? '…' : '')}
                </div>
              ))
            )}
          </div>
          <div className="border-t p-3">
            <div className="flex items-end gap-2">
              <textarea
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={status === 'ready' ? 'Describe a change…' : 'Waiting for the sandbox…'}
                disabled={status !== 'ready' || streaming}
                className="max-h-40 flex-1 resize-none rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              />
              <Button disabled={!input.trim() || streaming || status !== 'ready'} onClick={() => void send()}>
                Send
              </Button>
            </div>
          </div>
        </div>

        {/* Preview / Terminal */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex gap-1 border-b px-3 py-2">
            <Button variant={tab === 'preview' ? 'primary' : 'ghost'} onClick={() => setTab('preview')}>
              Preview
            </Button>
            <Button variant={tab === 'terminal' ? 'primary' : 'ghost'} onClick={() => setTab('terminal')}>
              Terminal
            </Button>
          </div>
          <div className="min-h-0 flex-1 p-3">
            {tab === 'preview' ? (
              previewUrl ? (
                <iframe title="Preview" src={previewUrl} className="h-full w-full rounded-lg border bg-white" />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No preview yet — ask the agent to start the dev server.
                </div>
              )
            ) : (
              <TerminalView subscribe={subscribeOutput} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
