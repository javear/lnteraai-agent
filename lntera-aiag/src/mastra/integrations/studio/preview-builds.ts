import { getSupabase } from '../shared/supabase';

const BUCKET = 'studio-preview-builds';

/** One overwritten object per project — only the latest built zip is ever needed. */
function pathFor(projectId: string): string {
  return `${projectId}/latest.zip`;
}

/** Durably stash a webapp project's freshly built zip so deploy-studio-preview (an Inngest job that
 *  may run, or retry, well after the triggering browser session ends) can read it back. */
export async function uploadPreviewBuild(projectId: string, zip: Buffer): Promise<void> {
  const { error } = await getSupabase()
    .storage.from(BUCKET)
    .upload(pathFor(projectId), zip, { contentType: 'application/zip', upsert: true });
  if (error) throw new Error(`Failed to upload preview build (${projectId}): ${error.message}`);
}

export async function downloadPreviewBuild(projectId: string): Promise<Buffer> {
  const { data, error } = await getSupabase().storage.from(BUCKET).download(pathFor(projectId));
  if (error || !data) throw new Error(`Failed to download preview build (${projectId}): ${error?.message ?? 'not found'}`);
  return Buffer.from(await data.arrayBuffer());
}
