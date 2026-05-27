import { Mastra } from '@mastra/core/mastra';
import { CompactPinoLogger } from './logger/compact-pino-logger';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from "@mastra/duckdb";
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { weatherAgent } from './agents/weather-agent';
import { generalAgent } from './agents/general-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';
import { oauthRoutes } from './server/oauth-routes';
import { openApiRoutes } from './server/open-api';
import { webhookRoutes } from './server/webhooks';
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

export const mastra = new Mastra({
  workflows: { weatherWorkflow },
  agents: { weatherAgent, generalAgent },
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
    apiRoutes: [...oauthRoutes, ...openApiRoutes, ...webhookRoutes],
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: "mastra-storage",
      url: "file:./mastra.db",
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    }
  }),
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
