import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, MessageCircle, Share2 } from 'lucide-react';
import { useAuth } from '../auth';
import { Badge, Button, Skeleton } from '../ui';
import { ReportContent } from '../components/research/ReportContent';
import {
  getResearchReport,
  shareResearchReport,
  startResearchDiscussion,
  publicReportUrl,
  type ResearchReport,
} from '../lib/research';

export default function ReportView() {
  const { id = '' } = useParams();
  const { api } = useAuth();
  const navigate = useNavigate();
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [sharing, setSharing] = useState(false);
  const [discussing, setDiscussing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getResearchReport(api, id)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [api, id]);

  useEffect(() => {
    if (report?.status !== 'generating') return;
    const t = window.setInterval(() => {
      getResearchReport(api, id).then(setReport).catch(() => {});
    }, 4000);
    return () => window.clearInterval(t);
  }, [report, api, id]);

  async function handleShareToggle() {
    if (!report) return;
    setSharing(true);
    try {
      const updated = await shareResearchReport(api, report.id, !report.isPublic);
      setReport(updated);
      if (updated.isPublic && updated.publicSlug) {
        await navigator.clipboard.writeText(publicReportUrl(updated.publicSlug)).catch(() => {});
        toast.success('Public link copied to clipboard.');
      } else {
        toast.success('This report is no longer public.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSharing(false);
    }
  }

  async function handleDiscuss() {
    if (!report) return;
    setDiscussing(true);
    try {
      const { threadId } = await startResearchDiscussion(api, report.id);
      navigate(`/c/${threadId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setDiscussing(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-6 sm:py-10">
      <button
        onClick={() => navigate('/reports')}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All reports
      </button>

      {!report ? (
        <>
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="mt-4 h-32 w-full" />
        </>
      ) : report.status === 'generating' ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border py-16 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <div>
            <p className="text-[15px] font-medium">Building your report on "{report.topic}"…</p>
            <p className="mt-1 text-[13px] text-muted-foreground">This can take a minute — you'll be notified when it's ready.</p>
          </div>
        </div>
      ) : report.status === 'failed' ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-6 text-center">
          <p className="text-[15px] font-medium">This report couldn't be generated</p>
          <p className="mt-1 text-[13px] text-muted-foreground">{report.errorMessage ?? 'Ask the agent to try again.'}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{report.topic}</h1>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {new Date(report.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {report.isPublic ? <Badge tone="success">Public</Badge> : null}
              <Button variant="secondary" onClick={handleShareToggle} disabled={sharing}>
                <Share2 className="mr-1.5 h-3.5 w-3.5" />
                {report.isPublic ? 'Unshare' : 'Share'}
              </Button>
            </div>
          </div>

          <div className="mt-6">
            <ReportContent content={report.content!} />
          </div>

          <div className="mt-8 border-t pt-6">
            <Button onClick={handleDiscuss} disabled={discussing}>
              <MessageCircle className="mr-1.5 h-3.5 w-3.5" />
              {discussing ? 'Opening…' : 'Discuss this report'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
