// Recharts renderer for a ChartSpec. Loaded lazily (own chunk) so Recharts never touches the eager
// bundle. Themed entirely from CSS tokens so it tracks light/dark + the brand automatically.
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartSpec } from '../../lib/insights';

const SERIES_COLORS = ['hsl(var(--brand))', 'hsl(var(--foreground) / 0.55)', 'hsl(var(--muted-foreground))'];
const SLICE_COLORS = [
  'hsl(var(--brand))',
  'hsl(var(--brand) / 0.62)',
  'hsl(var(--brand) / 0.38)',
  'hsl(var(--muted-foreground) / 0.55)',
  'hsl(var(--foreground) / 0.5)',
  'hsl(var(--brand) / 0.22)',
];

const TOOLTIP_STYLE = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '10px',
  fontSize: '12px',
  color: 'hsl(var(--popover-foreground))',
  boxShadow: 'var(--tw-shadow, 0 6px 16px -4px hsl(var(--shadow-color, 0 0% 0%) / 0.12))',
};
const AXIS_TICK = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };

function seriesKey(name: string | undefined, i: number): string {
  return name?.trim() || `Series ${i + 1}`;
}

export default function InsightChartImpl({ spec }: { spec: ChartSpec }) {
  const multi = spec.series.length > 1;

  // Bar / line share a row-per-label shape.
  const rows = spec.labels.map((label, i) => {
    const row: Record<string, string | number> = { name: label };
    spec.series.forEach((s, si) => {
      row[seriesKey(s.name, si)] = s.data[i] ?? 0;
    });
    return row;
  });

  return (
    <figure className="rounded-xl border bg-card p-4 shadow-sm">
      <figcaption className="mb-3 text-sm font-medium text-foreground">{spec.title}</figcaption>
      <ResponsiveContainer width="100%" height={spec.type === 'donut' ? 240 : 220}>
        {spec.type === 'donut' ? (
          <PieChart>
            <Pie
              data={spec.labels.map((label, i) => ({ name: label, value: spec.series[0]?.data[i] ?? 0 }))}
              dataKey="value"
              nameKey="name"
              innerRadius={58}
              outerRadius={88}
              paddingAngle={2}
              stroke="hsl(var(--card))"
              strokeWidth={2}
            >
              {spec.labels.map((_, i) => (
                <Cell key={i} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v}${spec.unit ? ` ${spec.unit}` : ''}`]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        ) : spec.type === 'line' ? (
          <LineChart data={rows} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'hsl(var(--border))' }} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            {multi ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
            {spec.series.map((s, si) => (
              <Line
                key={si}
                type="monotone"
                dataKey={seriesKey(s.name, si)}
                stroke={SERIES_COLORS[si % SERIES_COLORS.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        ) : (
          <BarChart data={rows} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'hsl(var(--border))' }} interval={0} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'hsl(var(--muted) / 0.5)' }} />
            {multi ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
            {spec.series.map((s, si) => (
              <Bar key={si} dataKey={seriesKey(s.name, si)} fill={SERIES_COLORS[si % SERIES_COLORS.length]} radius={[4, 4, 0, 0]} maxBarSize={48} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </figure>
  );
}
