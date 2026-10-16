import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ParticleField } from '../../src/renderer/features/trace/ParticleField';

// Reuse the product's actual point field; this local entry has no native bridge.
const host = document.getElementById('hero-field');
if (host) {
  document.documentElement.dataset.theme = 'day';
  function HeroField(): React.ReactElement {
    const reduce = React.useMemo(() => matchMedia('(prefers-reduced-motion: reduce)'), []);
    const [visible, setVisible] = React.useState(true);
    const [mode, setMode] = React.useState(document.body.dataset.fieldMotion || 'flow');
    const [reduced, setReduced] = React.useState(reduce.matches);
    const [frozen, setFrozen] = React.useState(false);
    React.useEffect(() => {
      const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
      observer.observe(host!);
      const update = () => { setMode(document.body.dataset.fieldMotion || 'flow'); setFrozen(false); };
      const onMotion = () => { setReduced(reduce.matches); setFrozen(false); };
      document.addEventListener('preview:field', update);
      reduce.addEventListener('change', onMotion);
      return () => { observer.disconnect(); document.removeEventListener('preview:field', update); reduce.removeEventListener('change', onMotion); };
    }, [reduce]);
    React.useEffect(() => {
      if ((!reduced && mode !== 'still') || !visible) return;
      // Stop after the first paints, retaining the canvas image for reduced motion.
      const timer = setTimeout(() => setFrozen(true), 240);
      return () => clearTimeout(timer);
    }, [reduced, mode, visible]);
    return <ParticleField scale={110} dotSize={0.62} flow={0.08} active={visible && !frozen && mode !== 'off'} />;
  }
  createRoot(host).render(<HeroField />);
}
