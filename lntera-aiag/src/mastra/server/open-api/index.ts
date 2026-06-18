import { authTokenRoute } from './routes/auth-token';
import { discordIntegrationRoute } from './routes/discord-integration';
import {
  groqIntegrationDeleteRoute,
  groqIntegrationGetRoute,
  groqIntegrationRoute,
} from './routes/groq-integration';
import { meIntegrationsRoutes } from './routes/me-integrations';
import { publicConfigRoute } from './routes/public-config';
import { chatHistoryRoutes } from './routes/chat-history';
import { productSyncActionRoutes } from './routes/product-sync-actions';
import { insightScheduleRoutes } from './routes/insight-schedule';

/** Public Open API routes (namespace `/svc/v1`). Append new route modules here. */
export const openApiRoutes = [
  authTokenRoute,
  discordIntegrationRoute,
  groqIntegrationRoute,
  groqIntegrationGetRoute,
  groqIntegrationDeleteRoute,
  publicConfigRoute,
  ...meIntegrationsRoutes,
  ...chatHistoryRoutes,
  ...productSyncActionRoutes,
  ...insightScheduleRoutes,
];
