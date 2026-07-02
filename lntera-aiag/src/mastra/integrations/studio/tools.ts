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
    return getStudioBridge().call(tenantId, sessionId, {
      op: 'execCommand',
      command: input.command,
      args: input.args,
      cwd: input.cwd,
    });
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
};
