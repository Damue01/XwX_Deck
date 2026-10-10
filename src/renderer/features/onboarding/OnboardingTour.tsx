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
    page: 'models',
    selector: '[data-tour="models-proxy"]',
    title: '一步切换模型服务',
    lead: '为 Claude 或 ChatGPT 选择已保存的服务和模型，XwX Deck 会替你写好客户端配置。',
    points: [
      <>{t("未选择时保留客户端原有的登录和连接。")}</>
    ]
  },
  {
    page: 'signal',
    selector: '#captureBtn',
    title: '开始 Trace',
    lead: '点击开始记录，然后在客户端发一条新消息，这里就会出现记录。',
    points: [
      <>{t("再次点击停止记录，模型服务设置保持不变。")}</>,
      <>{t("点中间的数字，可在")}<b>Token</b>{t("与")}<b>{t("费用")}</b>{t("之间切换。")}</>
    ]
  },
  {
    page: 'signal',
    selector: '#dashBtn',
    title: '查看每次请求',
    lead: '在仪表盘逐条查看请求的模型、Token、耗时和原始内容。',
    points: [
      <>{t("可以按会话或客户端筛选。")}</>
    ]
  }
]; }

const STORAGE_KEY = 'xwx-deck.onboardingSeen';
const PAD = 8; // 高亮框外扩

interface Rect { top: number; left: number; width: number; height: number; round: boolean; }

function navigateTo(page: PageId): void {
  window.dispatchEvent(new CustomEvent('xwxdeck:navigate', { detail: page }));
}

export function OnboardingTour(): React.ReactElement | null {
  const language = useLanguage();
  const [active, setActive] = React.useState<boolean>(() => {
    try {
      const query = new URLSearchParams(location.search);
      if (query.get('tour') === '1') return true;
      if (query.has('scenario')) return false;
      if (query.get('appearance') === '1') return false;
      return localStorage.getItem(STORAGE_KEY) !== 'true';
    } catch { return true; }
  });
  const [preparing, setPreparing] = React.useState(true);
  const [index, setIndex] = React.useState(0);
  const [rect, setRect] = React.useState<Rect | null>(null);

  const STEPS = React.useMemo(tourSteps, [language]);
  const step = STEPS[index];

  const finish = React.useCallback(() => {
    try { localStorage.setItem(STORAGE_KEY, 'true'); } catch { /* ignore */ }
    setActive(false);
    navigateTo('signal');
  }, []);

  React.useEffect(() => {
    if (!active || preparing) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, preparing, finish]);

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

  if (preparing) return <OnboardingSetup onDone={() => setPreparing(false)} onSkip={finish} />;

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
              {last ? t('开始使用') : t('下一步')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
