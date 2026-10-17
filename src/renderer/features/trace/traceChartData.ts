import type { TraceStatsPoint } from '@/bridge/types';

export interface ChartAnchor {
  readonly at: number;
  readonly value: number;
}

export interface TraceChartData {
  readonly anchors: readonly ChartAnchor[];
  readonly latest?: ChartAnchor;
  readonly start: number;
  readonly end: number;
}

export const CHART_BAR_WIDTH = 20;

/** Request order drives the chart; wall time, empty intervals and zero usage do not. */
export function traceChartData(series: readonly TraceStatsPoint[]): TraceChartData {
  const requests: ChartAnchor[] = [];
  for (const point of series) {
    const at = Date.parse(point.at);
    if (!Number.isFinite(at)) continue;
    const value = Number(point.tokens);
    requests.push({ at, value: Number.isFinite(value) ? Math.max(0, value) : 0 });
  }
  requests.sort((a, b) => a.at - b.at);
  const anchors = requests.filter(point => point.value > 0);
  const start = anchors[0]?.at ?? 0;
  return { anchors, latest: requests[requests.length - 1], start, end: anchors[anchors.length - 1]?.at ?? start };
}

export interface ChartBar {
  readonly anchor: ChartAnchor;
  readonly x: number;
  readonly width: number;
  readonly height: number;
}

/** One flat-topped column per real request. Adjacent columns share their edges. */
export function chartBars(data: TraceChartData, width: number): readonly ChartBar[] {
  if (!(width > 0) || !data.anchors.length) return [];
  const barWidth = Math.min(CHART_BAR_WIDTH, width);
  const count = Math.max(1, Math.floor(width / barWidth));
  const visible = data.anchors.slice(-count);
  const max = Math.max(1, ...visible.map(point => point.value));
  const left = width - visible.length * barWidth;
  return visible.map((anchor, index) => ({ anchor, x: left + index * barWidth, width: barWidth, height: Math.sqrt(anchor.value / max) }));
}

/** Hover reads the actual request under the pointer, including equal timestamps. */
export function chartBarAt(x: number, bars: readonly ChartBar[]): ChartBar | undefined {
  if (!bars.length || x < bars[0].x || x > bars[bars.length - 1].x + bars[bars.length - 1].width) return undefined;
  const index = Math.min(bars.length - 1, Math.floor((x - bars[0].x) / bars[0].width));
  return bars[index];
}
