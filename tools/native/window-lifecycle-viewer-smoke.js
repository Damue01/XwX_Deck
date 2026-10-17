(() => {
  const openedAt = Date.now();
  const timer = setInterval(() => {
    const hero = document.querySelector('.dash-hero');
    if (!hero || hero.getBoundingClientRect().height <= 0 || document.body.innerText.trim().length < 20) return;
    clearInterval(timer);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      void fetch('/__native-viewer-smoke', { method: 'POST', body: JSON.stringify({ passed: true, openedAt, title: document.title, width: innerWidth, height: innerHeight, nativeWebView: true }) });
    }));
  }, 50);
})();
