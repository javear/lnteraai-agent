// Client for the Research reports feature (`/svc/v1/research/*`). Reports are created by asking the
// Active Agent to research something — this page only lists/views/shares what's already been built.
import { apiErrorMessage } from './integrations';
import { apiUrl, ROUTER_BASENAME } from './runtime';
import type { ChartSpec } from './insights';

export type ResearchReportStatus = 'generating' | 'ready' | 'failed';

export interface ResearchReportSummary {
  id: string;
  topic: string;
  status: ResearchReportStatus;
  createdAt: string;
}

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
  topic: string;
  status: ResearchReportStatus;
  content: ResearchReportContent | null;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  // Present on the authenticated read (list/get/share); the public (/r/:slug) read strips these —
  // an anonymous viewer has no business seeing the owning tenant's id, the slug, or error detail.
  tenantId?: string;
  errorMessage?: string | null;
  publicSlug?: string | null;
}

type Api = (path: string, init?: RequestInit) => Promise<Response>;

export async function listResearchReports(api: Api): Promise<ResearchReportSummary[]> {
  const res = await api('/svc/v1/research/reports');
  if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not load your research reports.'));
  const data = (await res.json()) as { reports: ResearchReportSummary[] };
  return data.reports;
}

export async function getResearchReport(api: Api, id: string): Promise<ResearchReport> {
  const res = await api(`/svc/v1/research/reports/${id}`);
  if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not load that research report.'));
  const data = (await res.json()) as { report: ResearchReport };
  return data.report;
}

export async function shareResearchReport(api: Api, id: string, isPublic: boolean): Promise<ResearchReport> {
  const res = await api(`/svc/v1/research/reports/${id}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPublic }),
  });
  if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not update sharing for that report.'));
  const data = (await res.json()) as { report: ResearchReport };
  return data.report;
}

/** Ensures (and returns) the report's dedicated follow-up chat thread — navigate to `/c/${threadId}`. */
export async function startResearchDiscussion(api: Api, id: string): Promise<{ threadId: string }> {
  const res = await api(`/svc/v1/research/reports/${id}/discuss`, { method: 'POST' });
  if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not start a discussion for that report.'));
  return (await res.json()) as { threadId: string };
}

/** No auth — the slug alone is the access control for this intentionally-public read. */
export async function fetchPublicResearchReport(slug: string): Promise<ResearchReport> {
  const res = await fetch(apiUrl(`/svc/v1/research/public/${slug}`));
  if (!res.ok) throw new Error(await apiErrorMessage(res, 'This report is not available.'));
  const data = (await res.json()) as { report: ResearchReport };
  return data.report;
}

export function publicReportUrl(slug: string): string {
  const base = ROUTER_BASENAME === '/' ? '' : ROUTER_BASENAME;
  return `${window.location.origin}${base}/r/${slug}`;
}
