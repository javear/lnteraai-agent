// Ships a webapp Forge project's already-built zip to EdgeOne's preview environment. Triggered by
// studio-deploy-preview (see integrations/studio/tools.ts) right after it uploads the zip that
// BrowserPod produced — kept out of that tool call's own request/response cycle because a webapp
// build is slow enough that the agent shouldn't block a chat reply waiting for it, and because a
// transient EdgeOne hiccup here must be retried, not silently lost.
import { inngest } from '../client';
import { downloadPreviewBuild } from '../../integrations/studio/preview-builds';
import { deployToEdgeOne, setEdgeOneEnvVars } from '../../integrations/studio/edgeone';
import { resolveTenantProjectSecretValues } from '../../integrations/shared/tenant-project-secrets';
import { updateTenantProject } from '../../integrations/shared/tenant-projects';

interface DeployStudioPreviewEventData {
  tenantId: string;
  projectId: string;
  projectName: string;
}

export const deployStudioPreviewFn = inngest.createFunction(
  {
    id: 'deploy-studio-preview',
    // Per-project: never let two overlapping deploys of the same project race each other. Global
    // limit stays under the plan's per-function cap of 5 (same margin every other function here keeps).
    concurrency: [{ limit: 4 }, { key: 'event.data.projectId', limit: 1 }],
    retries: 3,
    triggers: [{ event: 'studio/preview.build-ready' }],
  },
  async ({ event, step }) => {
    const { tenantId, projectId, projectName } = event.data as DeployStudioPreviewEventData;

    const zipBase64 = await step.run('load-build', async () => {
      const buf = await downloadPreviewBuild(projectId);
      return buf.toString('base64');
    });

    const secretValues = await step.run('load-secrets', () =>
      resolveTenantProjectSecretValues(projectId).catch(() => ({}) as Record<string, string>),
    );

    const { url } = await step.run('deploy', () => deployToEdgeOne({ projectName, zipBase64, env: 'preview' }));

    await step.run('update-project', () => updateTenantProject(tenantId, projectId, { preview_url: url }));
    await step.run('sync-env-vars', () => setEdgeOneEnvVars({ projectName, values: secretValues }));

    return { url };
  },
);
