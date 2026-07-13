// Shared renderer for a research report's content — sections/charts/images/citations. Used by both the
// authenticated /reports/:id view and the public (no-auth) /r/:slug view, so the two never drift.
import { ExternalLink } from 'lucide-react';
import { Markdown } from '../chat/Markdown';
import { InsightChart } from '../chat/InsightChart';
import type { ResearchReportContent } from '../../lib/research';

export function ReportContent({ content }: { content: ResearchReportContent }) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        {content.sections.map((section, i) => (
          <section key={i}>
            <h2 className="mb-2 text-[17px] font-semibold tracking-tight">{section.heading}</h2>
            <Markdown>{section.body}</Markdown>
          </section>
        ))}
      </div>

      {content.charts.length > 0 ? <InsightChart charts={content.charts} /> : null}

      {content.images.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {content.images.map((img, i) => (
            <figure key={i} className="overflow-hidden rounded-xl border bg-card">
              <img src={img.url} alt={img.caption ?? ''} className="w-full object-cover" loading="lazy" />
              {img.caption ? (
                <figcaption className="px-3 py-2 text-[13px] text-muted-foreground">{img.caption}</figcaption>
              ) : null}
            </figure>
          ))}
        </div>
      ) : null}

      {content.citations.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Sources</h3>
          <ul className="flex flex-col gap-1.5">
            {content.citations.map((c, i) => (
              <li key={i} className="text-[13px]">
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
                >
                  {c.title}
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                </a>
                {c.excerpt ? <p className="mt-0.5 text-muted-foreground">{c.excerpt}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
