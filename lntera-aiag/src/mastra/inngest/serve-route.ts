// Public Inngest serve endpoint. Inngest hits this on GET (introspection), PUT (register), and POST
// (invoke), authenticated by the signing key (not our tenant JWT) → requiresAuth:false. Path is
// `/inngest` (NOT `/api/inngest`: Mastra reserves the whole `/api/*` namespace for built-in routes).
// Register this URL in Inngest Cloud (https://<host>/inngest) and, for the local inngest-cli dev
// server: `npx inngest-cli dev -u http://localhost:4111/inngest`.
// `serve()` returns a Hono handler; Mastra bundles its own Hono copy, so the Context types differ at
// compile time though it's one Hono at runtime — hence the cast (the integration risk noted in plan).
import { serve } from 'inngest/hono';
import { registerApiRoute } from '@mastra/core/server';
import { inngest } from './client';
import { insightArmSweepFn } from './functions/sweep-insight-arms';
import { runInsightFn } from './functions/run-insight';
import { runScheduledTaskFn } from './functions/run-scheduled-task';
import { scheduledTaskSweepFn } from './functions/sweep-scheduled-tasks';
import { ingestDocumentFn } from './functions/ingest-document';
import { knowledgeEvictionSweepFn } from './functions/sweep-knowledge-eviction';
import { deployStudioPreviewFn } from './functions/deploy-studio-preview';

export const INNGEST_SERVE_PATH = '/inngest';

// Public origin Inngest Cloud should call back. Set so the deploy-time self-sync (entrypoint.sh PUTs
// localhost:$PORT/inngest) registers the PUBLIC function URL instead of localhost — no rollout race.
const serveOrigin = process.env.MASTRA_PUBLIC_BASE_URL?.trim();

const inngestHandler = serve({
  client: inngest,
  functions: [
    insightArmSweepFn,
    runInsightFn,
    runScheduledTaskFn,
    scheduledTaskSweepFn,
    ingestDocumentFn,
    knowledgeEvictionSweepFn,
    deployStudioPreviewFn,
  ],
  servePath: INNGEST_SERVE_PATH,
  ...(serveOrigin ? { serveOrigin } : {}),
});

export const inngestRoutes = (['GET', 'PUT', 'POST'] as const).map((method) =>
  registerApiRoute(INNGEST_SERVE_PATH, {
    method,
    requiresAuth: false,
    handler: (c) => inngestHandler(c as never),
  }),
);
