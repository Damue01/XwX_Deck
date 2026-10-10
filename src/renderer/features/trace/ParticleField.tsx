import * as React from 'react';
import { isDesktop } from '@/bridge/api';

interface Props {
  readonly scale?: number;
  /** Extra drift for surfaces that want a visibly flowing field (onboarding). 0 keeps the Trace look. */
  readonly flow?: number;
}

const RIPPLE_EVENT = 'xwx:field-ripple';
const RIPPLE_LIFE_MS = 1800;
const MAX_RIPPLES = 4;

interface Ripple {
  readonly x: number;
  readonly y: number;
  readonly start: number;
}

/**
 * Sends a water ripple through the dot field from a viewport point. Used as
 * the immediate response to the Trace dial: the wave starts on the same frame
 * as the click, long before the backend finishes switching.
 */
export function emitFieldRipple(clientX: number, clientY: number): void {
  document.dispatchEvent(new CustomEvent<{ x: number; y: number }>(RIPPLE_EVENT, { detail: { x: clientX, y: clientY } }));
}

/** Collects ripples in canvas-local CSS pixels and drops them once spent. */
function trackRipples(canvas: HTMLCanvasElement): { readonly list: () => readonly Ripple[]; readonly stop: () => void } {
  let ripples: Ripple[] = [];
  const onRipple = (event: Event) => {
    const detail = (event as CustomEvent<{ x: number; y: number }>).detail;
    if (!detail) return;
    const rect = canvas.getBoundingClientRect();
    ripples = [...ripples, { x: detail.x - rect.left, y: detail.y - rect.top, start: performance.now() }].slice(-MAX_RIPPLES);
  };
  document.addEventListener(RIPPLE_EVENT, onRipple);
  return {
    list: () => {
      const now = performance.now();
      if (ripples.length && now - ripples[0].start > RIPPLE_LIFE_MS) ripples = ripples.filter(r => now - r.start <= RIPPLE_LIFE_MS);
      return ripples;
    },
    stop: () => document.removeEventListener(RIPPLE_EVENT, onRipple)
  };
}

/** Target for the field's live blend (the page already shows the requested state). */
function liveTarget(): number {
  return document.body.dataset.capturing === 'true' ? 1 : 0;
}

function isDay(): boolean {
  return document.documentElement.dataset.theme === 'day';
}

function pageIsActive(canvas: HTMLCanvasElement): boolean {
  // The onboarding surface hosts its own field outside the page stack.
  return !document.hidden && !!canvas.closest('.page.current, [data-field-host]');
}

function animate(
  canvas: HTMLCanvasElement,
  render: (time: number) => void,
  fps: () => number
): () => void {
  let frame = 0;
  let lastPaint = -Infinity;

  function tick(time: number): void {
    frame = 0;
    if (!pageIsActive(canvas)) return;
    // Small tolerance so a 30fps target is not rounded down to 20fps by
    // 60Hz frame timing jitter.
    if (time - lastPaint >= 1000 / fps() - 4) {
      lastPaint = time;
      render(time);
    }
    frame = requestAnimationFrame(tick);
  }

  function sync(): void {
    const active = pageIsActive(canvas);
    canvas.dataset.rendering = active ? 'active' : 'paused';
    if (active && !frame) frame = requestAnimationFrame(tick);
    if (!active && frame) { cancelAnimationFrame(frame); frame = 0; }
  }

  document.addEventListener('xwx:pagechange', sync);
  document.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    document.removeEventListener('xwx:pagechange', sync);
    document.removeEventListener('visibilitychange', sync);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
}

function observeCanvasResize(canvas: HTMLCanvasElement, onResize: () => void): () => void {
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(onResize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }
  window.addEventListener('resize', onResize, { passive: true });
  return () => window.removeEventListener('resize', onResize);
}

function initGL(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, scale: number, flow: number): (() => void) | undefined {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const OFF = 83.0;
  const VS = [
    'attribute vec2 a_position;',
    'void main(){gl_Position=vec4(a_position,0,1);}'
  ].join('\n');
  const FS = [
    'precision highp float;',
    'uniform vec2 u_resolution;',
    'uniform float u_time;',
    'uniform float u_theme;',
    'uniform float u_scale;',
    'uniform float u_live;',
    'uniform vec4 u_rip[4];',
    'uniform float u_ripScale;',
    'uniform float u_flow;',
    'float hash(vec2 p){float n=dot(p,vec2(127.1,311.7));return fract(sin(n)*43758.5453);}',
    'float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);vec2 u=f*f*(3.0-2.0*f);',
    'return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}',
    'float fbm(vec2 p){float v=0.0,w=0.5,t=0.0;for(int i=0;i<4;i++){v+=noise(p)*w;t+=w;p=p*2.03+vec2(17.1,9.2);w*=0.5;}return v/t;}',
    'float ss(float e0,float e1,float v){float x=clamp((v-e0)/(e1-e0),0.0,1.0);return x*x*(3.0-2.0*x);}',
    'float wave(float d,float age,float amp){float k=(d-age*0.55*u_ripScale)/(0.045*u_ripScale);return amp*exp(-k*k*0.6)*cos(k*2.4);}',
    'void main(){',
    '  vec2 frag=gl_FragCoord.xy;',
    '  float ripple=0.0;',
    '  for(int i=0;i<4;i++){vec4 rp=u_rip[i];if(rp.w>0.0){vec2 dv=frag-rp.xy;float d=length(dv);float w=wave(d,rp.z,rp.w);ripple+=w;frag-=d>0.5?dv/d*w*u_scale*0.4:vec2(0.0);}}',
    '  vec2 uv=frag/u_resolution;',
    '  float aspect=u_resolution.x/u_resolution.y;',
    '  vec2 grid=vec2(uv.x*aspect,uv.y)*u_resolution.y/u_scale;',
    '  float t=u_time*0.40;',
    '  grid+=vec2(t*u_flow*3.0,t*u_flow*0.9);',
    '  vec2 warp=vec2(fbm(grid*0.038+vec2(t*0.22,4.1))-0.5,fbm(grid*0.038+vec2(8.2,-t*0.17))-0.5);',
    '  float n1=fbm(grid*0.058+warp*0.92+vec2(t*0.52,t*0.13));',
    '  float n2=fbm(grid*0.030+vec2(-t*0.10,t*0.18));',
    '  float fine=fbm(grid*0.115+vec2(-t*0.14,t*0.10));',
    '  float main_v=clamp(((n1*0.76+n2*0.18-0.008)-0.5)*1.04+0.5,0.0,1.0);',
    '  float speckles=ss(0.50,0.82,fine)*0.12*(1.0-ss(0.42,0.82,main_v));',
    '  float growth=pow(ss(0.31,0.81,min(1.0,main_v+speckles)),1.08);',
    '  float r=1.0/(u_resolution.y/u_scale)*((0.028+growth*0.338)*(1.0+u_live*0.10)*(1.0+max(ripple,-0.7)*0.6)+max(ripple,0.0)*0.07);',
    '  vec2 cell=fract(grid)-0.5;',
    '  float dist=length(cell);',
    '  float dotAlpha=1.0-smoothstep(0.0,r*u_resolution.y/u_scale,dist*u_resolution.y/u_scale);',
    '  vec3 darkDot=vec3(0.965,0.965,0.965);',
    '  vec3 dayDot=vec3(0.045,0.047,0.043);',
    '  vec3 dotColor=mix(darkDot,dayDot,u_theme);',
    '  float dotStrength=mix(0.9,0.78,u_theme)*mix(1.0,1.18,u_live);',
    '  gl_FragColor=vec4(dotColor,dotAlpha*dotStrength);',
    '}'
  ].join('\n');

  function mk(type: number, src: string): WebGLShader {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }
  const p = gl.createProgram()!;
  const vertexShader = mk(gl.VERTEX_SHADER, VS);
  const fragmentShader = mk(gl.FRAGMENT_SHADER, FS);
  gl.attachShader(p, vertexShader);
  gl.attachShader(p, fragmentShader);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.deleteProgram(p);
    return undefined;
  }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, 1, 1, -1, -1, 1, -1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(p, 'a_position');
  const uRes = gl.getUniformLocation(p, 'u_resolution');
  const uTime = gl.getUniformLocation(p, 'u_time');
  const uTheme = gl.getUniformLocation(p, 'u_theme');
  const uScale = gl.getUniformLocation(p, 'u_scale');
  const uLive = gl.getUniformLocation(p, 'u_live');
  const uRip = gl.getUniformLocation(p, 'u_rip');
  const uRipScale = gl.getUniformLocation(p, 'u_ripScale');
  const uFlow = gl.getUniformLocation(p, 'u_flow');
  const ripples = trackRipples(canvas);
  const ripData = new Float32Array(MAX_RIPPLES * 4);

  let live = 0, simTime = 0, lastT: number | null = null, needsResize = true;
  const motionFactor = reduce ? 0.35 : 1;

  function resize(): void {
    if (!needsResize) return;
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    needsResize = false;
  }

  function render(time: number): void {
    resize();
    live += (liveTarget() - live) * 0.03;
    const dt = lastT === null ? 16 : Math.min(64, time - lastT);
    lastT = time;
    simTime += dt * 0.001 * (1 + live * 0.35) * (1 + flow) * motionFactor;
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(p); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, simTime + OFF);
    gl.uniform1f(uTheme, isDay() ? 1 : 0);
    gl.uniform1f(uScale, scale);
    gl.uniform1f(uLive, live);
    gl.uniform1f(uFlow, flow);
    // Ripple centres in device pixels (GL origin is bottom-left); age in
    // seconds, travel speed scales with the canvas diagonal.
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(1, rect.width), sy = canvas.height / Math.max(1, rect.height);
    ripData.fill(0);
    ripples.list().forEach((rp, i) => {
      const age = (performance.now() - rp.start) / 1000;
      const fade = Math.max(0, 1 - age * 1000 / RIPPLE_LIFE_MS);
      ripData.set([rp.x * sx, canvas.height - rp.y * sy, age, fade * fade * (reduce ? 0.6 : 1)], i * 4);
    });
    gl.uniform4fv(uRip, ripData);
    gl.uniform1f(uRipScale, Math.hypot(canvas.width, canvas.height));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  const stopObserving = observeCanvasResize(canvas, () => { needsResize = true; });
  const stopAnimating = animate(canvas, render, () => (reduce && ripples.list().length === 0 ? 12 : 30));
  return () => {
    stopAnimating();
    stopObserving();
    ripples.stop();
    if (buf) gl.deleteBuffer(buf);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.deleteProgram(p);
  };
}

function init2D(canvas: HTMLCanvasElement, density: number, flow: number): (() => void) | undefined {
  const rawCtx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!rawCtx) return undefined;
  const ctx: CanvasRenderingContext2D = rawCtx;
  // Respect reduced-motion, but keep it clearly animated: remote-desktop (RDP)
  // sessions report prefers-reduced-motion=reduce, and fully throttling the
  // loop there made the field look frozen. Slow it down instead of stopping it.
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // A flowing field needs smoother frames than the idle Trace field.
  const fps = flow > 0 && !reduce ? 30 : 15;
  const speed = reduce ? 0.65 : 1;
  const OFF = 83.0;
  let w = 1, h = 1, dpr = 1, needsResize = true;
  let live = 0, simTime = OFF, lastT: number | null = null;

  function ss(e0: number, e1: number, v: number): number { const x = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return x * x * (3 - 2 * x); }
  function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
  function hash2(x: number, y: number): number {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  }
  function noise(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    return mix(mix(hash2(ix, iy), hash2(ix + 1, iy), ux), mix(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), ux), uy);
  }
  function fbm(x: number, y: number): number {
    let value = 0, weight = 0.5, total = 0;
    for (let i = 0; i < 4; i++) {
      value += noise(x, y) * weight; total += weight;
      x = x * 2.03 + 17.1; y = y * 2.03 + 9.2; weight *= 0.5;
    }
    return value / total;
  }
  function resize(): void {
    if (!needsResize) return;
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    needsResize = false;
  }
  function render(time: number): void {
    resize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = isDay() ? '#0b0c0b' : '#f4f4f4';
    live += (liveTarget() - live) * 0.09;
    const dt = lastT === null ? 16 : Math.min(80, time - lastT);
    lastT = time;
    simTime += dt * 0.001 * (1 + live * 0.35) * (1 + flow) * speed;
    const t = simTime * 0.40;
    // Translate the noise under the fixed dot grid so the pattern travels across the surface.
    const driftX = t * flow * 3.0, driftY = t * flow * 0.9;
    const step = Math.max(6, h / density);
    const strength = 0.78 * (1 + live * 0.18);
    // A ripple is a travelling ring with a crest and a softer trough behind
    // it; dots on the crest swell and are pushed outward, like floats on water.
    const now = performance.now();
    const diag = Math.hypot(w, h);
    const waves = ripples.list().map(rp => {
      const age = (now - rp.start) / 1000;
      const fade = Math.max(0, 1 - age * 1000 / RIPPLE_LIFE_MS);
      return { x: rp.x, y: rp.y, front: age * diag * 0.55, width: diag * 0.045, amp: fade * fade * (reduce ? 0.6 : 1) };
    });
    for (let y = -step; y < h + step; y += step) {
      for (let x = -step; x < w + step; x += step) {
        const gx = x / step + driftX, gy = y / step + driftY;
        const warpX = fbm(gx * 0.038 + t * 0.22, gy * 0.038 + 4.1) - 0.5;
        const warpY = fbm(gx * 0.038 + 8.2, gy * 0.038 - t * 0.17) - 0.5;
        const n1 = fbm(gx * 0.058 + warpX * 0.92 + t * 0.52, gy * 0.058 + warpY * 0.92 + t * 0.13);
        const n2 = fbm(gx * 0.030 - t * 0.10, gy * 0.030 + t * 0.18);
        const fine = fbm(gx * 0.115 - t * 0.14, gy * 0.115 + t * 0.10);
        const mainV = Math.max(0, Math.min(1, ((n1 * 0.76 + n2 * 0.18 - 0.008) - 0.5) * 1.04 + 0.5));
        const speckles = ss(0.50, 0.82, fine) * 0.12 * (1 - ss(0.42, 0.82, mainV));
        const growth = Math.pow(ss(0.31, 0.81, Math.min(1, mainV + speckles)), 1.08);
        let px = x, py = y, ripple = 0;
        for (const wv of waves) {
          const dx = x - wv.x, dy = y - wv.y;
          const d = Math.hypot(dx, dy);
          const k = (d - wv.front) / wv.width;
          if (k < -4 || k > 4) continue;
          const lift = wv.amp * Math.exp(-k * k * 0.6) * Math.cos(k * 2.4);
          ripple += lift;
          if (d > 0.5) { px += dx / d * lift * step * 0.4; py += dy / d * lift * step * 0.4; }
        }
        const radius = step * ((0.028 + growth * 0.338) * (1 + live * 0.10) * (1 + Math.max(ripple, -0.7) * 0.6) + Math.max(ripple, 0) * 0.07);
        if (radius <= 0.05) continue;
        ctx.globalAlpha = strength;
        ctx.beginPath(); ctx.arc(px, py, radius, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
  const ripples = trackRipples(canvas);
  const stopObserving = observeCanvasResize(canvas, () => { needsResize = true; });
  // The idle field only needs 15fps; a ripple moves fast, so it gets 30fps
  // for its short lifetime.
  const stopAnimating = animate(canvas, render, () => (ripples.list().length > 0 ? 30 : fps));
  return () => {
    stopAnimating();
    stopObserving();
    ripples.stop();
  };
}

export const ParticleField = React.memo(function ParticleField({ scale = 60, flow = 0 }: Props): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Desktop packaged app: disable hardware WebGL (can crash renderer during live-state changes).
    const gl = isDesktop() ? null : canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false });
    const glCleanup = gl ? initGL(canvas, gl, scale, flow) : undefined;
    if (glCleanup) {
      canvas.dataset.renderer = 'webgl';
      return glCleanup;
    } else {
      canvas.dataset.renderer = '2d';
      return init2D(canvas, scale, flow);
    }
  }, [scale, flow]);

  return (
    <canvas
      ref={canvasRef}
      className="field"
      data-scale={scale}
      aria-hidden="true"
    />
  );
});
