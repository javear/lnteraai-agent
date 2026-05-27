import { authTokenRoute } from './routes/auth-token';
import { discordIntegrationRoute } from './routes/discord-integration';

/** Public Open API routes (namespace `/svc/v1`). Append new route modules here. */
export const openApiRoutes = [authTokenRoute, discordIntegrationRoute];
