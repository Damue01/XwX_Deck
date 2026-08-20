import * as React from 'react';
import { Minus, Maximize2, Minimize2, X } from 'lucide-react';
import { getApi } from '@/bridge/api';

interface Props {
  readonly isMaximized: boolean;
  readonly nativeFrame: boolean;
}

export function Titlebar({ isMaximized, nativeFrame }: Props): React.ReactElement {
  const api = getApi();

  const onPointerDown = React.useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (nativeFrame) return;
    if ((e.target as HTMLElement).closest('button')) return;
    api.moveWindowStart({ screenX: e.screenX, screenY: e.screenY });
    const onMove = (ev: PointerEvent) => api.moveWindow({ screenX: ev.screenX, screenY: ev.screenY });
    const onUp = () => {
      api.moveWindowEnd();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [api, nativeFrame]);

  return (
    <header
      className={`titlebar${nativeFrame ? ' native-frame' : ''}`}
      onPointerDown={onPointerDown}
    >
      <div className="brand">XwX Deck</div>
      {!nativeFrame && <div className="win" aria-label="窗口控制">
        <button
          type="button"
          className="wc"
          aria-label="最小化"
          onClick={() => void api.minimizeWindow()}
        >
          <Minus size={16} />
        </button>
        <button
          type="button"
          className="wc"
          aria-label={isMaximized ? '还原' : '最大化'}
          onClick={() => void api.toggleMaximize()}
        >
          {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button
          type="button"
          className="wc close"
          aria-label="关闭"
          onClick={() => void api.closeWindow()}
        >
          <X size={16} />
        </button>
      </div>}
    </header>
  );
}
