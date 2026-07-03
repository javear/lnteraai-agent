// Studio Workspace tools (arch A): the technical agent calls these server-side, but each one is a
// thin RPC to the user's browser (where the code lives in a BrowserPod) via the Realtime bridge.
// The agent never touches a local filesystem — write/read/exec/git all execute in the browser.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requireTenantContext, TENANT_MASTER_ID_KEY } from '../shared/marketplace-auth';
import { getStudioBridge } from './browser-bridge';
import { STUDIO_SESSION_ID_KEY } from './protocol';

type ToolContext = Parameters<typeof requireTenantContext>[0];

/** Read the active Studio session (browser tab) id from requestContext. */
function requireStudioSession(context: ToolContext): string {
  const raw = context?.requestContext?.get(STUDIO_SESSION_ID_KEY);
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `Missing "${STUDIO_SESSION_ID_KEY}" in requestContext — open the Studio to start a session.`,
    );
  }
  return raw.trim();
}

const requestContextSchema = z.object({
  [TENANT_MASTER_ID_KEY]: z.string().uuid().describe('UUID of the active tenant_master row.'),
  [STUDIO_SESSION_ID_KEY]: z.string().min(1).describe('Active Studio browser session id.'),
});

/**
 * Cap how much of a command's output the AGENT sees (the browser UI still shows the full thing —
 * see StudioActivity.tsx, which reads the sandbox's own live output stream, not this). A single
 * verbose `npm install`/build dump can otherwise burn a big chunk of the technical agent's turn
 * budget by itself, in the tool result of just ONE call. Keeps head + tail — installs are noisy up
 * front, but a build failure's actual error is almost always at the end.
 */
const MAX_EXEC_OUTPUT_CHARS = 6000;
function truncateForAgent(text: string): string {
  if (text.length <= MAX_EXEC_OUTPUT_CHARS) return text;
  const headLen = 1500;
  const tailLen = MAX_EXEC_OUTPUT_CHARS - headLen;
  const omitted = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(-tailLen)}`;
}

export const studioWriteFileTool = createTool({
  id: 'studio-write-file',
  strict: false,
  description:
    'Create or overwrite a file in the project (runs in the user\'s browser workspace). Use for all code/config/content changes.',
  requestContextSchema,
  inputSchema: z.object({
    path: z.string().min(1).describe('Project-relative file path, e.g. src/index.ts'),
    content: z.string().describe('Full file contents to write.'),
  }),
  outputSchema: z.object({ ok: z.literal(true) }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    await getStudioBridge().call(tenantId, sessionId, {
      op: 'writeFile',
      path: input.path,
      content: input.content,
    });
    return { ok: true as const };
  },
});

export const studioReadFileTool = createTool({
  id: 'studio-read-file',
  strict: false,
  description: 'Read a file\'s contents from the project workspace.',
  requestContextSchema,
  inputSchema: z.object({ path: z.string().min(1) }),
  outputSchema: z.object({ content: z.string() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    return getStudioBridge().call(tenantId, sessionId, { op: 'readFile', path: input.path });
  },
});

export const studioListTreeTool = createTool({
  id: 'studio-list-tree',
  strict: false,
  description: 'List files and directories in the project (optionally under a subpath).',
  requestContextSchema,
  inputSchema: z.object({ path: z.string().optional().describe('Optional subdirectory to list.') }),
  outputSchema: z.object({
    entries: z.array(z.object({ path: z.string(), type: z.enum(['file', 'dir']) })),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    return getStudioBridge().call(tenantId, sessionId, { op: 'listTree', path: input.path });
  },
});

export const studioDeleteFileTool = createTool({
  id: 'studio-delete-file',
  strict: false,
  description: 'Delete a file or directory from the project workspace.',
  requestContextSchema,
  inputSchema: z.object({ path: z.string().min(1) }),
  outputSchema: z.object({ ok: z.literal(true) }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    await getStudioBridge().call(tenantId, sessionId, { op: 'deleteFile', path: input.path });
    return { ok: true as const };
  },
});

export const studioMkdirTool = createTool({
  id: 'studio-mkdir',
  strict: false,
  description: 'Create a directory (recursively) in the project workspace.',
  requestContextSchema,
  inputSchema: z.object({ path: z.string().min(1) }),
  outputSchema: z.object({ ok: z.literal(true) }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    await getStudioBridge().call(tenantId, sessionId, { op: 'mkdir', path: input.path });
    return { ok: true as const };
  },
});

export const studioRunCommandTool = createTool({
  id: 'studio-run-command',
  strict: false,
  description:
    'Run a shell command in the project workspace (e.g. `npm install`, `npm run build`, `npm test`) and get its exit code + output. Runs in the user\'s browser, not on the server.',
  requestContextSchema,
  inputSchema: z.object({
    command: z.string().min(1).describe('Executable, e.g. "npm".'),
    args: z.array(z.string()).optional().describe('Arguments; each is shell-quoted automatically.'),
    cwd: z.string().optional().describe('Working directory relative to the project root.'),
  }),
  outputSchema: z.object({
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    const result = await getStudioBridge().call(tenantId, sessionId, {
      op: 'execCommand',
      command: input.command,
      args: input.args,
      cwd: input.cwd,
    });
    return { ...result, stdout: truncateForAgent(result.stdout), stderr: truncateForAgent(result.stderr) };
  },
});

export const studioGitCommitTool = createTool({
  id: 'studio-git-commit',
  strict: false,
  description: 'Stage all changes and commit them in the project repo.',
  requestContextSchema,
  inputSchema: z.object({ message: z.string().min(1).describe('Commit message.') }),
  outputSchema: z.object({ commit: z.string() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    return getStudioBridge().call(tenantId, sessionId, { op: 'gitCommit', message: input.message });
  },
});

export const studioGitPushTool = createTool({
  id: 'studio-git-push',
  strict: false,
  description: 'Push committed changes to the project\'s Gitea remote (saves work across browsers).',
  requestContextSchema,
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.literal(true) }),
  execute: async (_input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    await getStudioBridge().call(tenantId, sessionId, { op: 'gitPush' });
    return { ok: true as const };
  },
});

export const studioGitStatusTool = createTool({
  id: 'studio-git-status',
  strict: false,
  description:
    'List files changed since the last commit (added/modified/deleted). Local only — no network — so it\'s cheap to call before committing to double-check your own work.',
  requestContextSchema,
  inputSchema: z.object({}),
  outputSchema: z.object({
    files: z.array(z.object({ path: z.string(), status: z.enum(['added', 'modified', 'deleted']) })),
  }),
  execute: async (_input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    return getStudioBridge().call(tenantId, sessionId, { op: 'gitStatus' });
  },
});

export const studioGitDiffTool = createTool({
  id: 'studio-git-diff',
  strict: false,
  description:
    'Get a unified diff of uncommitted changes, optionally scoped to one file. Local only — no network. Use it to verify your edits actually match what you intended before committing, or to answer "what did you change".',
  requestContextSchema,
  inputSchema: z.object({ path: z.string().optional().describe('Limit the diff to one file.') }),
  outputSchema: z.object({ diff: z.string() }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    return getStudioBridge().call(tenantId, sessionId, { op: 'gitDiff', path: input.path });
  },
});

export const studioGitLogTool = createTool({
  id: 'studio-git-log',
  strict: false,
  description: 'View recent commit history (default last 20). Local only — no network.',
  requestContextSchema,
  inputSchema: z.object({ depth: z.number().int().positive().max(100).optional() }),
  outputSchema: z.object({
    commits: z.array(
      z.object({ oid: z.string(), message: z.string(), author: z.string(), timestamp: z.number() }),
    ),
  }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    return getStudioBridge().call(tenantId, sessionId, { op: 'gitLog', depth: input.depth });
  },
});

export const studioGitListBranchesTool = createTool({
  id: 'studio-git-list-branches',
  strict: false,
  description: 'List branches and which one is currently checked out. Local only — no network.',
  requestContextSchema,
  inputSchema: z.object({}),
  outputSchema: z.object({ branches: z.array(z.string()), current: z.string() }),
  execute: async (_input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    return getStudioBridge().call(tenantId, sessionId, { op: 'gitListBranches' });
  },
});

export const studioGitCreateBranchTool = createTool({
  id: 'studio-git-create-branch',
  strict: false,
  description:
    'Create a new branch from the current commit, optionally switching to it. Use this ONLY when the user explicitly wants to try something experimental without touching their main work — most changes should just go straight to the current branch.',
  requestContextSchema,
  inputSchema: z.object({
    name: z.string().min(1).describe('New branch name, e.g. "try-dark-mode".'),
    checkout: z.boolean().optional().describe('Switch to the new branch immediately (default true).'),
  }),
  outputSchema: z.object({ ok: z.literal(true) }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    await getStudioBridge().call(tenantId, sessionId, {
      op: 'gitCreateBranch',
      name: input.name,
      checkout: input.checkout ?? true,
    });
    return { ok: true as const };
  },
});

export const studioGitCheckoutTool = createTool({
  id: 'studio-git-checkout',
  strict: false,
  description:
    'Switch to an existing branch or commit. Fails if there are uncommitted changes it would overwrite — commit or the user must decide first.',
  requestContextSchema,
  inputSchema: z.object({ ref: z.string().min(1).describe('Branch name or commit SHA.') }),
  outputSchema: z.object({ ok: z.literal(true) }),
  execute: async (input, context) => {
    const tenantId = requireTenantContext(context);
    const sessionId = requireStudioSession(context);
    await getStudioBridge().call(tenantId, sessionId, { op: 'gitCheckout', ref: input.ref });
    return { ok: true as const };
  },
});

/** All Studio tools, for the technical agent's toolset. */
export const studioTools = {
  studioWriteFileTool,
  studioReadFileTool,
  studioListTreeTool,
  studioDeleteFileTool,
  studioMkdirTool,
  studioRunCommandTool,
  studioGitCommitTool,
  studioGitPushTool,
  studioGitStatusTool,
  studioGitDiffTool,
  studioGitLogTool,
  studioGitListBranchesTool,
  studioGitCreateBranchTool,
  studioGitCheckoutTool,
};
