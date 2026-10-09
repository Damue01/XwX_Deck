import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { Check, ImagePlus, Shirt, Trash2, X } from 'lucide-react';
import type { XwXDeckRuntimeState, TraceAppearanceSnapshot, TraceSkin } from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { Toggle } from '@/features/shell/Toggle';
import { showErrorToast, showToast } from '@/lib/toast';

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

export function AppearanceButton({ id, onClick }: { readonly id: string; readonly onClick: () => void }): React.ReactElement {
  useLanguage();
  return (
    <button
      type="button"
      className="appearance-trigger"
      id={id}
      data-appearance-trigger
      aria-label={t("打开 Trace 外观")}
      title={t("Trace 外观")}
      onClick={onClick}
    >
      <Shirt aria-hidden="true" />
    </button>
  );
}

export function AppearanceDrawer({ open, onOpenChange }: Props): React.ReactElement {
  useLanguage();
  const bridge = useBridge();
  const appearance = bridge.runtime?.traceAppearance;
  const [busy, setBusy] = React.useState(false);
  const [pendingSaves, setPendingSaves] = React.useState(0);
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
    setPendingSaves(value => value + 1);
    try {
      const next = await bridge.api.setTraceAppearance(patch);
      bridge.patch({ runtime: next });
    } catch (error) {
      showErrorToast(t('无法保存 Trace 外观'), error);
    } finally {
      setPendingSaves(value => Math.max(0, value - 1));
    }
  }, [bridge.api, bridge.patch]);

  const chooseImage = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await bridge.api.chooseTraceBackground();
      if (next) bridge.patch({ runtime: next });
    } catch (error) {
      showErrorToast(t('无法选择背景图片'), error);
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
      showToast(t('自定义背景已移除'), 'success');
    } catch (error) {
      showErrorToast(t('无法移除背景图片'), error);
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
        aria-label={t("Trace 外观")}
        aria-hidden={!open}
        inert={open ? undefined : true}
      >
        <div className="appearance-head">
          <h2>{t("外观")}</h2>
          {pendingSaves > 0 && <span role="status" className="appearance-saving">{t("保存中…")}</span>}
          <button type="button" className="appearance-close" aria-label={t("关闭外观设置")} onClick={() => onOpenChange(false)}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="appearance-body">
          <section className="appearance-section" aria-labelledby="skinTitle">
            <h3 id="skinTitle">{t("皮肤")}</h3>
            <div className="skin-list" role="radiogroup" aria-label={t("Trace 皮肤")}>
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
            <section className="appearance-section custom-background-settings" aria-label={t("自定义背景设置")}>
              <div className="appearance-row action-row">
                <span>{t("背景图片")}</span>
                <span className="appearance-actions">
                  <button type="button" className="txt-action" disabled={busy} onClick={() => void chooseImage()}>{t("更换")}</button>
                  <button type="button" className="appearance-remove" disabled={busy} aria-label={t("移除自定义背景")} title={t("移除图片")} onClick={() => void removeImage()}>
                    <Trash2 aria-hidden="true" />
                  </button>
                </span>
              </div>
              <div className="appearance-row fit-row">
                <span>{t("填充方式")}</span>
                <div className="appearance-segments" role="group" aria-label={t("图片填充方式")}>
                  <button type="button" aria-pressed={appearance.customImageFit === 'cover'} onClick={() => void commit({ customImageFit: 'cover' })}>{t("覆盖")}</button>
                  <button type="button" aria-pressed={appearance.customImageFit === 'contain'} onClick={() => void commit({ customImageFit: 'contain' })}>{t("适应")}</button>
                </div>
              </div>
              <label className="appearance-row overlay-row">
                <span>{t("遮罩强度")}</span>
                <input
                  type="range"
                  min="0"
                  max="80"
                  step="1"
                  value={overlayDraft}
                  aria-label={t("背景图片遮罩强度")}
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
            <h3 id="modulesTitle">{t("页面模块")}</h3>
            <div className="appearance-row module-row">
              <span className="appearance-row-copy">
                <strong>{t("流量图")}</strong>
              </span>
              <Toggle
                id="throughputVisibilityToggle"
                checked={showThroughput}
                busy={pendingSaves > 0}
                ariaLabel={t("显示流量图")}
                title={showThroughput ? t('隐藏流量图') : t('显示流量图')}
                onToggle={() => commit({ showThroughput: !showThroughput })}
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
