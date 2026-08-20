import * as React from 'react';
import { Check, ImagePlus, Shirt, Trash2, X } from 'lucide-react';
import type { XwXDeckRuntimeState, TraceAppearanceSnapshot, TraceSkin } from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { Toggle } from '@/features/shell/Toggle';
import { showToast } from '@/lib/toast';

interface Props {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

const SKINS: ReadonlyArray<{
  readonly id: TraceSkin;
  readonly name: string;
}> = [
  { id: 'classic', name: '经典' },
  { id: 'clean', name: '纯净' },
  { id: 'custom', name: '自定义' },
];

function operationError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function AppearanceButton({ id, onClick }: { readonly id: string; readonly onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      className="appearance-trigger"
      id={id}
      data-appearance-trigger
      aria-label="打开 Trace 外观"
      title="Trace 外观"
      onClick={onClick}
    >
      <Shirt aria-hidden="true" />
    </button>
  );
}

export function AppearanceDrawer({ open, onOpenChange }: Props): React.ReactElement {
  const bridge = useBridge();
  const appearance = bridge.runtime?.traceAppearance;
  const [busy, setBusy] = React.useState(false);
  const [overlayDraft, setOverlayDraft] = React.useState(appearance?.customImageOverlay ?? 42);

  React.useEffect(() => {
    setOverlayDraft(appearance?.customImageOverlay ?? 42);
  }, [appearance?.customImageOverlay]);

  React.useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open, onOpenChange]);

  const commit = React.useCallback(async (patch: Partial<TraceAppearanceSnapshot>) => {
    try {
      const next = await bridge.api.setTraceAppearance(patch);
      bridge.patch({ runtime: next });
    } catch (error) {
      showToast(operationError(error, '无法保存 Trace 外观'), 'error');
    }
  }, [bridge.api, bridge.patch]);

  const chooseImage = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await bridge.api.chooseTraceBackground();
      if (next) bridge.patch({ runtime: next });
    } catch (error) {
      showToast(operationError(error, '无法选择背景图片'), 'error');
    } finally {
      setBusy(false);
    }
  }, [bridge.api, bridge.patch, busy]);

  const selectSkin = React.useCallback((skin: TraceSkin) => {
    if (skin === 'custom' && !appearance?.customImageUrl) {
      void chooseImage();
      return;
    }
    void commit({ skin });
  }, [appearance?.customImageUrl, chooseImage, commit]);

  const removeImage = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await bridge.api.clearTraceBackground();
      bridge.patch({ runtime: next });
      showToast('自定义背景已移除', 'success');
    } catch (error) {
      showToast(operationError(error, '无法移除背景图片'), 'error');
    } finally {
      setBusy(false);
    }
  }, [bridge.api, bridge.patch, busy]);

  const activeSkin = appearance?.skin ?? 'classic';
  const showThroughput = appearance?.showThroughput !== false;

  return (
    <>
      <div
        className={`appearance-dismiss${open ? ' open' : ''}`}
        id="appearanceDismiss"
        aria-hidden="true"
        onPointerDown={() => onOpenChange(false)}
      />
      <aside
        className={`appearance-drawer${open ? ' open' : ''}`}
        id="appearanceDrawer"
        aria-label="Trace 外观"
        aria-hidden={!open}
        inert={open ? undefined : true}
      >
        <div className="appearance-head">
          <h2>外观</h2>
          <button type="button" className="appearance-close" aria-label="关闭外观设置" onClick={() => onOpenChange(false)}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="appearance-body">
          <section className="appearance-section" aria-labelledby="skinTitle">
            <h3 id="skinTitle">皮肤</h3>
            <div className="skin-list" role="radiogroup" aria-label="Trace 皮肤">
              {SKINS.map(skin => {
                const selected = activeSkin === skin.id;
                return (
                  <button
                    key={skin.id}
                    type="button"
                    className={`skin-option${selected ? ' selected' : ''}`}
                    data-skin={skin.id}
                    role="radio"
                    aria-checked={selected}
                    onClick={() => selectSkin(skin.id)}
                  >
                    <span className={`skin-thumb ${skin.id}`} aria-hidden="true">
                      {skin.id === 'custom' && appearance?.customImageUrl ? (
                        <span style={{ backgroundImage: `url(${appearance.customImageUrl})` }} />
                      ) : skin.id === 'custom' ? <ImagePlus /> : null}
                    </span>
                    <span className="skin-copy">
                      <strong>{skin.name}</strong>
                    </span>
                    <span className="skin-radio" aria-hidden="true">{selected ? <Check /> : null}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {activeSkin === 'custom' && appearance?.customImageUrl ? (
            <section className="appearance-section custom-background-settings" aria-label="自定义背景设置">
              <div className="appearance-row action-row">
                <span>背景图片</span>
                <span className="appearance-actions">
                  <button type="button" className="txt-action" disabled={busy} onClick={() => void chooseImage()}>更换</button>
                  <button type="button" className="appearance-remove" disabled={busy} aria-label="移除自定义背景" title="移除图片" onClick={() => void removeImage()}>
                    <Trash2 aria-hidden="true" />
                  </button>
                </span>
              </div>
              <div className="appearance-row fit-row">
                <span>填充方式</span>
                <div className="appearance-segments" role="group" aria-label="图片填充方式">
                  <button type="button" aria-pressed={appearance.customImageFit === 'cover'} onClick={() => void commit({ customImageFit: 'cover' })}>覆盖</button>
                  <button type="button" aria-pressed={appearance.customImageFit === 'contain'} onClick={() => void commit({ customImageFit: 'contain' })}>适应</button>
                </div>
              </div>
              <label className="appearance-row overlay-row">
                <span>遮罩强度</span>
                <input
                  type="range"
                  min="0"
                  max="80"
                  step="1"
                  value={overlayDraft}
                  aria-label="背景图片遮罩强度"
                  onChange={event => {
                    const value = Number(event.target.value);
                    setOverlayDraft(value);
                    const overlay = document.getElementById('traceCustomOverlay');
                    if (overlay) overlay.style.opacity = String(value / 100);
                  }}
                  onPointerUp={event => void commit({ customImageOverlay: Number(event.currentTarget.value) })}
                  onKeyUp={event => void commit({ customImageOverlay: Number(event.currentTarget.value) })}
                  onBlur={event => void commit({ customImageOverlay: Number(event.currentTarget.value) })}
                />
                <output>{overlayDraft}%</output>
              </label>
            </section>
          ) : null}

          <section className="appearance-section modules-section" aria-labelledby="modulesTitle">
            <h3 id="modulesTitle">页面模块</h3>
            <div className="appearance-row module-row">
              <span className="appearance-row-copy">
                <strong>流量图</strong>
              </span>
              <Toggle
                id="throughputVisibilityToggle"
                checked={showThroughput}
                ariaLabel="显示流量图"
                title={showThroughput ? '隐藏流量图' : '显示流量图'}
                onToggle={() => void commit({ showThroughput: !showThroughput })}
              />
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}

export function customBackgroundStyle(runtime: XwXDeckRuntimeState | null): React.CSSProperties | undefined {
  const appearance = runtime?.traceAppearance;
  if (appearance?.skin !== 'custom' || !appearance.customImageUrl) return undefined;
  return {
    backgroundImage: `url(${appearance.customImageUrl})`,
    backgroundSize: appearance.customImageFit,
  };
}
