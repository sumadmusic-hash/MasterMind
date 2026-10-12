import type { CSSProperties, ReactElement } from 'react';
import {
  ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip, Legend,
  LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  ScatterChart, Scatter,
} from 'recharts';
import type { ChartSpecData } from './ChartRenderer';

/**
 * Recharts-Implementierung für chart_spec — in einer eigenen Datei, damit
 * ChatRenderer/ChatPage die Bibliothek nur per React.lazy laden (Code-
 * Splitting: eigener vendor-charts Chunk, hält den Chat-Bundle klein).
 *
 * Alle Werte kommen aus dem bereits validierten Spec des Tools
 * (chart_spec begrenzt auf 120 Punkte / max. 8 Serien); hier wird nur noch
 * deklarativ gezeichnet.
 */

const COLORS = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#e879f9', '#a3e635'];

type Row = Record<string, string | number>;

function toRows(spec: ChartSpecData): Row[] {
  const cats = spec.categories ?? [];
  return cats.map((c, i) => {
    const row: Row = { category: String(c) };
    for (const s of spec.series ?? []) row[s.name] = s.data[i];
    return row;
  });
}

export function ChartsImpl({ spec }: { spec: ChartSpecData }) {
  const series = spec.series ?? [];
  const rows = toRows(spec);
  const tickInterval = Math.max(1, Math.floor(rows.length / 8));

  if (spec.type === 'pie') {
    // Pie zeigt eine einzelne Serie über die Kategorien.
    const data = rows.map(r => ({ name: String(r.category), value: Number(Object.values(r)[1]) || 0 }));
    return (
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" outerRadius={90} label={(e: any) => e.name}>
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (spec.type === 'scatter') {
    // Scatter braucht (x,y)-Paare: erste Serie = x, jede weitere = y.
    const xs = series[0]?.data ?? [];
    const scatterSeries = series.slice(1).length > 0 ? series.slice(1) : [series[0]];
    const first = series[0];
    const data = scatterSeries.map((s, si) =>
      s.data.map((y, i) => ({ x: si === 0 && scatterSeries.length === 1 ? i : xs[i], y }))
    );
    const trend = spec.trend && first
      ? [{ x: 0, y: spec.trend.intercept }, { x: (first.data.length - 1), y: spec.trend.slope * (first.data.length - 1) + spec.trend.intercept }]
      : null;
    return (
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 10, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="x" type="number" name={spec.xAxisLabel || series[0]?.name} tick={{ fontSize: 11, fill: '#9ca3af' }} stroke="#4b5563" />
            <YAxis dataKey="y" type="number" name={spec.yAxisLabel || 'Wert'} tick={{ fontSize: 11, fill: '#9ca3af' }} stroke="#4b5563" domain={['auto', 'auto']} />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={TOOLTIP_STYLE} />
            {trend && (
              <Scatter data={trend} line={{ stroke: '#f87171', strokeDasharray: '4 4' }} shape={() => <g />} legendType="none" isAnimationActive={false} />
            )}
            {data.map((d, i) => (
              <Scatter key={i} name={scatterSeries[i]?.name} data={d} fill={COLORS[(i + 1) % COLORS.length]} />
            ))}
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const common = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
      <XAxis
        dataKey="category"
        tick={{ fontSize: 11, fill: '#9ca3af' }}
        stroke="#4b5563"
        interval={tickInterval}
        label={spec.xAxisLabel ? { value: spec.xAxisLabel, position: 'insideBottom', offset: -2, fontSize: 11, fill: '#6b7280' } : undefined}
      />
      <YAxis
        tick={{ fontSize: 11, fill: '#9ca3af' }}
        stroke="#4b5563"
        domain={['auto', 'auto']}
        width={50}
        label={spec.yAxisLabel ? { value: spec.yAxisLabel, angle: -90, position: 'insideLeft', fontSize: 11, fill: '#6b7280' } : undefined}
      />
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
    </>
  );

  let chart: JSX.Element;
  switch (spec.type) {
    case 'bar':
      chart = (
        <BarChart data={rows} margin={{ top: 10, right: 10, bottom: 5, left: 0 }}>
          {common}
          {series.map((s, i) => <Bar key={s.name} dataKey={s.name} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />)}
        </BarChart>
      );
      break;
    case 'area':
      chart = (
        <AreaChart data={rows} margin={{ top: 10, right: 10, bottom: 5, left: 0 }}>
          {common}
          {series.map((s, i) => (
            <Area key={s.name} type="monotone" dataKey={s.name} stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.2} />
          ))}
        </AreaChart>
      );
      break;
    default: // line
      chart = (
        <LineChart data={rows} margin={{ top: 10, right: 10, bottom: 5, left: 0 }}>
          {common}
          {series.map((s, i) => (
            <Line key={s.name} type="monotone" dataKey={s.name} stroke={COLORS[i % COLORS.length]} dot={rows.length <= 40} strokeWidth={2} />
          ))}
        </LineChart>
      );
  }

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
    </div>
  );
}

const TOOLTIP_STYLE: React.CSSProperties = {
  background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 12,
};
