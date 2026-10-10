import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { ParticleField, emitFieldRipple } from '@/features/trace/ParticleField';
import { useClientInstallations } from '@/features/models/useClientInstallations';
import { ProviderIcon } from '@/features/settings/ProviderIcon';
import { ClientDownloads } from '@/features/settings/ProviderSetupShortcuts';
import { ImportConfigurations } from '@/features/settings/ImportConfigurations';
import { MODEL_CLIENT_CATALOG, clientCatalogLabel, type DownloadClientId } from '../../../shared/clientDownloads';

/** The two clients onboarding recommends. Everything else stays in client management. */
const RECOMMENDED: readonly DownloadClientId[] = ['codex', 'claude'];
const STEPS = 3;

function rippleFrom(element: Element | null): void {
  if (!element) return;
  const r = element.getBoundingClientRect();
  emitFieldRipple(r.left + r.width / 2, r.top + r.height / 2);
}

/**
 * Full-window first-run setup: detect clients, get ChatGPT and Claude, import
 * existing configurations. It covers the manager entirely; the feature
 * walkthrough that follows uses the spotlight over the real interface.
 */
export function OnboardingSetup({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }): React.ReactElement {
  useLanguage();
  const [step, setStep] = React.useState(0);
  const [importBusy, setImportBusy] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const installs = useClientInstallations(!leaving);
  const panel = React.useRef<HTMLDivElement | null>(null);
  const nextButton = React.useRef<HTMLButtonElement | null>(null);

  const installed = React.useMemo(() => new Set(installs.snapshot?.available ? installs.snapshot.clients.filter(client => client.installed).map(client => client.id) : []), [installs.snapshot]);
  const found = React.useMemo(() => {
    const list = MODEL_CLIENT_CATALOG.filter(client => installed.has(client.id));
    return [...list.filter(client => RECOMMENDED.includes(client.id)), ...list.filter(client => !RECOMMENDED.includes(client.id))];
  }, [installed]);

  // One wave through the field when detection settles.
  const settled = installs.snapshot !== null && !installs.checking;
  React.useEffect(() => { if (settled && step === 0) rippleFrom(panel.current?.querySelector('.onboarding-clients, .onboarding-status') ?? null); }, [settled, step]);

  const finish = React.useCallback((next: () => void) => {
    rippleFrom(nextButton.current ?? panel.current);
    setLeaving(true);
    window.setTimeout(next, 420);
  }, []);
  const advance = React.useCallback(() => {
    if (step >= STEPS - 1) { finish(onDone); return; }
    rippleFrom(nextButton.current);
    setStep(step + 1);
  }, [step, finish, onDone]);

  React.useEffect(() => { panel.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }); }, [step]);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !importBusy) finish(onSkip); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish, onSkip, importBusy]);

  const detectionState = installs.error
    ? installs.error
    : !installs.snapshot ? t('正在检测这台电脑…')
    : !installs.snapshot.available ? t('当前环境无法检测本机客户端，可以稍后在客户端管理中重新检测。')
    : !found.length ? t('没有检测到已安装的客户端。') : '';

  return <div id="onboarding-setup" className={`onboarding-setup${leaving ? ' leaving' : ''}`} role="dialog" aria-modal="true" aria-label={t('新手引导')} data-field-host>
    <div className="onboarding-field" aria-hidden="true"><ParticleField scale={58} flow={0.9} /></div>
    <div className="onboarding-panel" ref={panel} data-step={step}>
      <header className="onboarding-top">
        <div className="tour-dots" aria-label={t('第 {0} 步，共 {1} 步', step + 1, STEPS)} role="img">
          {Array.from({ length: STEPS }, (_, i) => <i key={i} className={i === step ? 'on' : undefined} />)}
        </div>
        <button type="button" className="tour-skip" disabled={importBusy} onClick={() => finish(onSkip)}>{t('跳过引导')}</button>
      </header>
      <div className="onboarding-step" key={step}>
        {step === 0 && <>
          <h1 tabIndex={-1}>{t('欢迎使用 XwX Deck')}</h1>
          <p className="onboarding-lead">{t('检测这台电脑上已安装的 AI 客户端，不读取登录信息，也不修改配置。')}</p>
          <div className="onboarding-body">
            {detectionState
              ? <p className="onboarding-status" role="status">{detectionState}</p>
              : <ul className="onboarding-clients" aria-label={t('已安装的客户端')}>
                {found.map((client, index) => <li key={client.id} style={{ '--i': index } as React.CSSProperties}><ProviderIcon kind={client.icon} /><span>{clientCatalogLabel(client)}</span></li>)}
              </ul>}
            {(installs.error || installs.snapshot) && <button type="button" className="provider-text-action onboarding-recheck" disabled={installs.checking} aria-busy={installs.checking} onClick={() => void installs.refresh()}><RefreshCw size={15} className={installs.checking ? 'configuration-refresh-spinner' : undefined} aria-hidden="true" />{t('重新检测')}</button>}
          </div>
        </>}

        {step === 1 && <>
          <h1 tabIndex={-1}>{t('推荐安装 ChatGPT 和 Claude')}</h1>
          <p className="onboarding-lead">{t('可选，不安装也可以继续。')}</p>
          <div className="onboarding-body onboarding-apps">
            {RECOMMENDED.map(id => {
              const client = MODEL_CLIENT_CATALOG.find(item => item.id === id)!;
              const known = !!installs.snapshot?.available;
              const ready = installed.has(id);
              return <section key={id} className="onboarding-app" data-ready={ready}>
                <header><ProviderIcon kind={client.icon} /><h2>{clientCatalogLabel(client)}</h2>
                  {ready ? <span className="onboarding-ready"><Check size={15} aria-hidden="true" />{t('已安装')}</span>
                    : known ? <span className="onboarding-missing">{t('未安装')}</span> : null}
                </header>
                {!ready && <ClientDownloads client={id} />}
              </section>;
            })}
          </div>
        </>}

        {step === 2 && <>
          <h1 tabIndex={-1}>{t('导入已有配置')}</h1>
          <p className="onboarding-lead">{t('从 CC Switch、Magpie 或旧版 XwX Deck 导入模型服务，原文件不会被修改。')}</p>
          <div className="onboarding-body onboarding-import">
            <ImportConfigurations visible onboarding onBack={advance} onImported={advance} onBusyChange={setImportBusy} />
          </div>
        </>}
      </div>

      {/* Back sits on the column's left edge, the forward action on its right edge.
          The import step supplies its own Skip / Import pair in that right slot. */}
      <footer className="onboarding-foot">
        {step > 0 ? <button type="button" className="btn" disabled={importBusy} onClick={() => setStep(step - 1)}>{t('上一步')}</button> : <span />}
        {step < STEPS - 1 && <button type="button" ref={nextButton} className="btn primary" onClick={advance}>{t('继续')}</button>}
      </footer>
    </div>
  </div>;
}
