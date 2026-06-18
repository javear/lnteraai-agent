// Renders insight charts inside a chat message. The heavy Recharts impl is code-split into its own
// chunk and only loaded when a message actually carries charts.
import { Suspense, lazy } from 'react';
import type { ChartSpec } from '../../lib/insights';

const InsightChartImpl = lazy(() => import('./InsightChartImpl'));

export function InsightChart({ charts }: { charts?: ChartSpec[] }) {
  if (!charts || charts.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-3">
      <Suspense
        fallback={<div className="h-[220px] animate-pulse rounded-xl border bg-muted/40" aria-hidden />}
      >
        {charts.map((spec, i) => (
          <InsightChartImpl key={i} spec={spec} />
        ))}
      </Suspense>
    </div>
  );
}
