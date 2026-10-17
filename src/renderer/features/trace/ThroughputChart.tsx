import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import type { TraceStatsPoint } from '@/bridge/types';
import { formatNumber, formatTime } from '@/lib/format';
import { chartBars, chartBarAt, traceChartData, type TraceChartData } from './traceChartData';

// Dot-matrix render parameters (locked during design; see
// The renderer keeps this deterministic so visual and packaged smoke tests agree.
const PITCH = 5.0;        // grid cell size in CSS px
const DOT_MAX = 3.0;      // dot side at the curve top (dark, large)
const DOT_MIN = 1.0;      // dot side near the baseline (pale, small)
const ALPHA_MAX = 0.90;   // opacity at the curve top
const ALPHA_MIN = 0.20;   // opacity near the baseline (keeps it off the background)
const GAMMA = 0.9;        // dissolve curvature
const BASE_ROWS = 3;      // bottom rows always shown as a faint baseline grid
const BASE_ALPHA = 0.18;  // opacity of the baseline grid (keeps it off the background)

// No axes: the matrix fills the whole canvas edge-to-edge.
const PAD_T = 0;
const PAD_B = 0;
const PAD_L = 0;
const PAD_R = 0;

/** Cheap CSS-variable reader so canvas colors follow the active theme. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function roundedSquare(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const r = size * 0.28;
  const half = size / 2;
  ctx.beginPath();
  ctx.moveTo(cx - half + r, cy - half);
  ctx.arcTo(cx + half, cy - half, cx + half, cy + half, r);
  ctx.arcTo(cx + half, cy + half, cx - half, cy + half, r);
  ctx.arcTo(cx - half, cy + half, cx - half, cy - half, r);
  ctx.arcTo(cx - half, cy - half, cx + half, cy - half, r);
  ctx.closePath();
  ctx.fill();
}

interface Geometry {
  gx0: number;
  gx1: number;
  gy0: number;
  gy1: number;
  gw: number;
  gh: number;
}

/**
 * Adjacent dot-matrix columns with flat caps and vertical sides.
 * Each column is a real nonzero request, advancing only when usage arrives.
 * Request times and counters stay exact; idle time creates no empty columns.
 */
function paint(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  data: TraceChartData,
  colors: { slate: string; faint: string }
): void {
  const { gx0, gx1, gy1, gw, gh } = geo;
  const bars = chartBars(data, gw);
  const rows = Math.max(1, Math.floor(gh / PITCH));
  const rowY = (r: number): number => gy1 - (r + 0.5) * (gh / rows);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  for (let cx = gx0; cx <= gx1; cx += PITCH) {
    const cn = chartBarAt(cx - gx0, bars)?.height ?? 0;
    for (let r = 0; r < rows; r++) {
      const cellFrac = (r + 0.5) / rows; // 0 baseline .. 1 chart top
      if (cellFrac <= cn) {
        // Inside this column's bar: dots grow and darken toward the bar top.
        // Column-relative anchoring: 1 at this column's bar top, 0 at baseline.
        const h = Math.max(0, Math.min(1, cn > 0 ? cellFrac / cn : 0));
        const ramp = Math.pow(h, GAMMA);
        ctx.globalAlpha = lerp(ALPHA_MIN, ALPHA_MAX, ramp);
        ctx.fillStyle = colors.slate;
        roundedSquare(ctx, cx, rowY(r), lerp(DOT_MIN, DOT_MAX, ramp));
      } else if (r < BASE_ROWS) {
        // Outside any bar we stay empty, except the bottom few rows keep a faint
        // baseline grid so the chart always has a floor to grow from.
        ctx.globalAlpha = BASE_ALPHA;
        ctx.fillStyle = colors.faint;
        roundedSquare(ctx, cx, rowY(r), DOT_MIN * 0.9);
      }
    }
  }

  ctx.globalAlpha = 1;
}

interface Props {
  readonly series: readonly TraceStatsPoint[];
  readonly active: boolean;
}

export function ThroughputChart({ series, active }: Props): React.ReactElement {
  useLanguage();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const data = React.useMemo(() => traceChartData(series), [series]);
  const dataRef = React.useRef(data);
  dataRef.current = data;

  const [hover, setHover] = React.useState<{ x: number; y: number; total: number; at: number } | null>(null);
  const lastVal = data.latest?.value ?? 0;
  const geoRef = React.useRef<Geometry | null>(null);

  // Resolve geometry from the canvas' backing-store size (device pixels).
  const measure = React.useCallback((canvas: HTMLCanvasElement, dpr: number): Geometry => {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const geo: Geometry = {
      gx0: PAD_L, gx1: w - PAD_R, gy0: PAD_T, gy1: h - PAD_B,
      gw: w - PAD_L - PAD_R, gh: h - PAD_T - PAD_B
    };
    geoRef.current = geo;
    return geo;
  }, []);

  const render = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const wantW = Math.max(1, Math.round(rect.width * dpr));
    const wantH = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const geo = measure(canvas, dpr);
    paint(ctx, geo, dataRef.current, {
      slate: cssVar('--slate'),
      faint: cssVar('--faint')
    });
  }, [measure]);

  // Repaint when data, visibility, size or theme changes; no idle animation.
  React.useEffect(() => {
    const raf = requestAnimationFrame(render);
    const resize = new ResizeObserver(render);
    if (canvasRef.current) resize.observe(canvasRef.current);
    const theme = new MutationObserver(render);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => { cancelAnimationFrame(raf); resize.disconnect(); theme.disconnect(); };
  }, [active, data, render]);

  React.useEffect(() => {
    setHover(previous => previous && !data.anchors.some(point => point.at === previous.at && point.value === previous.total) ? null : previous);
  }, [data]);

  const onPointerMove = React.useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const geo = geoRef.current;
    if (!canvas || !geo) return;
    const rect = canvas.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * (canvas.width / (Math.min(window.devicePixelRatio || 1, 2)));
    const data = dataRef.current;
    const bar = chartBarAt(rx - geo.gx0, chartBars(data, geo.gw));
    if (!bar) { setHover(null); return; }
    const cssW = canvas.width / (Math.min(window.devicePixelRatio || 1, 2));
    const cssH = canvas.height / (Math.min(window.devicePixelRatio || 1, 2));
    const px = ((geo.gx0 + bar.x + bar.width / 2) / cssW) * rect.width;
    const py = ((geo.gy1 - bar.height * geo.gh) / cssH) * rect.height;
    // Clamp to the chart's real width (leaving room for the tip's own half-width)
    // so the label tracks the hovered bar instead of pinning to a fixed x.
    const clampedX = Math.max(60, Math.min(rect.width - 60, px));
    setHover({ x: clampedX, y: py, total: bar.anchor.value, at: bar.anchor.at });
  }, []);

  return (
    <div className="chart" id="throughputChart" data-axis="requests" data-request-count={data.anchors.length} data-range-start={data.start} data-range-end={data.end}>
      <div className="chart-now" id="chartNow">{t("最新请求")} {formatNumber(lastVal)} tokens</div>
      {hover && (
        <div
          className="chart-tip"
          style={{
            opacity: 1,
            left: `${hover.x}px`,
            top: `${hover.y}px`,
            transform: 'translate(-50%,calc(-100% - 12px))'
          }}
          id="chartTip"
        >
          <strong id="chartTipValue">{formatNumber(hover.total)} tokens</strong>
          <span id="chartTipTime">{formatTime(new Date(hover.at))}</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="chart-canvas"
        aria-label={t("吞吐量点阵图")}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      />
    </div>
  );
}
