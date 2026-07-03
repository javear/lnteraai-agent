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
import { fetchPinnableModels, type PinnableModel } from '../../lib/integrations';
import { Composer } from '../../components/chat/Composer';
import { MessageBubble, type ChatMessage } from '../../components/chat/Message';
import { parseSuggestions } from '../../lib/chat';
import { stripReasoning } from '../../lib/reasoning';
import { newStudioSessionId } from '../../lib/studio/session';
import { runStudioBridge } from '../../lib/studio/bridge';
import { BrowserPodProvider, type SandboxProvider } from '../../lib/studio/sandbox';
import { streamStudioChat } from '../../lib/studio/chat';
import { TerminalView } from './Terminal';

/** Map a Studio tool id to a plain-language noun that reads well after "Using …" in the thinking line. */
function friendlyTool(toolId: string): string {
  const id = toolId.toLowerCase();
  if (id.includes('git')) return 'Git';
  if (id.includes('run') || id.includes('command') || id.includes('exec')) return 'the terminal';
  if (id.includes('read') || id.includes('list') || id.includes('tree')) return 'the project files';
  return 'the editor';
}

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

  const resource =
    (session?.user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id ??
    session?.user.id ??
    'web:anon';
  const sessionId = useMemo(() => newStudioSessionId(), []);

  const providerRef = useRef<SandboxProvider | null>(null);
  const [status, setStatus] = useState<'booting' | 'ready' | 'error'>('booting');
  const [bootError, setBootError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [tab, setTab] = useState<'preview' | 'terminal'>('preview');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [proj, setProj] = useState<StudioProject>(project);
  const [gitWarning, setGitWarning] = useState<string | null>(null);
  const [models, setModels] = useState<PinnableModel[]>([]);
  const [pinnedModel, setPinnedModel] = useState(''); // '' = Auto (capable-model chain)
  const stopRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view as the conversation grows / streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Models the user can pin for the technical agent (their advanced BYOK Claude/GPT are ideal for
  // coding). Drop a stale pin if its provider is no longer connected.
  useEffect(() => {
    let cancelled = false;
    fetchPinnableModels(api)
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setPinnedModel((cur) => (cur && list.some((m) => m.modelCode === cur) ? cur : ''));
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Boot the sandbox, wire the bridge, and bring the repo into the pod (clone if empty).
  useEffect(() => {
    const provider = new BrowserPodProvider({ storageKey: project.id });
    providerRef.current = provider;
    const stopBridge = runStudioBridge({ api, sessionId, provider });
    const offPreview = provider.onPreview((url) => {
      setPreviewUrl(url);
      setTab('preview');
    });

    (async () => {
      // Boot the pod (a WASM VM — the slow part) and provision the Gitea repo/token concurrently;
      // neither depends on the other. Git itself runs as plain page JS against IndexedDB (see
      // lib/studio/git.ts), NOT inside the pod, so it only ever needs a same-origin fetch to our own
      // backend's git-proxy — never the pod's own (restricted) network stack. Git is still
      // best-effort: if it fails, the sandbox stays fully usable (chat/write/build/preview); only
      // cross-browser persistence is off.
      const [, initResult] = await Promise.all([
        provider.boot(),
        initProject(api, project.id).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
      ]);
      try {
        if (initResult instanceof Error) throw initResult;
        const cloneUrl = `${window.location.origin}${initResult.gitPath}`;
        await provider.gitClone(cloneUrl);
      } catch (e) {
        setGitWarning(e instanceof Error ? e.message : String(e));
      }
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

  async function send(text: string) {
    const content = text.trim();
    if (!content || streaming || status !== 'ready') return;
    setInput('');
    const startedAt = new Date().toISOString();
    const userId = newMsgId();
    const aiId = newMsgId();
    setMessages((m) => [
      ...m,
      { id: userId, role: 'user', content, createdAt: startedAt },
      { id: aiId, role: 'assistant', content: '', pending: true, tool: null, createdAt: startedAt },
    ]);
    setStreaming(true);
    stopRef.current = false;

    // Coalesce streaming re-renders (~90ms) so applying state + re-parsing markdown isn't O(n²) per
    // token — same technique as the business chat, which keeps it smooth. Only the changing message
    // re-renders because MessageBubble is memoized.
    let acc = '';
    let reasoningAcc = '';
    let lastRenderAt = 0;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    const THROTTLE = 90;
    const renderNow = () => {
      lastRenderAt = Date.now();
      setMessages((m) =>
        m.map((x) =>
          x.id === aiId
            ? { ...x, content: acc, pending: false, tool: null, ...(acc ? {} : { reasoning: reasoningAcc }) }
            : x,
        ),
      );
    };
    const scheduleRender = () => {
      const since = Date.now() - lastRenderAt;
      if (since >= THROTTLE) renderNow();
      else if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; renderNow(); }, THROTTLE - since);
    };

    await streamStudioChat(
      client,
      content,
      { threadId: project.id, resource, sessionId, kind: project.kind, pinnedModel: pinnedModel || undefined },
      {
        onText: (d) => {
          acc += d;
          scheduleRender();
        },
        onReasoning: (d) => {
          reasoningAcc += d;
          if (!acc) scheduleRender();
        },
        // Before any text, show a plain-language "Working on …" line (via the memoized bubble's
        // thinking indicator); once text streams, the tool line is replaced by the answer.
        onToolStart: (tool) =>
          setMessages((m) => m.map((x) => (x.id === aiId && !acc ? { ...x, tool: friendlyTool(tool) } : x))),
        onModel: (label) => setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, model: label } : x))),
        onError: (msg) =>
          setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: msg, pending: false, tool: null } : x))),
        onTripwire: (_c, reason) =>
          setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: reason, pending: false, tool: null } : x))),
      },
      () => stopRef.current,
    );

    if (renderTimer) clearTimeout(renderTimer);
    const body = parseSuggestions(stripReasoning(acc)).body;
    setMessages((m) =>
      m.map((x) => (x.id === aiId ? { ...x, content: body, pending: false, tool: null, reasoning: undefined } : x)),
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
      {gitWarning ? (
        <div className="px-4 pt-3">
          <Alert tone="neutral">
            Working without Git sync (changes won't persist across browsers yet). Details: {gitWarning}
          </Alert>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Chat */}
        <div className="flex w-[42%] min-w-[380px] flex-col border-r">
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5">
            {messages.length === 0 ? (
              <div className="mx-auto mt-6 max-w-sm text-center">
                <div className="text-[15px] font-medium">What should we build?</div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  Describe it in plain words — “a landing page for my bakery”, “add a contact form”. I'll
                  write the code; your app shows up in the preview on the right.
                </p>
              </div>
            ) : (
              messages.map((m) => <MessageBubble key={m.id} message={m} />)
            )}
          </div>
          <div className="px-2 pb-2">
            <Composer
              value={input}
              onChange={setInput}
              onSend={() => void send(input)}
              onStop={() => {
                stopRef.current = true;
                setStreaming(false);
              }}
              streaming={streaming}
              models={models}
              pinnedModel={pinnedModel}
              onPinModel={setPinnedModel}
            />
          </div>
        </div>

        {/* Preview / Logs */}
        <div className="flex min-w-0 flex-1 flex-col bg-muted/20">
          <div className="flex items-center gap-1 border-b bg-background px-3 py-2">
            {(['preview', 'terminal'] as const).map((tk) => (
              <button
                key={tk}
                onClick={() => setTab(tk)}
                className={`rounded-lg px-3 py-1 text-sm font-medium transition-colors ${
                  tab === tk ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tk === 'preview' ? 'Preview' : 'Logs'}
              </button>
            ))}
            {status === 'booting' ? (
              <span className="ml-2 text-xs text-muted-foreground">Starting your workspace…</span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 p-3">
            {tab === 'preview' ? (
              previewUrl ? (
                <iframe title="Preview" src={previewUrl} className="h-full w-full rounded-lg border bg-white shadow-sm" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
                  <span className="text-[15px] font-medium">Your app will appear here</span>
                  <span className="max-w-xs text-sm text-muted-foreground">
                    Once the agent builds and runs it, the live preview shows up automatically.
                  </span>
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
