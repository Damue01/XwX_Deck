import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { OnboardingSetup } from './OnboardingSetup';
import type { PageId } from '@/features/shell/Rail';

/** 一步导览：切到哪页、高亮哪个真实元素、气泡文案。 */
interface TourStep {
  readonly page: PageId;
  /** 目标元素的 CSS 选择器（真实控件）。 */
  readonly selector: string;
  readonly title: string;
  /** 引导语一句话。 */
  readonly lead: string;
  /** 补充要点，逐条列出。 */
  readonly points?: readonly React.ReactNode[];
}

function tourSteps(): readonly TourStep[] { return [
  {
    page: 'settings',
    selector: '#provider-add',
    title: '添加配置',
    lead: '在我的配置中添加模型服务，填写服务地址和 API Key，也可以导入已有配置'
  },
  {
    page: 'models',
    selector: '[data-tour="models-proxy"]',
    title: '切换模型',
    lead: '为客户端选择已添加的配置和模型，XwX Deck 会写入对应的客户端配置'
  },
  {
    page: 'signal',
    selector: '#captureBtn',
    title: '按需开启 Trace',
    lead: '记录已接入客户端的请求，需要时在本地转换协议',
    points: [
      <>{t('标为“需 Trace”的模型需要开启 Trace 才能使用')}</>
    ]
  },
  {
    page: 'signal',
    selector: '#dashBtn',
    title: '在仪表盘查看详情',
    lead: '开启 Trace 后，在客户端发送一条消息，再到仪表盘确认实际使用的模型和请求结果'
  }
]; }

const STORAGE_KEY = 'xwx-deck.onboardingSeen';
const PROGRESS_KEY = 'xwx-deck.onboardingProgress.v1';
interface Progress { preparing: boolean; setupStep: number; index: number; }
function readProgress(): Progress {
  const initial = { preparing: true, setupStep: 0, index: 0 };
  try {
    if (new URLSearchParams(location.search).get('tour') === '1') return initial;
    const value = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? 'null');
    if (value && typeof value.preparing === 'boolean' && Number.isInteger(value.setupStep)
      && value.setupStep >= 0 && value.setupStep <= 2 && Number.isInteger(value.index)
      && value.index >= 0 && value.index < 4) return value;
  } catch { /* Unavailable or invalid storage starts a fresh guide. */ }
  return initial;
}
const PAD = 8; // 高亮框外扩

interface Rect { top: number; left: number; width: number; height: number; round: boolean; }

function navigateTo(page: PageId): void {
  window.dispatchEvent(new CustomEvent('xwxdeck:navigate', { detail: page }));
}

export function OnboardingTour(): React.ReactElement | null {
  const language = useLanguage();
  const [initial] = React.useState(readProgress);
  const [active, setActive] = React.useState<boolean>(() => {
    try {
      const query = new URLSearchParams(location.search);
      if (query.get('tour') === '1') return true;
      if (query.has('scenario')) return false;
      if (query.get('appearance') === '1') return false;
      return localStorage.getItem(STORAGE_KEY) !== 'true';
    } catch { return true; }
  });
  const [preparing, setPreparing] = React.useState(initial.preparing);
  const [setupStep, setSetupStep] = React.useState(initial.setupStep);
  const [index, setIndex] = React.useState(initial.index);
  const [rect, setRect] = React.useState<Rect | null>(null);

  const STEPS = React.useMemo(tourSteps, [language]);
  const step = STEPS[index];

  const finish = React.useCallback(() => {
    try { localStorage.setItem(STORAGE_KEY, 'true'); localStorage.removeItem(PROGRESS_KEY); } catch { /* ignore */ }
    setActive(false);
    navigateTo('signal');
  }, []);

  React.useLayoutEffect(() => {
    if (!active) return;
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify({ preparing, setupStep, index })); } catch { /* ignore */ }
  }, [active, preparing, setupStep, index]);

  React.useEffect(() => {
    if (!active || preparing) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setActive(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, preparing]);

  React.useEffect(() => {
    if (active) document.body.dataset.tourActive = 'true';
    else delete document.body.dataset.tourActive;
    return () => { delete document.body.dataset.tourActive; };
  }, [active]);

  // Switch the underlying page before paint. During the tour page transitions
  // are disabled, so the spotlight can move directly between stable targets
  // instead of exposing an intermediate faded/scaled page.
  React.useLayoutEffect(() => {
    if (!active || !step) return;
    navigateTo(step.page);
  }, [active, preparing, step]);

  // 定位目标元素（等切页后渲染出来，轮询一小段时间直到量到）
  React.useLayoutEffect(() => {
    if (!active || preparing || !step) return;
    let raf = 0;
    let tries = 0;
    let observedTarget: HTMLElement | null = null;
    let observedLayout: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const observeLayout = (el: HTMLElement) => {
      if (!resizeObserver || observedTarget === el) return;
      resizeObserver.disconnect();
      observedTarget = el;
      observedLayout = el.closest<HTMLElement>('.page-inner');
      resizeObserver.observe(el);
      if (observedLayout) resizeObserver.observe(observedLayout);
    };

    const measure = () => {
      const el = document.querySelector(step.selector) as HTMLElement | null;
      if (el) {
        const page = el.closest<HTMLElement>('.page');
        const pageReady = !page
          || (page.classList.contains('current') && getComputedStyle(page).transform === 'none');
        const r = el.getBoundingClientRect();
        if (pageReady && r.width > 0 && r.height > 0) {
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height, round: (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) >= Math.min(r.width, r.height) / 2 - 1 });
          observeLayout(el);
          return;
        }
      }
      if (tries++ < 40) raf = requestAnimationFrame(measure); // ~0.6s 内重试
    };
    resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => measure());
    // Retain the previous spotlight until the next real target is measurable.
    // Clearing it here rendered one full-screen dark frame on every Next click.
    measure();
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [active, preparing, step]);

  if (!active || !step) return null;

  if (preparing) return <OnboardingSetup initialStep={setupStep} onStepChange={setSetupStep}
    onDone={() => setPreparing(false)} onSkip={finish} onDismiss={() => setActive(false)} />;

  const last = index === STEPS.length - 1;

  // 气泡贴着高亮框；下方空间够就放下方，否则放上方。
  // 两种情况都把可用高度算出来给 maxHeight，超高则气泡内部滚动，保证矮窗口也能看全。
  const GAP = PAD + 12;
  const MARGIN = 16;
  const spaceBelow = rect ? window.innerHeight - (rect.top + rect.height) - GAP - MARGIN : 0;
  const spaceAbove = rect ? rect.top - GAP - MARGIN : 0;
  const bubbleBelow = spaceBelow >= spaceAbove;
  const bubbleStyle: React.CSSProperties = rect
    ? {
        top: bubbleBelow ? rect.top + rect.height + GAP : undefined,
        bottom: bubbleBelow ? undefined : window.innerHeight - rect.top + GAP,
        left: Math.max(MARGIN, Math.min(rect.left, window.innerWidth - 400 - MARGIN)),
        maxHeight: Math.max(180, (bubbleBelow ? spaceBelow : spaceAbove))
      }
    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', maxHeight: window.innerHeight - 2 * MARGIN };

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-label={t("新手引导")} data-tour-index={index}>
      {/* 四块遮罩围出高亮洞；无 rect 时整屏遮罩 */}
      {rect ? (
        <div
          className="tour-spotlight"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: rect.round ? 999 : undefined
          }}
        />
      ) : (
        <div className="tour-backdrop-full" />
      )}

      <div className="tour-bubble" style={bubbleStyle}>
        <div className="tour-content">
          <h3 className="tour-title">{t(step.title)}</h3>
          <p className="tour-body">{t(step.lead)}</p>
          {step.points && step.points.length > 0 && (
            <ul className="tour-points">
              {step.points.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
        </div>
        <div className="tour-foot">
          <div className="tour-dots" aria-hidden="true">
            {STEPS.map((_, i) => <i key={i} className={i === index ? 'on' : undefined} />)}
          </div>
          <div className="tour-actions">
            {index === 0
              ? <button type="button" className="tour-skip" onClick={finish}>{t("跳过")}</button>
              : <button type="button" className="tour-back" onClick={() => setIndex(index - 1)}>{t("上一步")}</button>}
            <button
              type="button"
              className="tour-next"
              onClick={() => (last ? finish() : setIndex(index + 1))}
            >
              {last ? t('完成') : t('下一步')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
