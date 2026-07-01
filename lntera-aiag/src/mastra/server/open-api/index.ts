import { authTokenRoute } from './routes/auth-token';
import { discordIntegrationRoute } from './routes/discord-integration';
import {
  groqIntegrationDeleteRoute,
  groqIntegrationGetRoute,
  groqIntegrationRoute,
} from './routes/groq-integration';
import { meIntegrationsRoutes } from './routes/me-integrations';
import { meModelsRoutes } from './routes/me-models';
import { publicConfigRoute } from './routes/public-config';
import { chatHistoryRoutes } from './routes/chat-history';
import { productSyncActionRoutes } from './routes/product-sync-actions';
import { insightScheduleRoutes } from './routes/insight-schedule';
import { syncConfigRoutes } from './routes/sync-config';
import { transactionRoutes } from './routes/transactions';
import { financeReportRoutes } from './routes/finance-reports';
import { languageRoutes } from './routes/language';

/** Public Open API routes (namespace `/svc/v1`). Append new route modules here. */
export const openApiRoutes = [
  authTokenRoute,
  discordIntegrationRoute,
  groqIntegrationRoute,
  groqIntegrationGetRoute,
  groqIntegrationDeleteRoute,
  publicConfigRoute,
  ...meIntegrationsRoutes,
  ...meModelsRoutes,
  ...chatHistoryRoutes,
  ...productSyncActionRoutes,
  ...insightScheduleRoutes,
  ...syncConfigRoutes,
  ...transactionRoutes,
  ...financeReportRoutes,
  ...languageRoutes,
];
