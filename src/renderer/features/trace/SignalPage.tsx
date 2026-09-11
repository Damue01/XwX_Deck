import * as React from 'react';
import type { ClientStateRow, ManagerTraceStats, XwXDeckRuntimeState } from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { showToast } from '@/lib/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { tokenCostPresentation, readoutRange } from '@/lib/format';
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs';
import { ParticleField } from './ParticleField';
import { ThroughputChart } from './ThroughputChart';
import { AppearanceButton, AppearanceDrawer, customBackgroundStyle } from './AppearanceDrawer';

type PeriodKey = 'total' | 'today' | 'week';

const CHATGPT_CONNECTION_TOAST_ID = 'chatgpt-connection';
const CHATGPT_RESTART_TOAST_ID = 'chatgpt-restart-recommended';
const TRACE_WAITING_TOAST_ID = 'trace-waiting-client';
const ENVIRONMENT_OVERRIDE_TOAST_ID = 'environment-override';
const CHATGPT_CONNECTION_FAILED_TEXT = 'ChatGPT 接入失败，请重启 Trace 后重试。';
const CHATGPT_CONNECTION_UNSUPPORTED_TEXT = 'ChatGPT 暂未接入，XwX Deck 当前的连接方式无法与 Trace 同时使用。请先重启 XwX Deck，再重启 Trace 后重试。';
const CHATGPT_RESTART_DESCRIPTION = 'ChatGPT 在 XwX Deck 接管连接前已经运行，当前任务可能仍使用旧连接。完全退出并重新打开 ChatGPT 后，新请求才会稳定经过 Gateway。';
export const TRACE_TOGGLE_REQUEST_EVENT = 'xwxdeck:toggle-trace-request';

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
          {nothingPriced
            ? '—'
            : pres.unit && pres.unit !== '' && pres.unit !== '$'
              ? `${pres.value}${pres.unit}`
              : pres.unit === '$' ? `$${pres.value}` : pres.value}
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
}

function ClientToggle({ client, onToggle, variant }: ClientToggleProps): React.ReactElement {
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
  const [toggling, setToggling] = React.useState(false);
  const togglingRef = React.useRef(false);
  const statsTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const shownChatGptIssueRef = React.useRef<string | undefined>(undefined);
  const shownChatGptRestartRef = React.useRef(false);
  const shownEnvironmentIssueRef = React.useRef<string | undefined>(undefined);

  const capturing = bridge.runtime?.tracingEnabled === true;
  const clients = bridge.runtime?.clients ?? [];
  const series = bridge.traceStats?.series ?? [];
  const appearance = bridge.runtime?.traceAppearance;
  const skin = appearance?.skin ?? 'classic';
  const showThroughput = appearance?.showThroughput !== false;
  const chatGptIssue = chatGptSkippedIssue(bridge.runtime);
  const environmentIssue = environmentOverrideIssue(bridge.runtime);

  // The idle/live layout belongs to the Trace page, not to the classic
  // particle skin. Keep this global CSS state updated even when clean or
  // custom skins do not mount ParticleField.
  React.useEffect(() => {
    document.body.dataset.capturing = String(capturing);
  }, [capturing]);

  React.useEffect(() => {
    if (!bridge.runtime?.chatGptRestartRecommended) {
      shownChatGptRestartRef.current = false;
      return;
    }
    if (shownChatGptRestartRef.current) return;
    shownChatGptRestartRef.current = true;
    showToast('请重启 ChatGPT', 'info', CHATGPT_RESTART_TOAST_ID, {
      description: CHATGPT_RESTART_DESCRIPTION,
      timeout: 12_000
    });
  }, [bridge.runtime?.chatGptRestartRecommended]);

  React.useEffect(() => {
    if (!environmentIssue) {
      shownEnvironmentIssueRef.current = undefined;
      return;
    }
    if (shownEnvironmentIssueRef.current === environmentIssue) return;
    shownEnvironmentIssueRef.current = environmentIssue;
    showToast(environmentIssue, 'error', ENVIRONMENT_OVERRIDE_TOAST_ID);
  }, [environmentIssue]);

  React.useEffect(() => {
    if (!chatGptIssue) {
      shownChatGptIssueRef.current = undefined;
      return;
    }
    if (shownChatGptIssueRef.current === chatGptIssue) return;
    shownChatGptIssueRef.current = chatGptIssue;
    showToast(chatGptIssue, 'error', CHATGPT_CONNECTION_TOAST_ID);
  }, [chatGptIssue]);

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
    if (togglingRef.current) return;
    togglingRef.current = true;
    setToggling(true);
    try {
      // Use the helper's live request/continuation counters. Merely having the
      // ChatGPT process open is not evidence that stopping Trace interrupts a
      // conversation.
      if (capturing) {
        let hasLiveConversation = false;
        try {
          hasLiveConversation = await bridge.api.disableBreaksCodex();
        } catch {
          showToast('无法确认当前请求状态，Trace 未停止。', 'error');
          return;
        }
        if (hasLiveConversation) {
          const ok = await confirm({
            title: '停止 Trace',
            body: '当前仍有对话正在进行。停止后，未完成的回复或工具调用结果可能丢失。',
            confirmText: '确认停止',
            cancelText: '取消',
            tone: 'danger',
          });
          if (!ok) return;
        }
      }
      const next = await bridge.api.toggleTracing();
      bridge.patch({ runtime: next });
      const envIssue = environmentOverrideIssue(next);
      const issue = chatGptSkippedIssue(next);
      if (envIssue && shownEnvironmentIssueRef.current !== envIssue) {
        shownEnvironmentIssueRef.current = envIssue;
        showToast(envIssue, 'error', ENVIRONMENT_OVERRIDE_TOAST_ID);
      } else if (issue && shownChatGptIssueRef.current !== issue) {
        shownChatGptIssueRef.current = issue;
        showToast(issue, 'error', CHATGPT_CONNECTION_TOAST_ID);
      } else if (next.tracingEnabled) {
        showToast('Trace 已开启；当前任务未生效时，请手动重启 ChatGPT。', 'info', TRACE_WAITING_TOAST_ID);
      }
    } catch (e) {
      const connectingChatGpt = !capturing
        && clients.some(client => client.id === 'codex-cli' && client.enabled);
      showToast(
        connectingChatGpt
          ? CHATGPT_CONNECTION_FAILED_TEXT
          : e instanceof Error && e.message
            ? e.message
            : '无法切换捕获状态',
        'error',
        connectingChatGpt ? CHATGPT_CONNECTION_TOAST_ID : undefined
      );
    } finally {
      togglingRef.current = false;
      setToggling(false);
    }
  }, [capturing, clients, bridge.api, bridge.patch, confirm]);

  React.useEffect(() => {
    const requestToggle = () => { void handleToggle(); };
    window.addEventListener(TRACE_TOGGLE_REQUEST_EVENT, requestToggle);
    return () => window.removeEventListener(TRACE_TOGGLE_REQUEST_EVENT, requestToggle);
  }, [handleToggle]);

  const handleClientToggle = React.useCallback(async (id: string) => {
    try {
      const next = await bridge.api.toggleClient(id as 'claude-cli' | 'codex-cli');
      bridge.patch({ runtime: next });
      const issue = environmentOverrideIssue(next, id);
      if (issue) showToast(issue, 'error', ENVIRONMENT_OVERRIDE_TOAST_ID);
    } catch (e) {
      showToast(e instanceof Error && e.message ? e.message : '客户端接入失败', 'error');
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
        <div className="idle-state">
          <button
            type="button"
            className="capture-dial"
            id="captureBtn"
            aria-pressed={capturing}
            aria-label="开始捕获"
            disabled={toggling}
            onClick={handleToggle}
          >
            <svg viewBox="0 0 30 30" aria-hidden="true">
              <path d="M11.6 8.6 11.6 21.4 22.4 15 Z" fill="currentColor" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="idle-sources">
            <div className="srcs" role="group" aria-label="捕获来源">
              {clients.map(c => (
                <ClientToggle key={c.id} client={c} onToggle={handleClientToggle} variant="idle" />
              ))}
            </div>
          </div>
        </div>

        {/* Live board */}
        <div className="live-layout" id="liveBoard" aria-hidden={!capturing}>
          <div className="signal-top">
            <div className="srcs" role="group" aria-label="捕获来源">
              {clients.map(c => (
                <ClientToggle key={c.id} client={c} onToggle={handleClientToggle} variant="live" />
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
                aria-label="停止捕获"
                disabled={toggling}
                onClick={handleToggle}
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

function chatGptSkippedIssue(runtime: XwXDeckRuntimeState | null): string | undefined {
  if (!runtime?.tracingEnabled) return undefined;
  const chatGpt = runtime.clients.find(client => client.id === 'codex-cli');
  if (!chatGpt?.enabled || chatGpt.status !== 'skipped') return undefined;
  const detail = chatGpt.detail?.trim() || '';
  if (detail === CHATGPT_CONNECTION_FAILED_TEXT || detail === CHATGPT_CONNECTION_UNSUPPORTED_TEXT) return detail;
  if (detail.includes('XwX Deck') || detail.includes('XwX Client') || detail.includes('本地代理') || detail.includes('同时接入')) {
    return CHATGPT_CONNECTION_UNSUPPORTED_TEXT;
  }
  if (detail.includes('写入失败') || detail.includes('路由未就绪') || detail.includes('未指向当前')) {
    return CHATGPT_CONNECTION_FAILED_TEXT;
  }
  if (detail.includes('未找到') || detail.includes('尚未')) return 'ChatGPT 暂未接入，未找到客户端配置。';
  return detail ? `ChatGPT 暂未接入，${detail}。` : 'ChatGPT 暂未接入。';
}

function environmentOverrideIssue(runtime: XwXDeckRuntimeState | null, clientId?: string): string | undefined {
  if (!runtime?.tracingEnabled) return undefined;
  const client = runtime.clients.find(item => (
    item.enabled
    && item.status === 'skipped'
    && (!clientId || item.id === clientId)
    && item.detail.includes('检测到环境变量')
  ));
  return client?.detail;
}
