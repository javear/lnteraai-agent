// The "MCP Tester" — what an MCP project shows in the Preview pane instead of a blank apology.
// An MCP server has no visual UI, but it DOES have a testable surface: its own tools/list. This
// panel asks the deployed server what tools it offers, renders a plain form for each one straight
// from the tool's own input schema, and lets the user run it and see the live response — a mini
// Postman scoped to their assistant extension, no technical knowledge required.
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from '../../ui';
import { mcpCall, type McpToolDef } from '../../lib/studio/api';

type Api = (path: string, init?: RequestInit) => Promise<Response>;

interface ToolRun {
  running: boolean;
  output: string | null;
  isError: boolean;
}

/** Pull display text out of a tools/call result (MCP returns a content array of typed blocks). */
function renderCallResult(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
  if (Array.isArray(r?.content)) {
    const texts = r!.content.map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
    if (texts) return texts;
  }
  return JSON.stringify(result, null, 2);
}

/** Coerce one form field's raw string to the type its schema declares. */
function coerceValue(raw: string, type: string | undefined): unknown {
  if (type === 'number' || type === 'integer') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === 'boolean') return raw === 'true';
  if (type === 'object' || type === 'array') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function ToolCard({ api, projectId, tool }: { api: Api; projectId: string; tool: McpToolDef }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [run, setRun] = useState<ToolRun>({ running: false, output: null, isError: false });
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);

  const invoke = async () => {
    setRun({ running: true, output: null, isError: false });
    try {
      const args: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(props)) {
        const raw = values[key];
        if (raw === undefined || raw === '') continue;
        args[key] = coerceValue(raw, spec.type);
      }
      const { response } = await mcpCall(api, projectId, 'tools/call', { name: tool.name, arguments: args });
      if (response.error) {
        setRun({ running: false, output: response.error.message ?? 'The tool returned an error.', isError: true });
      } else {
        setRun({ running: false, output: renderCallResult(response.result), isError: false });
      }
    } catch (e) {
      setRun({ running: false, output: e instanceof Error ? e.message : String(e), isError: true });
    }
  };

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-sm font-semibold">{tool.name}</div>
          {tool.description ? <div className="mt-0.5 text-xs text-muted-foreground">{tool.description}</div> : null}
        </div>
        <Button variant="secondary" disabled={run.running} onClick={() => void invoke()}>
          {run.running ? 'Running…' : 'Run'}
        </Button>
      </div>

      {Object.keys(props).length > 0 ? (
        <div className="mt-3 grid gap-2">
          {Object.entries(props).map(([key, spec]) => (
            <div key={key}>
              <label className="text-xs text-muted-foreground">
                {key}
                {required.has(key) ? ' *' : ''}
                {spec.description ? ` — ${spec.description}` : ''}
              </label>
              {spec.type === 'boolean' ? (
                <select
                  value={values[key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">—</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  value={values[key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  placeholder={spec.type === 'object' || spec.type === 'array' ? '{ JSON }' : spec.type ?? 'text'}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              )}
            </div>
          ))}
        </div>
      ) : null}

      {run.output !== null ? (
        <pre
          className={`mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border p-2 font-mono text-xs ${
            run.isError ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'bg-muted/40'
          }`}
        >
          {run.output}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * Lists the deployed MCP server's tools and lets the user try each one live. Only meaningful once
 * the project is published (`mcp_url` set) — the parent gates on that.
 */
export function McpTester({ api, projectId }: { api: Api; projectId: string }) {
  const [tools, setTools] = useState<McpToolDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { response } = await mcpCall(api, projectId, 'tools/list');
      if (response.error) throw new Error(response.error.message ?? 'The server returned an error.');
      const list = (response.result as { tools?: McpToolDef[] } | undefined)?.tools;
      setTools(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTools(null);
    } finally {
      setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Try your assistant extension</div>
          <div className="text-xs text-muted-foreground">
            These are the tools your extension offers — run any of them to see a live response.
          </div>
        </div>
        <Button variant="ghost" disabled={loading} onClick={() => void load()}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {tools === null && !error ? (
          <div className="text-sm text-muted-foreground">Asking your extension what it can do…</div>
        ) : tools && tools.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            Your extension doesn't offer any tools yet — ask the agent to add one, then publish again.
          </div>
        ) : (
          (tools ?? []).map((t) => <ToolCard key={t.name} api={api} projectId={projectId} tool={t} />)
        )}
      </div>
    </div>
  );
}
