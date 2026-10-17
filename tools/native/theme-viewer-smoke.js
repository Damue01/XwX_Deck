(() => {
  const themes = [];
  let last = '';
  setInterval(() => {
    const preference = state.theme;
    if (!['night', 'day', 'system'].includes(preference) || last === preference) return;
    const expected = preference === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day') : preference;
    if (document.documentElement.dataset.theme !== expected) return;
    const style = getComputedStyle(document.body);
    if (style.backgroundColor !== (expected === 'night' ? 'rgb(19, 20, 22)' : 'rgb(252, 252, 251)')) return;
    if (bytes(state.storage?.totalBytes) !== '15 GB' || bytes(1062754382) !== '1014 MB' || bytes(1099511627776) !== '1.0 TB') return;
    last = preference; themes.push(preference);
    void fetch('/__native-viewer-smoke', { method: 'POST', body: JSON.stringify({ passed: true, themes, resolved: expected, nativeWebView: true, capacity: bytes(state.storage?.totalBytes) }) });
  }, 100);
})();
