;(function installWebviewCommon() {
  const segmentedMemory = new Map();
  const byId = (id, root = document) => root.querySelector(`#${CSS.escape(id)}`);
  const formatNumber = (value, locale = 'zh-CN') => (
    Math.max(0, Math.round(Number(value) || 0)).toLocaleString(locale)
  );
  const formatRate = value => {
    const number = Math.max(0, Number(value) || 0);
    return number >= 1000 ? `${(number / 1000).toFixed(1)}K` : String(Math.round(number));
  };
  const formatTime = value => {
    const date = value instanceof Date ? value : new Date(String(value || ''));
    return Number.isFinite(date.getTime())
      ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      : '--:--';
  };
  const formatDuration = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return number < 1000 ? `${number}ms` : `${(number / 1000).toFixed(1)}s`;
  };
  const compactNumber = value => {
    const number = Math.max(0, Math.round(Number(value) || 0));
    if (number >= 1e9) return { value: (number / 1e9).toFixed(2).replace(/\.?0+$/, ''), unit: 'B' };
    if (number >= 1e6) return { value: (number / 1e6).toFixed(2).replace(/\.?0+$/, ''), unit: 'M' };
    if (number >= 1e3) return { value: (number / 1e3).toFixed(1).replace(/\.?0+$/, ''), unit: 'K' };
    return { value: String(number), unit: '' };
  };
  const createToast = (options = {}) => {
    let timer = 0;
    return (message, duration = options.duration ?? 2200) => {
      let node = options.node ?? byId(options.nodeId || 'toast');
      if (!node && options.create) node = options.create();
      if (!node) return;
      node.textContent = String(message || '操作失败');
      node.style.display = 'block';
      if (options.visibleClass) node.classList.add(options.visibleClass);
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (options.visibleClass) node?.classList.remove(options.visibleClass);
        else if (node) node.style.display = 'none';
      }, duration);
    };
  };
  const activateSegment = (button, selector = 'button', activeClass) => {
    const segment = button.parentElement;
    if (!segment) return;
    segment.querySelectorAll(`:scope > ${selector}`).forEach(item => {
      const active = item === button;
      item.setAttribute('aria-pressed', String(active));
      if (activeClass) item.classList.toggle(activeClass, active);
    });
  };
  const segmentKey = segment => {
    if (segment.classList.contains('modeseg')) return 'modeseg';
    if (segment.classList.contains('dash-filters')) return 'dash-filters';
    if (segment.classList.contains('fmt-bar')) return 'fmt-bar';
    return segment.className;
  };
  const placeSegmentedThumb = (segment, mode = 'place') => {
    if (!segment) return;
    const thumb = segment.querySelector(':scope > .seg-thumb');
    if (!thumb) return;
    const active = segment.querySelector(':scope > button.active')
      || segment.querySelector(':scope > button');
    if (!active) {
      thumb.style.opacity = '0';
      return;
    }
    const target = { x: active.offsetLeft, w: active.offsetWidth };
    const key = segmentKey(segment);
    const apply = animate => {
      if (!animate) thumb.style.transition = 'none';
      thumb.style.opacity = '1';
      thumb.style.width = `${target.w}px`;
      thumb.style.transform = `translateX(${target.x}px)`;
      if (!animate) {
        void thumb.offsetWidth;
        thumb.style.transition = '';
      }
    };
    if (mode === 'click') apply(true);
    else if (mode === 'instant') apply(false);
    else {
      const previous = segmentedMemory.get(key);
      if (previous && (previous.x !== target.x || previous.w !== target.w)) {
        thumb.style.transition = 'none';
        thumb.style.opacity = '1';
        thumb.style.width = `${previous.w}px`;
        thumb.style.transform = `translateX(${previous.x}px)`;
        void thumb.offsetWidth;
        thumb.style.transition = '';
        requestAnimationFrame(() => apply(true));
      } else apply(false);
    }
    segmentedMemory.set(key, target);
  };
  const positionSegmentedThumbs = (root = document, mode = 'place') => {
    root.querySelectorAll('.modeseg, .dash-filters, .fmt-bar')
      .forEach(segment => placeSegmentedThumb(segment, mode));
  };
  const tokenCostPresentation = options => {
    const english = options.language === 'en';
    if (options.showCost) {
      return {
        label: 'USD',
        value: Number(options.costUsd || 0).toFixed(2),
        unit: '$',
        toggleHint: english ? 'Show Token usage' : '点击查看 Token 使用量'
      };
    }
    const number = options.compact ? compactNumber(options.tokens) : { value: formatNumber(options.tokens), unit: '' };
    return {
      label: 'TOKENS',
      value: number.value,
      unit: number.unit,
      toggleHint: english ? 'Show estimated cost' : '点击查看费用'
    };
  };
  const createTokenCostHero = options => {
    let showCost = false;
    let frame = 0;
    let displayed = 0;
    let displayedMode = 'tokens';
    let hasRendered = false;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const paintValue = value => {
      displayed = value;
      const text = showCost ? `$${value.toFixed(2)}` : formatNumber(value);
      options.value.textContent = text;
      const length = text.length;
      options.value.dataset.range = length >= 16 ? 'extra-wide' : length >= 12 ? 'wide' : 'normal';
    };
    const render = () => {
      const stats = options.stats() || {};
      const mode = showCost ? 'cost' : 'tokens';
      const target = Math.max(0, Number(showCost ? stats.costUsd : stats.tokens) || 0);
      const presentation = tokenCostPresentation({
        showCost,
        tokens: stats.tokens,
        costUsd: stats.costUsd,
        language: options.language?.() || 'zh'
      });
      options.label.textContent = presentation.label;
      options.root.title = presentation.toggleHint;
      options.root.setAttribute('aria-label', presentation.toggleHint);
      cancelAnimationFrame(frame);
      const startValue = displayedMode === mode ? displayed : 0;
      displayedMode = mode;
      if (!options.animate || reducedMotion || !hasRendered || startValue === target) {
        paintValue(target);
        hasRendered = true;
        return;
      }
      const startedAt = performance.now();
      const duration = 560;
      const tick = now => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        paintValue(startValue + (target - startValue) * eased);
        if (progress < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      hasRendered = true;
    };
    const toggle = () => {
      showCost = !showCost;
      render();
    };
    options.root.addEventListener('click', toggle);
    options.root.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
    return { render, toggle, isShowingCost: () => showCost };
  };

  Object.assign(window, {
    XwXWebview: Object.freeze({
      byId,
      formatNumber,
      formatRate,
      formatTime,
      formatDuration,
      compactNumber,
      createToast,
      activateSegment,
      placeSegmentedThumb,
      positionSegmentedThumbs,
      tokenCostPresentation,
      createTokenCostHero
    })
  });
})();
