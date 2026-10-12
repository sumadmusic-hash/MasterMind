import { lazy, Suspense } from 'react';
import { BarChart3 } from 'lucide-react';

/**
 * Chart-Spec-Renderer (docs/fehlende-tools-mehr-macht.md, Phase 2 / Punkt 5).
 *
 * chart_spec (src/services/tools.ts) liefert einen validierten Spec
 * { type, title, categories, series[], trend? } — dieses Component rendert ihn
 * mit recharts. recharts wird per React.lazy erst beim ersten Chart geladen
 * (eigener vendor-charts Chunk, siehe vite.config.js), damit der Chat-Bundle
 * klein bleibt.
 *
 * Es wird ausschließlich deklaratives JSON gezeichnet — kein generierter Code
 * (Grundsatz: docs/ai-eigene-tools-analyse.md).
 */

const Charts = lazy(() => import('./ChartsImpl').then(m => ({ default: m.ChartsImpl })));

export interface ChartSpecData {
  type?: string;
  title?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  categories?: string[];
  series?: { name: string; data: number[] }[];
  trend?: { slope: number; intercept: number; r2: number };
  pointCount?: number;
}

/** Narrow an unknown tool-result payload to a renderable chart spec. */
export function asChartSpec(raw: any): ChartSpecData | null {
  const c = raw?.chart ?? raw?.spec; // tools return { chart, spec }
  if (!c || typeof c !== 'object') return null;
  if (!Array.isArray(c.categories) || !Array.isArray(c.series)) return null;
  if (c.categories.length === 0 || c.series.length === 0) return null;
  if (!c.series.every((s: any) => Array.isArray(s?.data))) return null;
  return c as ChartSpecData;
}

export function ChartRenderer({ spec }: { spec: ChartSpecData }) {
  return (
    <div className="bg-gray-800/40 border border-gray-700/60 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <BarChart3 className="w-4 h-4 text-blue-400" />
        <h3 className="text-sm font-semibold text-gray-100">{spec.title || 'Chart'}</h3>
        <span className="ml-auto text-[10px] text-gray-500">
          {spec.type} · {spec.pointCount ?? spec.categories?.length ?? 0} Punkte
        </span>
      </div>
      <Suspense
        fallback={<div className="h-56 flex items-center justify-center text-xs text-gray-500">Diagramm lädt…</div>}
      >
        <Charts spec={spec} />
      </Suspense>
      {spec.trend && (
        <p className="mt-2 text-[11px] text-gray-500">
          Trend: y = {spec.trend.slope}·x + {spec.trend.intercept} (R² = {spec.trend.r2})
        </p>
      )}
    </div>
  );
}
