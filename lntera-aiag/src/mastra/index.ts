import { Mastra } from '@mastra/core/mastra';
import { CompactPinoLogger } from './logger/compact-pino-logger';
import { PostgresStore } from '@mastra/pg';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { weatherAgent } from './agents/weather-agent';
import { generalAgent } from './agents/general-agent';
import { titleAgent } from './agents/title-agent';
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
import {
  searchProductsTool,
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
  });
}

export const mastra = new Mastra({
  workflows: { weatherWorkflow },
  agents: { weatherAgent, generalAgent, titleAgent },
  tools: {
    [searchProductsTool.id]: searchProductsTool,
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
  },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  server: {
    apiRoutes: [...oauthRoutes, ...groqOnboardRoutes, ...openApiRoutes, ...webhookRoutes, ...authRoutes, ...webAppRoutes],
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
