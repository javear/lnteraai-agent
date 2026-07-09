// The inline "activity timeline" for a Studio assistant turn — the file writes, terminal commands,
// git actions and thoughts the agent performs, rendered inline in the chat (Lovable / Claude-Code
// style) instead of a vague "using a tool" line + a separate terminal tab. Every item here is derived
// purely from the chat stream's tool-call / tool-result / reasoning events (see lib/chat.ts).
import type { ToolCallInfo, ToolResultInfo } from '../chat';

/** A file the agent created, overwrote, removed, or a directory it made. */
export interface FileActivity {
  kind: 'file';
  id: string;
  op: 'write' | 'delete' | 'mkdir';
  path: string;
}
/** A shell command — output fills in live (Phase 2) and/or from the tool result; exitCode finalizes it. */
export interface CommandActivity {
  kind: 'command';
  id: string;
  toolCallId?: string;
  command: string;
  output: string;
  exitCode: number | null;
  running: boolean;
}
/** A git action (commit/push/branch/checkout) — `detail` fills from the result (e.g. the short sha). */
export interface GitActivity {
  kind: 'git';
  id: string;
  toolCallId?: string;
  label: string;
  detail?: string;
  running: boolean;
}
/** A read-only inspection (read file, list tree, git status/diff/log) — shown as a subtle muted line. */
export interface ReadActivity {
  kind: 'read';
  id: string;
  label: string;
}
/** A reasoning ("thinking") block — collapsible; `durationMs` set once the block closes. */
export interface ThoughtActivity {
  kind: 'thought';
  id: string;
  text: string;
  startedAt: number;
  durationMs: number | null;
}
/** An in-chat request for the user to supply a credential (studio-request-secret). `status` flips to
 *  'saved' when the user submits the inline form — a UI-driven transition, not a tool-result one, since
 *  the tool call itself has no side effect (see studioRequestSecretTool). */
export interface SecretRequestActivity {
  kind: 'secret-request';
  id: string;
  name: string;
  description: string;
  status: 'pending' | 'saved';
}

export type StudioActivity =
  | FileActivity
  | CommandActivity
  | GitActivity
  | ReadActivity
  | ThoughtActivity
  | SecretRequestActivity;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Human-readable command line from a run-command tool call's args. */
function commandLine(args: Record<string, unknown> | undefined): string {
  const cmd = str(args?.command) ?? '';
  const parts = Array.isArray(args?.args) ? (args!.args as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  return [cmd, ...parts].join(' ').trim() || 'command';
}

/**
 * Map a starting tool call to its timeline item. Returns null for tools with no user-meaningful
 * activity. `id` is the timeline key; we reuse the toolCallId when present so a later tool-result can
 * find and finalize the same item.
 */
export function activityFromToolCall(info: ToolCallInfo): StudioActivity | null {
  const id = info.toolCallId ?? `act-${Math.random().toString(36).slice(2)}`;
  const a = info.args;
  switch (info.toolName) {
    case 'studio-write-file':
      return { kind: 'file', id, op: 'write', path: str(a?.path) ?? 'file' };
    case 'studio-delete-file':
      return { kind: 'file', id, op: 'delete', path: str(a?.path) ?? 'file' };
    case 'studio-mkdir':
      return { kind: 'file', id, op: 'mkdir', path: str(a?.path) ?? 'directory' };
    case 'studio-read-file':
      return { kind: 'read', id, label: `Read ${str(a?.path) ?? 'a file'}` };
    case 'studio-list-tree':
      return { kind: 'read', id, label: 'Listed the project files' };
    case 'studio-run-command':
      return { kind: 'command', id, toolCallId: info.toolCallId, command: commandLine(a), output: '', exitCode: null, running: true };
    case 'studio-git-commit':
      return { kind: 'git', id, toolCallId: info.toolCallId, label: 'Committing…', running: true };
    case 'studio-git-push':
      return { kind: 'git', id, toolCallId: info.toolCallId, label: 'Pushing…', running: true };
    case 'studio-git-create-branch':
      return { kind: 'git', id, toolCallId: info.toolCallId, label: `Created branch ${str(a?.name) ?? ''}`.trim(), running: false };
    case 'studio-git-checkout':
      return { kind: 'git', id, toolCallId: info.toolCallId, label: `Switched to ${str(a?.ref) ?? ''}`.trim(), running: false };
    case 'studio-git-status':
      return { kind: 'read', id, label: 'Checked what changed' };
    case 'studio-git-diff':
      return { kind: 'read', id, label: 'Reviewed the diff' };
    case 'studio-git-log':
      return { kind: 'read', id, label: 'Checked the history' };
    case 'studio-git-list-branches':
      return { kind: 'read', id, label: 'Checked the branches' };
    case 'studio-check-preview':
      return { kind: 'read', id, label: 'Checked the live preview' };
    case 'studio-deploy-preview':
      return { kind: 'git', id, toolCallId: info.toolCallId, label: 'Deploying preview…', running: true };
    case 'studio-request-secret':
      return { kind: 'secret-request', id, name: str(a?.name) ?? 'SECRET', description: str(a?.description) ?? '', status: 'pending' };
    default:
      return null;
  }
}

/** Apply a tool result to its matching timeline item (finalize a running command / git action). */
export function applyToolResult(activity: StudioActivity, info: ToolResultInfo): StudioActivity {
  // A failed call (the `tool-error` chunk) hands back a plain error STRING, not the tool's normal
  // `{exitCode, stdout}`/`{commit}` object — surface that string as the output/reason rather than
  // silently dropping it.
  const errorMessage = typeof info.result === 'string' ? info.result : undefined;
  const result = (typeof info.result === 'object' && info.result ? info.result : {}) as Record<string, unknown>;
  if (activity.kind === 'command') {
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : info.isError ? 1 : 0;
    // Prefer the result's stdout (authoritative + sentinel-stripped); fall back to the live-streamed
    // output, then to the error message itself if there's nothing else to show.
    const output = str(result.stdout) ?? (activity.output || errorMessage) ?? '';
    return { ...activity, running: false, exitCode, output };
  }
  if (activity.kind === 'git') {
    if (info.isError) {
      return { ...activity, running: false, label: activity.label.replace(/…$/, ' failed'), detail: errorMessage };
    }
    const commit = str(result.commit);
    if (activity.label.startsWith('Committing')) {
      return { ...activity, running: false, label: 'Committed', detail: commit ? commit.slice(0, 7) : undefined };
    }
    if (activity.label.startsWith('Pushing')) return { ...activity, running: false, label: 'Pushed' };
    if (activity.label.startsWith('Deploying')) return { ...activity, running: false, label: 'Preview deployed', detail: str(result.url) };
    return { ...activity, running: false };
  }
  return activity;
}
