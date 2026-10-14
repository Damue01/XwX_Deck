import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import type { ClientStateRow, ManagerTraceStats } from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { clearLifecycleNotice, showLifecycleNotice, showToast } from '@/lib/toast';
import { claudeDesktopRestartNote, isTraceStopBusyError, lifecycleFailure, traceStoppedNotice } from '../../../shared/lifecycleNotice';
import { normalizeErrorMessage } from '../../../shared/errors';
import { tokenCostPresentation, readoutRange } from '@/lib/format';
import { modelClientRoute } from '../../../shared/clientDownloads';
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ParticleField, emitFieldRipple } from './ParticleField';
import { ThroughputChart } from './ThroughputChart';
import { AppearanceButton, AppearanceDrawer, customBackgroundStyle } from './AppearanceDrawer';
import { ReadoutDigits } from './ReadoutDigits';

type PeriodKey = 'total' | 'today' | 'week';

const CHATGPT_RESTART_TOAST_ID = 'chatgpt-restart-recommended';
const TRACE_WAITING_TOAST_ID = 'trace-waiting-client';
const CHATGPT_RESTART_DESCRIPTION = '当前对话通常可继续使用；若连接未切换、模型未更新或对话无法继续，再完全退出并重新打开 ChatGPT。';
const TRACE_RESTART_DESCRIPTION = '客户端可能仍在使用旧连接。先发送一条新消息；若未出现在 Trace 中或对话无法继续，再完全退出并重新打开相应客户端。';
export const TRACE_TOGGLE_REQUEST_EVENT = 'xwxdeck:toggle-trace-request';
// The page being left needs this long to fade out before the next one may
// appear, even when the backend answers faster.
const SWITCH_MIN_HIDDEN_MS = 260;

interface TokenReadoutProps {
  readonly stats: ManagerTraceStats | null;
  readonly period: PeriodKey;
}

function TokenReadout({ stats, period }: TokenReadoutProps): React.ReactElement {
  useLanguage();
  const [showCost, setShowCost] = React.useState(false);
  const slot = stats?.[period] ?? { tokens: 0, costUsd: 0, costComplete: true };
  const pres = tokenCostPresentation({ showCost, tokens: slot.tokens, costUsd: slot.costUsd });
  const range = readoutRange(pres.value + pres.unit);
  const nothingPriced = showCost && !slot.costComplete && slot.costUsd === 0
    && (slot.knownCostRequests ?? 0) === 0;

  return (
    <div className="hero-readout">
      <div
        className="readout-main"
        id="tokenReadout"
        role="button"
        tabIndex={0}
        aria-label={t("切换 Token 与费用")}
        title={pres.toggleHint}
        onClick={() => setShowCost(c => !c)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
      >
        <div className="readout-eyebrow">
          <span className="readout-label" id="readoutLabel">{pres.label}</span>
        </div>
        <div className="readout-value" id="readoutValue" data-range={range}>
          <ReadoutDigits
            mode={showCost ? 'cost' : 'tokens'}
            text={nothingPriced
              ? '—'
              : pres.unit && pres.unit !== '' && pres.unit !== '$'
                ? `${pres.value}${pres.unit}`
                : pres.unit === '$' ? `$${pres.value}` : String(pres.value)}
          />
        </div>
      </div>
    </div>
  );
}

interface ClientToggleProps {
  readonly client: ClientStateRow;
  readonly onToggle: (id: string) => void;
  readonly variant: 'idle' | 'live';
  readonly busy: boolean;
}

function ClientToggle({ client, onToggle, variant, busy }: ClientToggleProps): React.ReactElement {
  useLanguage();
  const uiId = client.id === 'claude-cli' ? 'claude' : client.id === 'codex-cli' ? 'codex' : client.id;
  const label = client.label;
  return (
    <button
      type="button"
      className={`src-t${client.enabled ? ' on' : ''}${client.status === 'skipped' ? ' skipped' : ''}`}
      data-client={`${uiId}-${variant}`}
      data-status={client.status}
      aria-pressed={client.enabled}
      aria-label={`${label}：${t(client.statusText)}，${t(client.detail)}`}
      title={t(client.detail || client.statusText || '')}
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => onToggle(client.id)}
    >
      {label}
    </button>
  );
}

interface Props {
  readonly active: boolean;
}

export function SignalPage({ active }: Props): React.ReactElement {
  useLanguage();
  const bridge = useBridge();
  const confirm = useConfirm();
  const [period, setPeriod] = React.useState<PeriodKey>('total');
  const [appearanceOpen, setAppearanceOpen] = React.useState(() => (
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('appearance') === '1'
  ));
  // True while a switch this page started is still running. Both layouts
  // stay hidden until then: the click ripple is the immediate answer, and the
  // next page appears as a whole only once its controls really work.
  const [pending, setPending] = React.useState(false);
  const [busyClients, setBusyClients] = React.useState<ReadonlySet<string>>(() => new Set());
  const togglingRef = React.useRef(false);
  const busyClientRef = React.useRef(new Set<string>());
  const statsTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const initialRestartNoticeCheckedRef = React.useRef(false);

  const capturing = bridge.runtime?.tracingEnabled === true;
  // Tray and recovery Toast switches report through traceTransition and
  // get the same hidden-until-ready treatment.
  const transition = bridge.runtime?.traceTransition;
  const hidden = pending || !!transition;
  const clients = (bridge.runtime?.clients ?? []).filter(client =>
    bridge.modelClients.some(id => client.id === 'claude-cli' ? modelClientRoute(id) === 'claude' : client.id === 'codex-cli' ? modelClientRoute(id) === 'codex' : id === client.id));
  const series = bridge.traceStats?.series ?? [];
  const appearance = bridge.runtime?.traceAppearance;
  const skin = appearance?.skin ?? 'classic';
  const showThroughput = appearance?.showThroughput === true;

  // The idle/live layout belongs to the Trace page, not to the classic
  // particle skin. Keep this global CSS state updated even when clean or
  // custom skins do not mount ParticleField.
  React.useEffect(() => {
    document.body.dataset.capturing = String(capturing);
  }, [capturing]);

  React.useEffect(() => {
    if (hidden) document.body.dataset.traceSwitching = 'true';
    else delete document.body.dataset.traceSwitching;
    return () => { delete document.body.dataset.traceSwitching; };
  }, [hidden]);

  React.useEffect(() => {
    if (!bridge.booted || !bridge.runtime || initialRestartNoticeCheckedRef.current) return;
    initialRestartNoticeCheckedRef.current = true;
    if (!bridge.runtime?.chatGptRestartRecommended) return;
    showToast(t('ChatGPT 连接已更新'), 'info', CHATGPT_RESTART_TOAST_ID, {
      description: CHATGPT_RESTART_DESCRIPTION,
      timeout: 12_000
    });
  }, [bridge.booted, bridge.runtime?.chatGptRestartRecommended]);

  const syncTimers = React.useCallback(() => {
    const shouldRun = capturing && !document.hidden && active;
    if (!shouldRun) {
      if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
      return;
    }
    if (!statsTimerRef.current) {
      // Poll fresh stats every 3s; the chart itself animates smoothly via rAF.
      statsTimerRef.current = setInterval(() => { void bridge.refreshStats(); }, 3000);
      void bridge.refreshStats();
    }
  }, [capturing, active, bridge.refreshStats]);

  React.useEffect(() => {
    syncTimers();
    return () => {
      if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
    };
  }, [syncTimers]);

  React.useEffect(() => {
    const onVis = () => syncTimers();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [syncTimers]);

  const handleToggle = React.useCallback(async () => {
    // Two surfaces can start this operation (this page and the recovery
    // Toast), and the tray can start it from outside the renderer entirely.
    // A transition reported by runtime means one is already in flight.
    if (togglingRef.current || bridge.runtime?.traceTransition) return;
    togglingRef.current = true;
    setPending(true);
    const startedAt = performance.now();
    let cancelled = false;
    try {
      const next = await bridge.api.toggleTracing(!capturing);
      if (!bridge.patch({ runtime: next })) return;
      if (next.lastError) {
        showLifecycleNotice(lifecycleFailure(next.lastError, next.tracingEnabled ? t('接入 Trace') : t('恢复客户端配置')));
      } else if (next.tracingEnabled && next.clients.some(client => client.enabled && client.status === 'skipped')) {
        // The shared recovery actions publish skipped-client guidance through Toast.
        clearLifecycleNotice();
      } else if (next.tracingEnabled) {
        showLifecycleNotice({
          message: t('Trace 已开启'),
          type: next.claudeDesktopRestart === 'local' ? 'info' : 'success',
          description: next.claudeDesktopRestart === 'local' ? claudeDesktopRestartNote('local') : TRACE_RESTART_DESCRIPTION
        }, TRACE_WAITING_TOAST_ID);
      } else {
        showLifecycleNotice(traceStoppedNotice(next.backgroundGatewayAction === 'close', next.claudeDesktopRestart, next.connectionNotice));
      }
    } catch (e) {
      void bridge.api.getState().then(runtime => bridge.patch({ runtime })).catch(() => undefined);
      if (capturing && isTraceStopBusyError(e)) {
        // One choice only: waiting keeps Trace on and leaves no notice behind.
        // Trace is still on while the user decides, so the page shows it on.
        setPending(false);
        const force = await confirm({
          title: t('关闭 Trace？'),
          body: t("{0}现在关闭会中断它们；继续等待则保持 Trace 开启。", normalizeErrorMessage(e)),
          cancelText: t('继续等待'),
          confirmText: t('强制停止'),
          tone: 'danger'
        });
        if (!force) { cancelled = true; return; }
        setPending(true);
        try {
          const next = await bridge.api.toggleTracing(false, true);
          if (!bridge.patch({ runtime: next })) return;
          showLifecycleNotice(next.lastError
            ? lifecycleFailure(next.lastError, t('恢复客户端配置'))
            : traceStoppedNotice(next.backgroundGatewayAction === 'close', next.claudeDesktopRestart, next.connectionNotice));
        } catch (forceError) {
          showLifecycleNotice(lifecycleFailure(forceError, t('强制停止 Trace')));
        }
        return;
      }
      showLifecycleNotice(lifecycleFailure(e, capturing ? t('停止 Trace') : t('开启 Trace')));
    } finally {
      const left = SWITCH_MIN_HIDDEN_MS - (performance.now() - startedAt);
      if (!cancelled && left > 0) await new Promise(resolve => setTimeout(resolve, left));
      togglingRef.current = false;
      setPending(false);
    }
  }, [capturing, bridge.api, bridge.patch, bridge.runtime?.traceTransition, confirm]);

  // Native capture reaches rail actions and tabs before their actions run.
  // The appearance panel keeps its controls independent of the dot field.
  React.useEffect(() => {
    if (!active) return;
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('#appearanceDrawer, .appearance-dismiss')) return;
      const button = event.target.closest<HTMLElement>('button, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], a[href]');
      if (!button || button.closest(':disabled, [aria-disabled="true"], [data-disabled], [inert]')) return;
      const rect = button.getBoundingClientRect();
      emitFieldRipple(event.detail ? event.clientX : rect.left + rect.width / 2,
        event.detail ? event.clientY : rect.top + rect.height / 2);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [active]);

  const handleDialClick = React.useCallback(() => {
    void handleToggle();
  }, [handleToggle]);

  React.useEffect(() => {
    const requestToggle = () => { void handleToggle(); };
    window.addEventListener(TRACE_TOGGLE_REQUEST_EVENT, requestToggle);
    return () => window.removeEventListener(TRACE_TOGGLE_REQUEST_EVENT, requestToggle);
  }, [handleToggle]);

  const handleClientToggle = React.useCallback(async (id: string) => {
    if (busyClientRef.current.has(id)) return;
    busyClientRef.current.add(id);
    setBusyClients(current => new Set(current).add(id));
    try {
      const next = await (id === 'claude-cli' || id === 'codex-cli' ? bridge.api.toggleClient(id) : bridge.api.toggleGatewayClient!(id));
      bridge.patch({ runtime: next });
      clearLifecycleNotice();
      if (id === 'codex-cli'
        && next.chatGptRestartRecommended
        && next.clients.some(client => client.id === 'codex-cli' && client.enabled)) {
        showToast(t('ChatGPT 连接已更新'), 'info', CHATGPT_RESTART_TOAST_ID, {
          description: CHATGPT_RESTART_DESCRIPTION,
          timeout: 12_000
        });
      }
    } catch (e) {
      showLifecycleNotice(lifecycleFailure(e, id === 'codex-cli' ? t('ChatGPT 接入') : t('Claude 接入')));
    } finally {
      busyClientRef.current.delete(id);
      setBusyClients(current => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, [bridge.api, bridge.patch]);

  return (
    <section
      className={`page${active ? ' current' : ''}`}
      id="page-signal"
      aria-label="Trace"
      inert={active ? undefined : true}
    >
      <div className="signal-wrap" id="signalWrap">
        <div
          className={`trace-custom-background${skin === 'custom' && appearance?.customImageUrl ? ' visible' : ''}`}
          style={customBackgroundStyle(bridge.runtime)}
          aria-hidden="true"
        />
        {skin === 'classic' ? <ParticleField active={active} scale={96} dotSize={0.7} /> : null}
        {skin === 'custom' && appearance?.customImageUrl ? (
          <div
            id="traceCustomOverlay"
            className="trace-custom-overlay"
            style={{ opacity: (appearance.customImageOverlay ?? 42) / 100 }}
            aria-hidden="true"
          />
        ) : null}
        <div className="signal-fade" aria-hidden="true" />

        <div className="appearance-idle-entry">
          <AppearanceButton id="appearanceTriggerIdle" onClick={() => setAppearanceOpen(true)} />
        </div>

        {/* Idle state */}
        <div className="idle-state" inert={capturing || hidden}>
          <button
            type="button"
            className="capture-dial"
            id="captureBtn"
            aria-pressed={capturing}
            aria-label={t("开启 Trace")}
            onClick={handleDialClick}
          >
            <svg viewBox="0 0 30 30" aria-hidden="true">
              <path d="M11.6 8.6 11.6 21.4 22.4 15 Z" fill="currentColor" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="idle-sources">
            <div className="srcs" role="group" aria-label={t("捕获来源")}>
              {clients.map(c => (
                <ClientToggle key={c.id} client={c} onToggle={handleClientToggle} variant="idle" busy={busyClients.has(c.id)} />
              ))}
            </div>
          </div>
        </div>

        {/* Live board */}
        <div className="live-layout" id="liveBoard" inert={!capturing || hidden}>
          <div className="signal-top">
            <div className="srcs" role="group" aria-label={t("捕获来源")}>
              {clients.map(c => (
                <ClientToggle key={c.id} client={c} onToggle={handleClientToggle} variant="live" busy={busyClients.has(c.id)} />
              ))}
            </div>
            <div className="signal-top-right">
              <AppearanceButton id="appearanceTriggerLive" onClick={() => setAppearanceOpen(true)} />
              <Tabs value={period} onValueChange={v => setPeriod(v as PeriodKey)}>
                <TabsList aria-label={t("统计周期")}>
                  {(['total', 'today', 'week'] as PeriodKey[]).map(p => (
                    <TabsTab key={p} value={p} data-period={p}>
                      {p === 'total' ? t('总计') : p === 'today' ? t('今日') : t('本周')}
                    </TabsTab>
                  ))}
                </TabsList>
              </Tabs>
              <button
                type="button"
                className="stop-dial"
                id="stopCaptureBtn"
                aria-label={t("关闭 Trace")}
                onClick={handleDialClick}
              />
            </div>
          </div>

          <TokenReadout stats={bridge.traceStats} period={period} />

          {showThroughput ? <ThroughputChart series={series} active={active && capturing} /> : <div className="chart-placeholder" aria-hidden="true" />}
        </div>

        <AppearanceDrawer open={appearanceOpen} onOpenChange={setAppearanceOpen} />
      </div>
    </section>
  );
}
