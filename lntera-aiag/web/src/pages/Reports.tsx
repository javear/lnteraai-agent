import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { FileSearch, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../auth';
import { Badge, Skeleton } from '../ui';
import { listResearchReports, type ResearchReportSummary, type ResearchReportStatus } from '../lib/research';

function statusTone(status: ResearchReportStatus): 'success' | 'danger' | 'neutral' {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function statusLabel(status: ResearchReportStatus): string {
  if (status === 'generating') return 'Generating…';
  if (status === 'failed') return 'Failed';
  return 'Ready';
}

export default function Reports() {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [reports, setReports] = useState<ResearchReportSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listResearchReports(api)
      .then((r) => {
        if (!cancelled) setReports(r);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [api]);

  // A report still generating gets polled so its status flips to ready/failed without a manual refresh.
  useEffect(() => {
    if (!reports?.some((r) => r.status === 'generating')) return;
    const t = window.setInterval(() => {
      listResearchReports(api).then(setReports).catch(() => {});
    }, 5000);
    return () => window.clearInterval(t);
  }, [reports, api]);

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold tracking-tight">Research reports</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Ask the Active Agent to research something — comprehensive analysis, charts, and forecasts show up here.
      </p>

      <div className="mt-6 flex flex-col gap-2">
        {reports === null ? (
          <>
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </>
        ) : reports.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border py-16 text-center">
            <FileSearch className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-[15px] font-medium">No research reports yet</p>
              <p className="mt-1 max-w-xs text-[13px] text-muted-foreground">
                Try asking: "Research our price forecast for next year."
              </p>
            </div>
          </div>
        ) : (
          reports.map((r) => (
            <button
              key={r.id}
              onClick={() => navigate(`/reports/${r.id}`)}
              className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3.5 text-left transition-colors hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{r.topic}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              </div>
              {r.status === 'generating' ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : r.status === 'failed' ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
              ) : null}
              <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
