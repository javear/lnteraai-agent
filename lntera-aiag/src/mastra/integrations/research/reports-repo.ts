// CRUD for `tenant_research_reports` — one row per agent-generated Research report. `content` stays
// NULL while status='generating'; the generate-research-report Inngest function fills it once done.
import { randomBytes } from 'node:crypto';
import { getSupabase } from '../shared/supabase';
import type { ChartSpec } from '../../insights/types';

const TABLE = 'tenant_research_reports';

export type ResearchReportStatus = 'generating' | 'ready' | 'failed';

export interface ResearchReportSection {
  heading: string;
  body: string;
}

export interface ResearchReportImage {
  url: string;
  caption?: string;
}

export interface ResearchReportCitation {
  url: string;
  title: string;
  excerpt?: string;
}

export interface ResearchReportContent {
  sections: ResearchReportSection[];
  charts: ChartSpec[];
  images: ResearchReportImage[];
  citations: ResearchReportCitation[];
}

export interface ResearchReport {
  id: string;
  tenantId: string;
  /** The auth user who asked for this report — null if unknown (e.g. a pre-existing row from before
   *  this column existed). Used to email ONLY the requester, not every user on the tenant workspace. */
  authUserId: string | null;
  topic: string;
  status: ResearchReportStatus;
  content: ResearchReportContent | null;
  errorMessage: string | null;
  isPublic: boolean;
  publicSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

/** List view (topic/status/date only — content omitted, this can get large). */
export interface ResearchReportSummary {
  id: string;
  topic: string;
  status: ResearchReportStatus;
  createdAt: string;
}

interface ResearchReportRow {
  id: string;
  tenant_id: string;
  auth_user_id: string | null;
  topic: string;
  status: ResearchReportStatus;
  content: ResearchReportContent | null;
  error_message: string | null;
  is_public: boolean;
  public_slug: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: ResearchReportRow): ResearchReport {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    authUserId: row.auth_user_id,
    topic: row.topic,
    status: row.status,
    content: row.content,
    errorMessage: row.error_message,
    isPublic: row.is_public,
    publicSlug: row.public_slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createResearchReport(
  tenantId: string,
  topic: string,
  authUserId?: string | null,
): Promise<ResearchReport> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .insert({ tenant_id: tenantId, topic, status: 'generating', auth_user_id: authUserId ?? null })
    .select('*')
    .single();
  if (error || !data) throw new Error(`Failed to create research report: ${error?.message ?? 'unknown error'}`);
  return fromRow(data as ResearchReportRow);
}

/** List a tenant's reports, newest first, WITHOUT content (for a list view). */
export async function listResearchReports(tenantId: string): Promise<ResearchReportSummary[]> {
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('id, topic, status, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to list research reports: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    topic: r.topic as string,
    status: r.status as ResearchReportStatus,
    createdAt: r.created_at as string,
  }));
}

/** Fetch ONE report by id, scoped to the tenant (never leak another tenant's report by guessing an id). */
export async function getResearchReport(tenantId: string, id: string): Promise<ResearchReport | null> {
  const { data, error } = await getSupabase().from(TABLE).select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  if (error) throw new Error(`Failed to fetch research report (${id}): ${error.message}`);
  return data ? fromRow(data as ResearchReportRow) : null;
}

/** Fetch by id with NO tenant scoping — internal use only (the generation pipeline, which already has
 *  the tenantId it created the row with, but re-derives the full row after each step). */
export async function getResearchReportById(id: string): Promise<ResearchReport | null> {
  const { data, error } = await getSupabase().from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Failed to fetch research report (${id}): ${error.message}`);
  return data ? fromRow(data as ResearchReportRow) : null;
}

/** The PUBLIC read path — looked up by slug alone, gated on is_public. No tenant auth at all; the
 *  slug (unguessable, revocable) IS the access control for this intentionally-public surface. */
export async function getPublicResearchReport(slug: string): Promise<ResearchReport | null> {
  const { data, error } = await getSupabase().from(TABLE).select('*').eq('public_slug', slug).eq('is_public', true).maybeSingle();
  if (error) throw new Error(`Failed to fetch public research report: ${error.message}`);
  return data ? fromRow(data as ResearchReportRow) : null;
}

export async function markResearchReportReady(id: string, content: ResearchReportContent): Promise<void> {
  const { error } = await getSupabase().from(TABLE).update({ status: 'ready', content, error_message: null }).eq('id', id);
  if (error) throw new Error(`Failed to mark research report ready (${id}): ${error.message}`);
}

export async function markResearchReportFailed(id: string, errorMessage: string): Promise<void> {
  const { error } = await getSupabase().from(TABLE).update({ status: 'failed', error_message: errorMessage }).eq('id', id);
  if (error) throw new Error(`Failed to mark research report failed (${id}): ${error.message}`);
}

/** Toggle public sharing. Turning ON (re)generates a fresh slug — the old link stops working, matching
 *  the "regenerating revokes the old link" behavior documented on the column. Turning OFF just clears
 *  is_public; the slug stays stored (so re-sharing later doesn't need this to be idempotent-slug-safe). */
export async function setResearchReportSharing(
  tenantId: string,
  id: string,
  isPublic: boolean,
): Promise<ResearchReport | null> {
  const patch: { is_public: boolean; public_slug?: string } = { is_public: isPublic };
  if (isPublic) patch.public_slug = randomBytes(18).toString('base64url');

  const { data, error } = await getSupabase()
    .from(TABLE)
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`Failed to update research report sharing (${id}): ${error.message}`);
  return data ? fromRow(data as ResearchReportRow) : null;
}
