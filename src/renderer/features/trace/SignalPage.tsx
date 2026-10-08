import * as React from 'react';
import type { ClientStateRow, ManagerTraceStats } from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { clearLifecycleNotice, showLifecycleNotice, showToast } from '@/lib/toast';
import { claudeDesktopRestartNote, isTraceStopBusyError, lifecycleFailure, traceStoppedNotice } from '../../../shared/lifecycleNotice';
import { normalizeErrorMessage } from '../../../shared/errors';
import { tokenCostPresentation, readoutRange } from '@/lib/format';
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
  const [showCost, setShowCost] = React.useState(false);
  const slot = stats?.[period] ?? { tokens: 0, costUsd: 0, costComplete: true };
  const pres = tokenCostPresentation({ showCost, tokens: slot.tokens, costUsd: slot.costUsd });
  const range = readoutRange(pres.value + pres.unit);
  // A partial total is the most useful number available while at least one model
  // priced: it is a real lower bound. But a partial total of exactly zero means
  // nothing priced at all, and rendering that as $0.00 asserts the period cost
  // nothing — which is strictly worse than admitting the figure is unavailable.
  // Reproduced with periods containing only length-banded models captured before
  // banding existed.
  const nothingPriced = showCost && !slot.costComplete && slot.costUsd === 0;
  const partialCost = showCost && !slot.costComplete && !nothingPriced;
  const costHint = nothingPriced
    ? '这段时间使用的模型都没有可信价格可用，因此不给出金额。按输入长度分档或分时段计费的模型需要落盘时记录的分桶才能计算，升级前抓取的用量没有这份分桶；清空 Trace 记录后重新抓取即可恢复完整计费。'
    : partialCost
      ? '部分模型缺少可信价格或缺少缓存写 TTL 分档，未计入合计；显示的是已核验模型的下限。升级前记录的用量无法拆分缓存，清空 Trace 记录后重新抓取即可恢复完整计费。'
      : pres.toggleHint;

  return (
    <div className="hero-readout">
      <div
        className="readout-main"
        id="tokenReadout"
        role="button"
        tabIndex={0}
        aria-label="切换 Token 与费用"
        title={costHint}
        onClick={() => setShowCost(c => !c)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowCost(c => !c); } }}
      >
        <div className="readout-eyebrow">
          <span className="readout-label" id="readoutLabel">{pres.label}{partialCost ? '（部分）' : nothingPriced ? '（无可信价格）' : ''}</span>
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
          {partialCost ? <span className="readout-partial" aria-hidden="true">+</span> : null}
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
  const uiId = client.id === 'claude-cli' ? 'claude' : 'codex';
  const label = client.id === 'claude-cli' ? 'Claude' : 'ChatGPT';
  return (
    <button
      type="button"
      className={`src-t${client.enabled ? ' on' : ''}${client.status === 'skipped' ? ' skipped' : ''}`}
      data-client={`${uiId}-${variant}`}
      data-status={client.status}
      aria-pressed={client.enabled}
      aria-label={`${label}：${client.statusText}，${client.detail}`}
      title={client.detail || client.statusText || ''}
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
  // Tray and connection-notice switches report through traceTransition and
  // get the same hidden-until-ready treatment.
  const transition = bridge.runtime?.traceTransition;
  const hidden = pending || !!transition;
  const clients = bridge.runtime?.clients ?? [];
  const series = bridge.traceStats?.series ?? [];
  const appearance = bridge.runtime?.traceAppearance;
  const skin = appearance?.skin ?? 'classic';
  const showThroughput = appearance?.showThroughput !== false;

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
    showToast('ChatGPT 连接已更新', 'info', CHATGPT_RESTART_TOAST_ID, {
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
      if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    };
  }, [syncTimers]);

  React.useEffect(() => {
    const onVis = () => syncTimers();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [syncTimers]);

  const handleToggle = React.useCallback(async () => {
    // Two surfaces can start this operation (this page and the connection
    // notice), and the tray can start it from outside the renderer entirely.
    // A transition reported by runtime means one is already in flight.
    if (togglingRef.current || bridge.runtime?.traceTransition) return;
    togglingRef.current = true;
    setPending(true);
    const startedAt = performance.now();
    try {
      const next = await bridge.api.toggleTracing(!capturing);
      bridge.patch({ runtime: next });
      if (next.lastError) {
        showLifecycleNotice(lifecycleFailure(next.lastError, next.tracingEnabled ? '接入 Trace' : '恢复客户端配置'));
      } else if (next.tracingEnabled && next.clients.some(client => client.enabled && client.status === 'skipped')) {
        // The persistent connection notice explains which client did not join.
        clearLifecycleNotice();
      } else if (next.tracingEnabled) {
        showLifecycleNotice({
          message: 'Trace 已开启',
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
          title: '关闭 Trace？',
          body: `${normalizeErrorMessage(e)}现在关闭会中断它们；继续等待则保持 Trace 开启。`,
          cancelText: '继续等待',
          confirmText: '强制停止',
          tone: 'danger'
        });
        if (!force) return;
        setPending(true);
        try {
          const next = await bridge.api.toggleTracing(false, true);
          bridge.patch({ runtime: next });
          showLifecycleNotice(next.lastError
            ? lifecycleFailure(next.lastError, '恢复客户端配置')
            : traceStoppedNotice(next.backgroundGatewayAction === 'close', next.claudeDesktopRestart, next.connectionNotice));
        } catch (forceError) {
          showLifecycleNotice(lifecycleFailure(forceError, '强制停止 Trace'));
        }
        return;
      }
      showLifecycleNotice(lifecycleFailure(e, capturing ? '停止 Trace' : '开启 Trace'));
    } finally {
      const left = SWITCH_MIN_HIDDEN_MS - (performance.now() - startedAt);
      if (left > 0) await new Promise(resolve => setTimeout(resolve, left));
      togglingRef.current = false;
      setPending(false);
    }
  }, [capturing, bridge.api, bridge.patch, bridge.runtime?.traceTransition, confirm]);

  // Immediate response to the dial: a ripple leaves the button on this frame
  // while the page fades out.
  const handleDialClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    emitFieldRipple(rect.left + rect.width / 2, rect.top + rect.height / 2);
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
      const next = await bridge.api.toggleClient(id as 'claude-cli' | 'codex-cli');
      bridge.patch({ runtime: next });
      clearLifecycleNotice();
      if (id === 'codex-cli'
        && next.chatGptRestartRecommended
        && next.clients.some(client => client.id === 'codex-cli' && client.enabled)) {
        showToast('ChatGPT 连接已更新', 'info', CHATGPT_RESTART_TOAST_ID, {
          description: CHATGPT_RESTART_DESCRIPTION,
          timeout: 12_000
        });
      }
    } catch (e) {
      showLifecycleNotice(lifecycleFailure(e, id === 'codex-cli' ? 'ChatGPT 接入' : 'Claude 接入'));
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
        {skin === 'classic' ? <ParticleField /> : null}
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
            aria-label="开启 Trace"
            onClick={handleDialClick}
          >
            <svg viewBox="0 0 30 30" aria-hidden="true">
              <path d="M11.6 8.6 11.6 21.4 22.4 15 Z" fill="currentColor" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="idle-sources">
            <div className="srcs" role="group" aria-label="捕获来源">
              {clients.map(c => (
                <ClientToggle key={c.id} client={c} onToggle={handleClientToggle} variant="idle" busy={busyClients.has(c.id)} />
              ))}
            </div>
          </div>
        </div>

        {/* Live board */}
        <div className="live-layout" id="liveBoard" inert={!capturing || hidden}>
          <div className="signal-top">
            <div className="srcs" role="group" aria-label="捕获来源">
              {clients.map(c => (
                <ClientToggle key={c.id} client={c} onToggle={handleClientToggle} variant="live" busy={busyClients.has(c.id)} />
              ))}
            </div>
            <div className="signal-top-right">
              <AppearanceButton id="appearanceTriggerLive" onClick={() => setAppearanceOpen(true)} />
              <Tabs value={period} onValueChange={v => setPeriod(v as PeriodKey)}>
                <TabsList aria-label="统计周期">
                  {(['total', 'today', 'week'] as PeriodKey[]).map(p => (
                    <TabsTab key={p} value={p} data-period={p}>
                      {p === 'total' ? '总计' : p === 'today' ? '今日' : '本周'}
                    </TabsTab>
                  ))}
                </TabsList>
              </Tabs>
              <button
                type="button"
                className="stop-dial"
                id="stopCaptureBtn"
                aria-label="关闭 Trace"
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
