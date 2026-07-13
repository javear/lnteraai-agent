import { Mastra } from '@mastra/core/mastra';
import { CompactPinoLogger } from './logger/compact-pino-logger';
import { PostgresStore } from '@mastra/pg';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { weatherAgent } from './agents/weather-agent';
import { generalAgent } from './agents/general-agent';
import { titleAgent } from './agents/title-agent';
import { notificationAgent } from './agents/notification-agent';
import { technicalAgent } from './agents/technical-agent';
import { researchReportAgent } from './agents/research-report-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';
import { oauthRoutes } from './server/oauth-routes';
import { groqOnboardRoutes } from './server/groq-onboard-routes';
import { openApiRoutes } from './server/open-api';
import { webhookRoutes } from './server/webhooks';
import { authRoutes } from './server/auth-routes';
import { webAppRoutes } from './server/web-app-route';
import { buildServerAuth, tenantContextMiddleware, getCorsConfig, isPlaygroundDevMode } from './server/auth';

// Auth is enforced in production and disabled in local dev so the Studio playground works
// (it relies on the framework's dev bypass, which any auth provider disables). See dev-mode.ts.
const playgroundDevMode = isPlaygroundDevMode();
if (playgroundDevMode) {
  // eslint-disable-next-line no-console
  console.warn(
    '[auth] MASTRA_DEV detected — server auth is DISABLED for the local Studio playground. ' +
      'Never set MASTRA_DEV in a deployed environment; set NODE_ENV=production as a guard.',
  );
}

// @mastra/pg can fail to initialize storage when the Postgres handshake times out on a slow network
// (EAUTHTIMEOUT / SQLSTATE 08006) — notably the observability DefaultExporter creating its spans
// table. The PostgresStore itself retries lazily on the next call, but that init rejection is
// otherwise UNCAUGHT and kills the process. Swallow STORAGE-domain failures (log + continue); let
// every other error fail fast so real bugs still surface.
function isStorageInitError(err: unknown): boolean {
  const e = err as { domain?: unknown; id?: unknown } | null;
  const id = typeof e?.id === 'string' ? e.id : '';
  return e?.domain === 'STORAGE' || id.startsWith('MASTRA_STORAGE');
}
process.on('unhandledRejection', (reason) => {
  if (isStorageInitError(reason)) {
    // eslint-disable-next-line no-console
    console.error(
      '[storage] async init failed — continuing; storage retries on the next call:',
      reason instanceof Error ? reason.message : reason,
    );
    return;
  }
  throw reason; // becomes an uncaughtException → default crash for genuine errors
});
process.on('uncaughtException', (err) => {
  if (isStorageInitError(err)) {
    // eslint-disable-next-line no-console
    console.error('[storage] init failed — continuing; storage retries on the next call:', err.message);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
import {
  searchProductsTool,
  syncMarketplaceProductsTool,
  searchOrdersTool,
  confirmOrderFulfillmentTool,
  createFulfillmentPackageTool,
  getOrderDetailsTool,
  getShippingLabelsTool,
  getProductDetailsTool,
  updateProductAttributesTool,
  updateProductPriceTool,
  updateProductStockTool,
  archiveProductTool,
  startProductDraftTool,
  updateProductDraftTool,
  getProductDraftTool,
  listProductDraftsTool,
  publishProductDraftTool,
  discardProductDraftTool,
} from './tools/ecommerce';
import { configureInsightsTool } from './tools/insights/configure-insights';
import { runInsightsNowTool } from './tools/insights/run-insights-now';
import { inngestRoutes } from './inngest/serve-route';
import { startEmbeddedDiscordBots } from './integrations/discord/embed';

function createMastraStorage(): PostgresStore {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required. Set a Postgres connection string (e.g. Supabase session pooler on port 5432).',
    );
  }
  return new PostgresStore({
    id: 'mastra-storage',
    connectionString,
    schemaName: 'mastra',
    max: Number(process.env.DATABASE_POOL_MAX) || 8,
    idleTimeoutMillis: 20_000,
    // Slow/corporate networks (e.g. behind a proxy) can take >10s for the Postgres TLS+auth
    // handshake; a short connect timeout surfaces as EAUTHTIMEOUT and aborts startup table creation.
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 30_000,
  });
}

export const mastra = new Mastra({
  workflows: { weatherWorkflow },
  agents: { weatherAgent, generalAgent, titleAgent, notificationAgent, technicalAgent, researchReportAgent },
  tools: {
    [searchProductsTool.id]: searchProductsTool,
    [syncMarketplaceProductsTool.id]: syncMarketplaceProductsTool,
    [searchOrdersTool.id]: searchOrdersTool,
    [confirmOrderFulfillmentTool.id]: confirmOrderFulfillmentTool,
    [createFulfillmentPackageTool.id]: createFulfillmentPackageTool,
    [getOrderDetailsTool.id]: getOrderDetailsTool,
    [getShippingLabelsTool.id]: getShippingLabelsTool,
    [getProductDetailsTool.id]: getProductDetailsTool,
    [updateProductAttributesTool.id]: updateProductAttributesTool,
    [updateProductPriceTool.id]: updateProductPriceTool,
    [updateProductStockTool.id]: updateProductStockTool,
    [archiveProductTool.id]: archiveProductTool,
    [startProductDraftTool.id]: startProductDraftTool,
    [updateProductDraftTool.id]: updateProductDraftTool,
    [getProductDraftTool.id]: getProductDraftTool,
    [listProductDraftsTool.id]: listProductDraftsTool,
    [publishProductDraftTool.id]: publishProductDraftTool,
    [discardProductDraftTool.id]: discardProductDraftTool,
    [configureInsightsTool.id]: configureInsightsTool,
    [runInsightsNowTool.id]: runInsightsNowTool,
  },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  server: {
    apiRoutes: [...oauthRoutes, ...groqOnboardRoutes, ...openApiRoutes, ...webhookRoutes, ...authRoutes, ...webAppRoutes, ...inngestRoutes],
    // Single auth standard: the same tenant JWT issued by /svc/v1 guards Mastra's native
    // /api/* (agents, tools, workflows) in production. Omitted in local dev so the Studio
    // playground loads (Studio cannot authenticate against MastraJwtAuth — it has no login UI).
    auth: playgroundDevMode ? undefined : buildServerAuth(),
    // Bridge the authenticated tenant into the existing tenant_master_id tool contract.
    middleware: [{ path: '/api/*', handler: tenantContextMiddleware }],
    cors: getCorsConfig(),
  },
  // Agent memory (threads + messages) and observability traces — Supabase Postgres via DATABASE_URL.
  // @mastra/pg auto-creates tables under the `mastra` schema. Use the session pooler (5432) or a
  // direct connection with sslmode=require — NOT the transaction pooler (6543).
  storage: createMastraStorage(),
  logger: new CompactPinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(), // Persists traces to storage for Mastra Studio
          new CloudExporter(), // Sends observability data to hosted Mastra Studio (if MASTRA_CLOUD_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});

void startEmbeddedDiscordBots();
