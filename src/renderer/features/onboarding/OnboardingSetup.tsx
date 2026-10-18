import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { RefreshCw } from 'lucide-react';
import { ParticleField, emitFieldRipple } from '@/features/trace/ParticleField';
import { useClientInstallations } from '@/features/models/useClientInstallations';
import { ProviderIcon } from '@/features/settings/ProviderIcon';
import { ClientDownloads } from '@/features/settings/ProviderSetupShortcuts';
import { ImportConfigurations } from '@/features/settings/ImportConfigurations';
import { MODEL_CLIENT_CATALOG, clientCatalogLabel, type DownloadClientId } from '../../../shared/clientDownloads';

/** The two clients onboarding recommends. Everything else stays in client management. */
const RECOMMENDED: readonly DownloadClientId[] = ['codex', 'claude'];

function rippleFrom(element: Element | null): void {
  if (!element) return;
  const r = element.getBoundingClientRect();
  emitFieldRipple(r.left + r.width / 2, r.top + r.height / 2, { soft: true });
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The welcome title settles character by character; screen readers get the plain text. */
function SettlingTitle({ text }: { text: string }): React.ReactElement {
  const chars = Array.from(text);
  return <h1 tabIndex={-1} aria-label={text} className="onboarding-hello-title">
    {chars.map((c, i) => <span key={i} aria-hidden="true" style={{ '--i': i } as React.CSSProperties}>{c}</span>)}
  </h1>;
}

/**
 * Full-window first-run setup: welcome, get missing ChatGPT and Claude, import
 * existing configurations. It covers the manager entirely; the feature
 * walkthrough that follows uses the spotlight over the real interface.
 */
export function OnboardingSetup({ onDone, onSkip, onDismiss = onSkip, initialStep = 0, onStepChange }: {
  onDone: () => void; onSkip: () => void; onDismiss?: () => void;
  initialStep?: number; onStepChange?: (step: number) => void;
}): React.ReactElement {
  useLanguage();
  const [step, setStep] = React.useState(initialStep);
  React.useLayoutEffect(() => { onStepChange?.(step); }, [step, onStepChange]);
  const [importCount, setImportCount] = React.useState<number | null>(null);
  const [importBusy, setImportBusy] = React.useState(false);
  const [importActions, setImportActions] = React.useState<HTMLDivElement | null>(null);
  const [leaving, setLeaving] = React.useState(false);
  const [departing, setDeparting] = React.useState(false);
  const installs = useClientInstallations(!leaving);
  const panel = React.useRef<HTMLDivElement | null>(null);
  const finishTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const departTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { for (const timer of [finishTimer.current, departTimer.current]) if (timer !== null) clearTimeout(timer); }, []);
  const nextButton = React.useRef<HTMLButtonElement | null>(null);

  const installed = React.useMemo(() => new Set(installs.snapshot?.available ? installs.snapshot.clients.filter(client => client.installed).map(client => client.id) : []), [installs.snapshot]);

  const missing = RECOMMENDED.filter(id => installs.snapshot?.available && !installed.has(id));
  const settled = installs.snapshot !== null && !installs.checking;
  // Detection runs behind the welcome screen. Recommendations appear only for
  // missing clients; an unfinished or failed check keeps the step reachable.
  // A focus refresh does not invalidate the last successful discovery. Otherwise
  // Back briefly enters recommendations and is immediately sent to import again.
  const recommend = missing.length > 0 || !installs.snapshot?.available || !!installs.error;
  const steps = recommend ? [0, 1, 2] : [0, 2];
  const stepIndex = steps.indexOf(step);

  const finish = React.useCallback((next: () => void) => {
    if (finishTimer.current !== null) return;
    rippleFrom(nextButton.current ?? panel.current);
    setLeaving(true);
    finishTimer.current = setTimeout(next, 420);
  }, []);
  const advance = () => {
    if (step === 2) { finish(onDone); return; }
    rippleFrom(nextButton.current);
    if (step !== 0) { setStep(2); return; }
    // The welcome eases out before the next step settles in.
    if (departTimer.current !== null) return;
    const go = () => { departTimer.current = null; setDeparting(false); setStep(recommend ? 1 : 2); };
    if (reducedMotion()) { go(); return; }
    setDeparting(true);
    departTimer.current = setTimeout(go, 320);
  };
  // Detection finishing late, or returning from a vendor page, skips clients already installed.
  React.useEffect(() => {
    if (step === 1 && settled && !installs.error && !missing.length) setStep(2);
  }, [step, settled, installs.error, missing.length]);

  React.useEffect(() => { panel.current?.querySelector<HTMLElement>('.onboarding-step:not([hidden]) h1')?.focus({ preventScroll: true }); }, [step]);

  const detectionState = installs.error ? installs.error : !settled ? t('正在检测…') : '';

  return <Dialog.Root open onOpenChange={open => { if (!open && !importBusy && !leaving) finish(onDismiss); }}><Dialog.Portal>
    <Dialog.Popup initialFocus={() => panel.current?.querySelector<HTMLElement>('h1') ?? false} finalFocus={false} id="onboarding-setup" className={`onboarding-setup${leaving ? ' leaving' : ''}`} role="dialog" aria-modal="true" aria-label={t('新手引导')} data-field-host>
    <div className="onboarding-field" aria-hidden="true"><ParticleField scale={58} flow={0.9} /></div>
    <div className="onboarding-panel" ref={panel} data-step={step}>
      <header className="onboarding-top">
        <div className="tour-dots" aria-label={t('第 {0} 步，共 {1} 步', stepIndex + 1, steps.length)} role="img">
          {Array.from({ length: steps.length }, (_, i) => <i key={i} className={i === stepIndex ? 'on' : undefined} />)}
        </div>
        <button type="button" className="tour-skip" disabled={importBusy || leaving} onClick={() => finish(onSkip)}>{t('跳过')}</button>
      </header>
      <div className={`onboarding-step${step === 0 ? ` onboarding-hello${departing ? ' departing' : ''}` : ''}`} hidden={step === 2} key={step === 2 ? 1 : step}>
        {step === 0 && <>
          <SettlingTitle text={t('欢迎使用 XwX Deck')} />
          <button type="button" ref={nextButton} className="btn primary onboarding-start" disabled={leaving || departing} onClick={advance}>{t('开始使用')}</button>
        </>}

        {step === 1 && <>
          <h1 tabIndex={-1}>{t(missing.length === 1 ? (missing[0] === 'claude' ? '为您推荐 Claude' : '为您推荐 ChatGPT') : '为您推荐 ChatGPT 与 Claude')}</h1>
          <div className="onboarding-body onboarding-apps">
            {detectionState && <div className="onboarding-discovery">
              <p className="onboarding-status" role="status">{detectionState}</p>
              {installs.error && <button type="button" className="provider-text-action onboarding-recheck" disabled={installs.checking} aria-busy={installs.checking} onClick={() => void installs.refresh()}><RefreshCw size={15} className={installs.checking ? 'configuration-refresh-spinner' : undefined} aria-hidden="true" />{t('重新检测')}</button>}
            </div>}
            {missing.map(id => {
              const client = MODEL_CLIENT_CATALOG.find(item => item.id === id)!;
              return <section key={id} className="onboarding-app">
                <header><ProviderIcon kind={client.icon} /><h2>{clientCatalogLabel(client)}</h2>
                  <span className="onboarding-missing">{t('未安装')}</span>
                </header>
                <ClientDownloads client={id} />
              </section>;
            })}
          </div>
        </>}

      </div>
      <div className="onboarding-step" hidden={step !== 2}>
          <h1 tabIndex={-1}>{t(importCount === null ? '正在查找之前的配置' : importCount ? '找到了您之前的配置' : '没有找到之前的配置')}</h1>
          <div className="onboarding-body onboarding-import">
            <ImportConfigurations visible={step === 2} onboarding onDetected={setImportCount} onBack={advance} onImported={advance} onBusyChange={setImportBusy} actionsContainer={importActions} clientDetection={installs} />
          </div>
      </div>

      {/* Every step uses the same content column and action row. */}
      {step > 0 && <footer className="onboarding-foot">
        <button type="button" className="btn" disabled={importBusy || leaving} onClick={() => setStep(step === 2 && recommend ? 1 : 0)}>{t('上一步')}</button>
        {step === 1 && <button type="button" ref={nextButton} className="btn primary" disabled={leaving} onClick={advance}>{t('继续')}</button>}
        {step === 2 && <div className="onboarding-forward" ref={setImportActions} />}
      </footer>}
    </div>
    </Dialog.Popup>
  </Dialog.Portal></Dialog.Root>;
}
