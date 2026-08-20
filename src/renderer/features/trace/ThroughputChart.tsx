import * as React from 'react';
import type { TraceStatsPoint } from '@/bridge/types';
import { formatNumber, formatTime } from '@/lib/format';

interface Anchor {
  at: number;
  value: number;
}

// 4-minute rolling window, same as the previous throughput chart.
const CHART_WINDOW_MS = 4 * 60 * 1000;

// Dot-matrix render parameters (locked during design; see
// The renderer keeps this deterministic so visual and packaged smoke tests agree.
const PITCH = 5.0;        // grid cell size in CSS px
const DOT_MAX = 3.0;      // dot side at the curve top (dark, large)
const DOT_MIN = 1.0;      // dot side near the baseline (pale, small)
const ALPHA_MAX = 0.90;   // opacity at the curve top
const ALPHA_MIN = 0.20;   // opacity near the baseline (keeps it off the background)
const GAMMA = 0.9;        // dissolve curvature
const BAR_W = 24;         // bar width in CSS px: each request is a flat-topped column
const BASE_ROWS = 3;      // bottom rows always shown as a faint baseline grid
const BASE_ALPHA = 0.18;  // opacity of the baseline grid (keeps it off the background)

// No axes: the matrix fills the whole canvas edge-to-edge.
const PAD_T = 0;
const PAD_B = 0;
const PAD_L = 0;
const PAD_R = 0;

/**
 * Square-root scale keeps a 200-token request and a 60k-token request both
 * visible while staying gentler than log. norm maps a raw token value into
 * 0..1 against the window max.
 */
function norm(value: number, max: number): number {
  if (value <= 0) return 0;
  return Math.sqrt(value / max);
}

/** Cheap CSS-variable reader so canvas colors follow the active theme. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function toAnchors(series: readonly TraceStatsPoint[], now: number): Anchor[] {
  const windowStart = now - CHART_WINDOW_MS;
  const out: Anchor[] = [];
  for (const p of series) {
    const at = Date.parse(p.at);
    if (!Number.isFinite(at) || at < windowStart || at > now + 1000) continue;
    const value = Math.max(0, Number(p.tokens) || 0);
    out.push({ at, value });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
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
 * Dot-matrix bar chart. Each request is a flat-topped column centered on its
 * timestamp, `BAR_W` px wide, with height set by its raw token value (no
 * averaging, no EMA, no rise/fall ramp — that's what made it read as triangles).
 * Dots inside a bar grow and darken toward the top edge (drawing a crisp cap)
 * and shrink/fade toward the baseline. Columns between bars stay empty except
 * for a faint baseline grid. Painted on a rAF loop so the field slides left as
 * real time advances.
 */
function paint(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  anchors: Anchor[],
  now: number,
  colors: { slate: string; faint: string }
): void {
  const { gx0, gx1, gy1, gw, gh } = geo;
  const rows = Math.max(1, Math.floor(gh / PITCH));
  const max = Math.max(1, ...anchors.map(a => a.value));
  const rowY = (r: number): number => gy1 - (r + 0.5) * (gh / rows);
  const xForTime = (at: number): number => gx0 + (1 - (now - at) / CHART_WINDOW_MS) * gw;
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  // Each request becomes a flat-topped bar: precompute its screen-x and
  // normalized height. A grid column takes the height of any bar whose fixed
  // width covers it (max wins when two requests fall within one bar width).
  const bars = anchors.map(a => ({ x: xForTime(a.at), n: norm(a.value, max) }));
  const halfW = BAR_W / 2;
  const heightAt = (x: number): number => {
    let h = 0;
    for (const b of bars) {
      if (Math.abs(x - b.x) <= halfW && b.n > h) h = b.n;
    }
    return h;
  };

  // Dot columns scroll left in lockstep with the data instead of sitting on a
  // fixed screen grid. Without this, a moving bar's edges cross static columns
  // one at a time, so a single column flips on/off and the bar visibly shimmers
  // between widths. Anchoring the grid to elapsed time — the offset wraps every
  // PITCH px — makes the whole matrix slide continuously, so each column stays
  // fixed relative to its bar and nothing flickers.
  const pxPerMs = gw / CHART_WINDOW_MS;
  const phase = (((now * pxPerMs) % PITCH) + PITCH) % PITCH;

  for (let cx = gx0 - phase; cx <= gx1; cx += PITCH) {
    const cn = heightAt(cx);
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
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const seriesRef = React.useRef(series);
  seriesRef.current = series;

  const [hover, setHover] = React.useState<{ x: number; y: number; total: number; at: number } | null>(null);
  const [lastVal, setLastVal] = React.useState(0);
  const geoRef = React.useRef<Geometry | null>(null);
  const nowRef = React.useRef(Date.now());

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
    const now = Date.now();
    nowRef.current = now;
    const anchors = toAnchors(seriesRef.current, now);
    setLastVal(anchors.length ? anchors[anchors.length - 1].value : 0);
    paint(ctx, geo, anchors, now, {
      slate: cssVar('--slate'),
      faint: cssVar('--faint')
    });
  }, [measure]);

  // Slide left continuously while active; render once when idle.
  React.useEffect(() => {
    if (!active) { render(); return; }
    let raf = 0;
    let last = 0;
    const loop = (t: number): void => {
      raf = requestAnimationFrame(loop);
      if (t - last < 1000 / 30) return; // cap at 30fps
      last = t;
      render();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, series, render]);

  const onPointerMove = React.useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const geo = geoRef.current;
    if (!canvas || !geo) return;
    const rect = canvas.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * (canvas.width / (Math.min(window.devicePixelRatio || 1, 2)));
    const now = nowRef.current;
    const anchors = toAnchors(seriesRef.current, now);
    if (!anchors.length) { setHover(null); return; }
    const xForTime = (at: number): number => geo.gx0 + (1 - (now - at) / CHART_WINDOW_MS) * geo.gw;
    let best = anchors[0];
    let bestD = Infinity;
    for (const a of anchors) {
      const d = Math.abs(xForTime(a.at) - rx);
      if (d < bestD) { bestD = d; best = a; }
    }
    const max = Math.max(1, ...anchors.map(a => a.value));
    const cssW = canvas.width / (Math.min(window.devicePixelRatio || 1, 2));
    const cssH = canvas.height / (Math.min(window.devicePixelRatio || 1, 2));
    const px = (xForTime(best.at) / cssW) * rect.width;
    const py = ((geo.gy1 - norm(best.value, max) * geo.gh) / cssH) * rect.height;
    // Clamp to the chart's real width (leaving room for the tip's own half-width)
    // so the label tracks the hovered bar instead of pinning to a fixed x.
    const clampedX = Math.max(60, Math.min(rect.width - 60, px));
    setHover({ x: clampedX, y: py, total: best.value, at: best.at });
  }, []);

  return (
    <div className="chart" id="throughputChart">
      <div className="chart-now" id="chartNow">最新请求 {formatNumber(lastVal)} tokens</div>
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
        aria-label="吞吐量点阵图"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      />
    </div>
  );
}
