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
import { StudioMessageBubble, type StudioChatMessage } from '../../components/studio/StudioMessage';
import { newStudioSessionId } from '../../lib/studio/session';
import { runStudioBridge } from '../../lib/studio/bridge';
import { BrowserPodProvider, type DevServerUpdate, type SandboxProvider } from '../../lib/studio/sandbox';
import { streamStudioChat } from '../../lib/studio/chat';
import type { StreamHandlers } from '../../lib/chat';
import {
  activityFromToolCall,
  applyToolResult,
  type CommandActivity,
  type StudioActivity,
  type ThoughtActivity,
} from '../../lib/studio/activity';

/** Strip our exec sentinel (see sandbox.ts) out of raw terminal chunks before showing them inline. */
const SENTINEL_STRIP = /__BP_EXIT__-?\d+\s*/g;
let actSeq = 0;
const newActId = () => `pa-${++actSeq}`;

/**
 * Pick the right `npm run dev` args for whatever dev server this project actually has. The current
 * starter template is Next.js, but a project created before that template existed (hand-scaffolded
 * by an earlier agent) may still be Vite-based — each needs a different host-binding flag for
 * BrowserPod's port detection to see it, and passing the wrong one could error out or hang. Returns
 * null for anything we don't recognize, so the caller can skip starting a dev server entirely rather
 * than guess.
 */
async function resolveDevServerArgs(provider: SandboxProvider): Promise<string[] | null> {
  try {
    const pkg = JSON.parse(await provider.readFile('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) return ['run', 'dev', '--', '-H', '0.0.0.0'];
    if (deps.vite) return ['run', 'dev', '--', '--host', '0.0.0.0'];
    return null;
  } catch {
    return null;
  }
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
  const [devServer, setDevServer] = useState<{ status: 'idle' | 'starting' | 'exited'; exitCode: number | null }>({
    status: 'idle',
    exitCode: null,
  });
  const [devOutput, setDevOutput] = useState('');
  const [messages, setMessages] = useState<StudioChatMessage[]>([]);
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
    const offPreview = provider.onPreview((url) => setPreviewUrl(url));
    const offDevServer = provider.onDevServerUpdate((update: DevServerUpdate) => {
      setDevServer({ status: update.status, exitCode: update.exitCode });
      // A fresh 'starting' event with no chunk marks a new run — clear the previous run's tail.
      if (update.status === 'starting' && update.chunk === undefined) setDevOutput('');
      else if (update.chunk) setDevOutput((prev) => (prev + update.chunk).slice(-4000));
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
      let cloned = false;
      try {
        if (initResult instanceof Error) throw initResult;
        const cloneUrl = `${window.location.origin}${initResult.gitPath}`;
        await provider.gitClone(cloneUrl);
        cloned = true;
      } catch (e) {
        setGitWarning(e instanceof Error ? e.message : String(e));
      }
      setStatus('ready');

      // Webapp projects get a live local preview: install once, then run the dev server in the
      // background so BrowserPod's port detection (onPreview) picks it up. Best-effort — errors
      // surface through devServer/devOutput state in the Preview pane, not a blocking boot error.
      // MCP projects have no dev server (an edge function, not a visual app) — nothing to start.
      if (cloned && project.kind === 'webapp') {
        void (async () => {
          try {
            const install = await provider.exec('npm', ['install']);
            if (install.exitCode !== 0) return;
            const devArgs = await resolveDevServerArgs(provider);
            if (!devArgs) return; // unrecognized dev tooling — leave the Preview pane on its default placeholder
            await provider.startDevServer('npm', devArgs);
          } catch {
            // best-effort — see comment above
          }
        })();
      }
    })().catch((e) => {
      setBootError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    });

    return () => {
      offPreview();
      offDevServer();
      stopBridge();
      void provider.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || streaming || status !== 'ready') return;
    setInput('');
    const startedAt = new Date().toISOString();
    const userId = newMsgId();
    const aiId = newMsgId();
    setMessages((m) => [
      ...m,
      { id: userId, role: 'user', content, createdAt: startedAt, activity: [] },
      { id: aiId, role: 'assistant', content: '', pending: true, createdAt: startedAt, activity: [] },
    ]);
    setStreaming(true);
    stopRef.current = false;

    // The turn's accumulating state. `activity` is rebuilt immutably on each change so the memoized
    // bubble re-renders; item ids stay stable so per-card UI state (expand/collapse) survives.
    let acc = '';
    let activity: StudioActivity[] = [];
    let currentThought: ThoughtActivity | null = null;
    let runningCmdId: string | null = null;

    let lastRenderAt = 0;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    const THROTTLE = 90;
    const renderNow = () => {
      lastRenderAt = Date.now();
      const snapshot = [...activity];
      setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: acc, pending: false, activity: snapshot } : x)));
    };
    const scheduleRender = () => {
      const since = Date.now() - lastRenderAt;
      if (since >= THROTTLE) renderNow();
      else if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; renderNow(); }, THROTTLE - since);
    };
    const updateItem = (id: string, fn: (a: StudioActivity) => StudioActivity) => {
      activity = activity.map((a) => (a.id === id ? fn(a) : a));
    };
    // A thought block stays open across consecutive reasoning deltas; it "closes" (its duration is
    // stamped) as soon as the agent does something else — a tool call or user-facing text.
    const closeThought = () => {
      if (!currentThought) return;
      const started = currentThought.startedAt;
      updateItem(currentThought.id, (a) => ({ ...a, durationMs: Date.now() - started }));
      currentThought = null;
    };

    // Live terminal output: the sandbox streams ALL command output here. Since exec is serialized and
    // only run-command sets `runningCmdId`, chunks during that window belong to that command. The final
    // (sentinel-stripped) output still comes from the tool result, so this is purely for live feel.
    const offOutput = providerRef.current?.subscribeOutput((chunk) => {
      if (!runningCmdId) return;
      const clean = chunk.replace(SENTINEL_STRIP, '');
      if (!clean) return;
      updateItem(runningCmdId, (a) => (a.kind === 'command' ? { ...a, output: a.output + clean } : a));
      scheduleRender();
    });

    // Auto-continue: a turn that ends with reason 'tool-calls' or 'length' was CUT OFF mid-work
    // (step or token limit), not finished — the agent still had things to do. Instead of leaving a
    // half-done task and waiting for the user to type "continue" (a recurring confusion), quietly
    // resume it in the same bubble, bounded so a pathological loop can't run away.
    const MAX_AUTO_CONTINUES = 2;
    const CONTINUE_PROMPT =
      'Continue exactly where you left off on my previous request. Do not repeat work already done — pick up the remaining steps and finish, then verify as usual.';
    let finishReason: string | undefined;

    const handlers: StreamHandlers = {
          onFinish: (reason) => {
            finishReason = reason;
          },
          onText: (d) => {
            closeThought();
            acc += d;
            scheduleRender();
          },
          onReasoning: (d) => {
            if (currentThought) {
              updateItem(currentThought.id, (a) => (a.kind === 'thought' ? { ...a, text: a.text + d } : a));
            } else {
              const t: ThoughtActivity = { kind: 'thought', id: newActId(), text: d, startedAt: Date.now(), durationMs: null };
              currentThought = t;
              activity = [...activity, t];
            }
            scheduleRender();
          },
          onToolStart: (info) => {
            closeThought();
            const item = activityFromToolCall(info);
            if (!item) return;
            activity = [...activity, item];
            if (item.kind === 'command' && item.running) runningCmdId = item.id;
            scheduleRender();
          },
          onToolResult: (info) => {
            // Correlate by toolCallId; fall back to the last still-running command/git item.
            const targetId =
              (info.toolCallId && activity.find((a) => a.id === info.toolCallId)?.id) ??
              [...activity].reverse().find((a) => (a.kind === 'command' || a.kind === 'git') && a.running)?.id;
            if (!targetId) return;
            updateItem(targetId, (a) => applyToolResult(a, info));
            if (targetId === runningCmdId) runningCmdId = null;
            scheduleRender();
          },
          onModel: (label) => setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, model: label } : x))),
          onError: (msg) => {
            acc = msg;
            scheduleRender();
          },
          onTripwire: (_c, reason) => {
            acc = reason;
            scheduleRender();
          },
    };

    try {
      let prompt = content;
      for (let round = 0; ; round++) {
        finishReason = undefined;
        await streamStudioChat(
          client,
          prompt,
          { threadId: project.id, resource, sessionId, kind: project.kind, pinnedModel: pinnedModel || undefined },
          handlers,
          () => stopRef.current,
        );
        const cutOff = finishReason === 'tool-calls' || finishReason === 'length';
        if (!cutOff || stopRef.current || round >= MAX_AUTO_CONTINUES) break;
        if (acc && !acc.endsWith('\n\n')) acc += '\n\n';
        prompt = CONTINUE_PROMPT;
      }
    } finally {
      offOutput?.();
    }

    if (renderTimer) clearTimeout(renderTimer);
    closeThought();
    // Finalize any item still marked running (e.g. the user hit Stop mid-command).
    activity = activity.map((a) =>
      (a.kind === 'command' || a.kind === 'git') && a.running ? { ...a, running: false } : a,
    );
    const finalActivity = activity;
    setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: acc, pending: false, activity: finalActivity } : x)));
    setStreaming(false);
  }

  async function publish() {
    const provider = providerRef.current;
    if (!provider || publishing) return;
    setPublishing(true);

    // Publish is a button, not an agent turn — but its install/build output belongs in the same inline
    // timeline (there's no separate Logs tab anymore), so we render it as a synthetic assistant message
    // and stream each command's output straight into its card via exec's onOutput.
    const aiId = newMsgId();
    const cmd = (id: string, command: string): CommandActivity => ({ kind: 'command', id, command, output: '', exitCode: null, running: true });
    setMessages((m) => [...m, { id: aiId, role: 'assistant', content: '', createdAt: new Date().toISOString(), activity: [] }]);
    const addCmd = (id: string, command: string) =>
      setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, activity: [...x.activity, cmd(id, command)] } : x)));
    const patchCmd = (id: string, fn: (a: CommandActivity) => CommandActivity) =>
      setMessages((m) =>
        m.map((x) =>
          x.id === aiId ? { ...x, activity: x.activity.map((a) => (a.id === id && a.kind === 'command' ? fn(a) : a)) } : x,
        ),
      );
    const setBody = (body: string) => setMessages((m) => m.map((x) => (x.id === aiId ? { ...x, content: body } : x)));
    const runStep = async (id: string, command: string, args: string[]): Promise<number> => {
      addCmd(id, [command, ...args].join(' '));
      const r = await provider.exec(command, args, { onOutput: (c) => patchCmd(id, (a) => ({ ...a, output: a.output + c })) });
      patchCmd(id, (a) => ({ ...a, running: false, exitCode: r.exitCode }));
      return r.exitCode;
    };

    try {
      // "mcp" projects are a single EdgeOne Pages Function with no build step at all (the template's
      // package.json has no "build" script — EdgeOne transpiles the TypeScript at the edge) — deploy
      // the project root as-is. "webapp" is a Next.js static export, built to "out/".
      let zipBase64: string;
      if (project.kind === 'mcp') {
        setBody('Packaging your MCP server…');
        zipBase64 = (await provider.buildZip('.')).zipBase64;
      } else {
        if ((await runStep(newActId(), 'npm', ['install'])) !== 0) throw new Error('Install failed — see the log above.');
        if ((await runStep(newActId(), 'npm', ['run', 'build'])) !== 0) throw new Error('Build failed — see the log above.');
        zipBase64 = (await provider.buildZip('out')).zipBase64;
      }

      const { project: updated, url } = await deployProject(api, project.id, zipBase64);
      setProj(updated);
      setBody(`✅ Published — your project is live at ${url}`);
      toast.success(`Published: ${url}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBody(msg);
      toast.error(msg);
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
              messages.map((m) => <StudioMessageBubble key={m.id} message={m} />)
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

        {/* Live preview — the agent's file writes, terminal output and git actions now stream inline in
            the chat (left), so this pane is just the running app. */}
        <div className="flex min-w-0 flex-1 flex-col bg-muted/20">
          <div className="flex items-center gap-2 border-b bg-background px-3 py-2">
            <span className="text-sm font-medium">Preview</span>
            {status === 'booting' ? (
              <span className="text-xs text-muted-foreground">Starting your workspace…</span>
            ) : project.kind === 'webapp' && devServer.status === 'starting' && !previewUrl ? (
              <span className="text-xs text-muted-foreground">Starting dev server…</span>
            ) : project.kind === 'webapp' && devServer.status === 'exited' ? (
              <span className="text-xs text-destructive">Dev server stopped (exit {devServer.exitCode})</span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 p-3">
            {previewUrl ? (
              <iframe title="Preview" src={previewUrl} className="h-full w-full rounded-lg border bg-white shadow-sm" />
            ) : project.kind === 'webapp' && devServer.status === 'exited' ? (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <Alert tone="error">The dev server stopped unexpectedly (exit code {devServer.exitCode}).</Alert>
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border bg-background p-3 font-mono text-xs">
                  {devOutput || 'No output captured.'}
                </pre>
              </div>
            ) : project.kind === 'webapp' && devServer.status === 'starting' ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
                <span className="text-[15px] font-medium">Starting your dev server…</span>
                <span className="max-w-xs text-sm text-muted-foreground">
                  This usually takes a few seconds the first time.
                </span>
              </div>
            ) : project.kind === 'mcp' ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
                <span className="text-[15px] font-medium">MCP extensions have no visual preview</span>
                <span className="max-w-xs text-sm text-muted-foreground">
                  Publish, then connect it to your assistant to try it out.
                </span>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
                <span className="text-[15px] font-medium">Your app will appear here</span>
                <span className="max-w-xs text-sm text-muted-foreground">
                  Once the agent builds and runs it, the live preview shows up automatically.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
