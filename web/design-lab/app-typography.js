// Browser demo only. This script is never bundled into the desktop application.
(() => {
  const key = 'xwx-deck-app-typography-preview-v1';
  let mode = 'balanced';
  try { if (localStorage.getItem(key) === 'original') mode = 'original'; } catch { /* Optional storage. */ }
  function apply(next, persist = false) {
    if (!['original', 'balanced'].includes(next)) return;
    mode = next;
    document.documentElement.dataset.appTypography = mode;
    document.querySelectorAll('[data-app-font]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.appFont === mode)));
    if (persist) try { localStorage.setItem(key, mode); } catch { /* Preview still works. */ }
  }
  apply(mode);
  addEventListener('message', event => {
    if (event.origin === location.origin && event.source === window.parent) apply(event.data?.deckTypography);
  });
  addEventListener('storage', event => { if (event.key === key) apply(event.newValue); });
  // Standalone previews offer the same A/B comparison as the website panel.
  if (window.parent === window) addEventListener('DOMContentLoaded', () => {
    const controls = document.createElement('details');
    controls.className = 'app-font-preview';
    controls.open = true;
    controls.innerHTML = '<summary>字体预览</summary><div role="group" aria-label="软件字体版本"><button type="button" data-app-font="original">原版</button><button type="button" data-app-font="balanced">新字体</button></div>';
    document.body.append(controls);
    controls.querySelectorAll('[data-app-font]').forEach(button => button.addEventListener('click', () => apply(button.dataset.appFont, true)));
    apply(mode);
  }, { once: true });
})();
