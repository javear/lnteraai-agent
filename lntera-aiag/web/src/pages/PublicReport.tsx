// Public, unauthenticated report view (`/r/:slug`) — no AppLayout chrome, no auth gate. The slug alone
// gates access; the server-side route (`GET /svc/v1/research/public/:slug`) enforces it, this page just
// renders whatever it returns.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Logo } from '../ui';
import { ReportContent } from '../components/research/ReportContent';
import { fetchPublicResearchReport, type ResearchReport } from '../lib/research';

export default function PublicReport() {
  const { slug = '' } = useParams();
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPublicResearchReport(slug)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b px-5 py-4 sm:px-6">
        <Logo size="sm" />
      </header>
      <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-6 sm:py-10">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground" />
            <p className="text-[15px] font-medium">{error}</p>
          </div>
        ) : !report ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <h1 className="text-xl font-semibold tracking-tight">{report.topic}</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {new Date(report.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
            <div className="mt-6">{report.content ? <ReportContent content={report.content} /> : null}</div>
          </>
        )}
      </div>
    </div>
  );
}
