// Preview preferences affect this browser demo only; no desktop configuration.
try { localStorage.setItem('xwx-deck.sidebar', 'collapsed'); } catch { /* usable without storage */ }
import('../site/app-entry').then(() => {
  const api = (window as any).xwxDeck;
  api.openDashboard = async () => {
    if (window.parent !== window) window.parent.postMessage({ deckDashboard: true }, location.origin);
    else window.open(new URL('./design-lab-view.html', location.href).href, '_blank', 'noopener');
  };
});
