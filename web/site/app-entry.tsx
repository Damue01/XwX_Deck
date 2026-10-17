try { localStorage.setItem('xwx-deck.sidebar', 'collapsed'); } catch { /* usable without storage */ }
import { createPreviewApi } from '../../src/renderer/bridge/previewApi';
import { changeLanguage, isLanguage } from '../../src/renderer/lib/i18n';

// Website demo: the real renderer with the browser-only preview bridge, plus a
// realistic sample setup layered on top. Nothing here reads or writes a real
// client file, account or key. All names, e-mails and numbers are illustrative.

// Inside the site the app runs in a frame: keep its focus and scroll handling from scrolling the host page.
if (window.parent !== window) {
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (options?: FocusOptions) { focus.call(this, { ...options, preventScroll: true }); };
  Element.prototype.scrollIntoView = function (this: Element) {
    let box = this.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (!box) return;
    const a = this.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (a.top < b.top) box.scrollTop += a.top - b.top; else if (a.bottom > b.bottom) box.scrollTop += a.bottom - b.bottom;
  };
}

const base: any = createPreviewApi();
const api: any = { ...base };
(window as any).xwxDeck = api;
try { localStorage.setItem('xwx-deck.onboardingSeen', 'true'); } catch { /* storage unavailable */ }
const query = new URLSearchParams(location.search);
const lang = query.get('lang');
void changeLanguage(isLanguage(lang) ? lang : 'zh-CN', async () => {});

const clone = <T,>(value: T): T => structuredClone(value);
const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600, DAY = 86400;

/* ---------- Model catalogs, per service (ids from the bundled price catalog) ---------- */
type Entry = Record<string, unknown> & { id: string };
const levels = ['low', 'medium', 'high', 'xhigh'];
const gpt = (id: string, displayName: string, contextWindow: number, defaultReasoningLevel = 'medium'): Entry => ({
  id, displayName, vendor: 'OpenAI', protocols: ['openai-responses'], protocolsDeclared: true, clients: ['codex', 'claude'],
  contextWindow, reasoning: true, toolCalling: true, vision: true, inputModalities: ['text', 'image'], reasoningLevels: levels, defaultReasoningLevel
});
const CHATGPT = [
  gpt('gpt-6.1-sol', 'GPT-6.1 Sol', 500_000, 'low'),
  gpt('gpt-6-astra', 'GPT-6 Astra', 500_000),
  gpt('gpt-6-sol', 'GPT-6 Sol', 500_000, 'low'),
  gpt('gpt-6-luna', 'GPT-6 Luna', 500_000),
  gpt('gpt-5.6-sol', 'GPT-5.6 Sol', 1_050_000, 'low'),
  gpt('gpt-5.6-terra', 'GPT-5.6 Terra', 1_050_000),
  gpt('gpt-5.6-luna', 'GPT-5.6 Luna', 1_050_000),
  gpt('gpt-5.5', 'GPT-5.5', 400_000),
  gpt('gpt-5.4-mini', 'GPT-5.4 mini', 400_000),
  gpt('gpt-5.3-codex', 'GPT-5.3 Codex', 400_000)
];
const claudeModel = (id: string, displayName: string, contextWindow: number): Entry => ({
  id, displayName, vendor: 'Anthropic', protocols: ['anthropic-messages'], protocolsDeclared: true, clients: ['codex', 'claude'],
  contextWindow, reasoning: true, toolCalling: true, vision: true, interleavedThinking: true
});
const CLAUDE = [
  claudeModel('claude-fable-5-1', 'Claude Fable 5.1', 1_000_000),
  claudeModel('claude-opus-5-5', 'Claude Opus 5.5', 1_000_000),
  claudeModel('claude-sonnet-5-5', 'Claude Sonnet 5.5', 1_000_000),
  claudeModel('claude-haiku-5-5', 'Claude Haiku 5.5', 200_000)
];
const compat = (vendor: string, protocols: string[]) => (id: string, contextWindow: number, extra: Record<string, unknown> = {}): Entry => ({
  id, vendor, protocols, protocolsDeclared: true, clients: ['codex', 'claude'], contextWindow, toolCalling: true, ...extra
});
const zhipu = compat('Zhipu', ['chat-completions']);
const deepseek = compat('DeepSeek', ['openai-responses', 'anthropic-messages']);
const kimi = compat('Moonshot', ['chat-completions']);
const CATALOGS: Record<string, Entry[]> = {
  zhipu: [zhipu('glm-5.3', 200_000, { reasoning: true }), zhipu('glm-5.3-flash', 200_000), zhipu('glm-5.2', 200_000, { reasoning: true }), zhipu('glm-5v-turbo', 128_000, { vision: true })],
  deepseek: [deepseek('deepseek-v4-pro', 256_000, { reasoning: true }), deepseek('deepseek-v4-flash', 256_000)],
  kimi: [kimi('kimi-k3', 256_000, { reasoning: true }), kimi('kimi-k3-fast', 256_000), kimi('kimi-k2.7-code', 256_000)]
};

/* ---------- Subscription accounts ---------- */
const window5h = (remaining: number, resetIn: number) => ({ limitId: 'codex', window: 'primary', usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: now() + resetIn, windowSeconds: 5 * HOUR });
const weekly = (remaining: number, resetIn: number) => ({ limitId: 'codex', window: 'secondary', usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: now() + resetIn, windowSeconds: 7 * DAY });
interface Usage { plan: string; short: [number, number]; week: [number, number]; credits: number }
const usage: Record<string, Usage> = {
  'official-chatgpt': { plan: 'plus', short: [62, 2 * HOUR + 13 * 60], week: [81, 4 * DAY + 6 * HOUR], credits: 1 },
  'official-chatgpt-studio': { plan: 'pro', short: [91, 3 * HOUR + 40 * 60], week: [64, 2 * DAY + 9 * HOUR], credits: 2 },
  'official-chatgpt-team': { plan: 'team', short: [12, 47 * 60], week: [35, 5 * DAY + 2 * HOUR], credits: 0 }
};
let accounts: any[] = [
  { id: 'official-chatgpt', platform: 'chatgpt', authKind: 'official', externalLogin: true, accountKey: 'k-lin', label: '林青', email: 'lin.qing@example.com', status: 'connected' },
  { id: 'official-chatgpt-studio', platform: 'chatgpt', authKind: 'official', accountKey: 'k-chen', label: '陈雨', email: 'chen.yu@example.com', status: 'connected' },
  { id: 'official-chatgpt-team', platform: 'chatgpt', authKind: 'official', accountKey: 'k-zhou', label: '周默', email: 'zhou.mo@example.com', status: 'connected' },
  { id: 'claude-subscription-lin', platform: 'claude', label: '林青', email: 'lin.qing@example.com', status: 'connected', claudeRemaining: 70 }
];
let routing: Record<string, unknown> = {};
let flow: any = null;
function withQuota(account: any) {
  const u = usage[account.id];
  if (account.status !== 'connected') return { ...account };
  if (u) {
    const windows = [window5h(...u.short), weekly(...u.week)];
    return {
      ...account,
      quota: { remainingPercent: Math.min(u.short[0], u.week[0]), resetsAt: windows[0].resetsAt, checkedAt: now() },
      quotaDetails: {
        source: 'codex-app-server', httpStatus: 200, checkedAt: now(), planType: u.plan, windows,
        availableResetCredits: u.credits,
        resetCredits: Array.from({ length: u.credits }, (_, i) => ({ id: `${account.id}-credit-${i}`, expiresAt: now() + (12 + i * 9) * DAY, title: '额度重置', status: 'available' }))
      }
    };
  }
  if (typeof account.claudeRemaining === 'number') return { ...account, quota: { remainingPercent: account.claudeRemaining, resetsAt: now() + 3 * HOUR, checkedAt: now() } };
  return { ...account };
}
const snapshot = () => clone({ supported: true, officialLoginInstalled: true, claudeInstalled: true, accounts: accounts.map(withQuota), routing, flow });

/* ---------- Model services ---------- */
const empty = { fable: '', opus: '', sonnet: '', haiku: '' };
const subscription = (accountId: string, displayName: string, accountLabel: string, adapter: string, baseUrl: string, codexModel: string, claudeModels: typeof empty) => ({
  id: `subscription-${accountId}`, subscriptionAccountId: accountId, accountLabel, displayName, codexProviderId: 'xwx_deck',
  baseUrl, bearerToken: '', adapter, codexApiFormat: adapter === 'anthropic-messages' ? 'responses' : adapter, codexModel, codexContextWindow: 0, claudeModels
});
const custom = (id: string, displayName: string, baseUrl: string, adapter: string, codexModel: string, claudeModels: typeof empty) => ({
  id, displayName, baseUrl, bearerToken: 'sk-••••••••', adapter, codexApiFormat: adapter === 'anthropic-messages' ? 'responses' : adapter, codexProviderId: 'xwx_deck', codexModel, codexContextWindow: 0, claudeModels
});
const chatgptRoles = { fable: '', opus: 'gpt-6.1-sol', sonnet: 'gpt-6-sol', haiku: 'gpt-6-luna' };
let connections: any[] = [
  subscription('official-chatgpt', '林青', 'lin.qing@example.com', 'responses', 'https://chatgpt.com/backend-api', 'gpt-6.1-sol', chatgptRoles),
  subscription('official-chatgpt-studio', '陈雨', 'chen.yu@example.com', 'responses', 'https://chatgpt.com/backend-api', 'gpt-6.1-sol', chatgptRoles),
  subscription('official-chatgpt-team', '周默', 'zhou.mo@example.com', 'responses', 'https://chatgpt.com/backend-api', 'gpt-6.1-sol', chatgptRoles),
  subscription('claude-subscription-lin', '林青', 'lin.qing@example.com', 'anthropic-messages', 'https://api.anthropic.com/v1', 'claude-sonnet-5-5', { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }),
  custom('svc-zhipu', '智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4', 'chat-completions', 'glm-5.3', { fable: '', opus: 'glm-5.3', sonnet: 'glm-5.3', haiku: 'glm-5.3-flash' }),
  custom('svc-deepseek', 'DeepSeek', 'https://api.deepseek.com', 'responses', 'deepseek-v4-pro', { fable: '', opus: 'deepseek-v4-pro', sonnet: 'deepseek-v4-pro', haiku: 'deepseek-v4-flash' }),
  custom('svc-kimi', 'Kimi', 'https://api.moonshot.cn/v1', 'chat-completions', 'kimi-k3', { fable: '', opus: 'kimi-k3', sonnet: 'kimi-k3', haiku: 'kimi-k3-fast' })
];
let selected: Record<string, string | null> = { codex: 'subscription-official-chatgpt', claude: 'svc-zhipu' };
let officialModel = 'gpt-6.1-sol';
let contextWindows: Record<string, number | undefined> = { 'subscription-official-chatgpt': 500_000, 'subscription-official-chatgpt-studio': 500_000, 'subscription-official-chatgpt-team': 500_000 };
const providers = () => clone({ version: 1, identityVersion: 2, connections, selected, active: { ...selected } });
const find = (id: string | null | undefined) => connections.find(c => c.id === id);

function catalogFor(connection: any): Entry[] {
  if (!connection) return CHATGPT;
  const account = connection.subscriptionAccountId as string | undefined;
  if (account?.startsWith('claude-subscription')) return CLAUDE;
  if (account) return CHATGPT;
  const host = connection.baseUrl as string;
  if (host.includes('bigmodel')) return CATALOGS.zhipu;
  if (host.includes('deepseek')) return CATALOGS.deepseek;
  if (host.includes('moonshot')) return CATALOGS.kimi;
  return [compat('已配置', [connection.adapter === 'anthropic-messages' ? 'anthropic-messages' : connection.adapter === 'chat-completions' ? 'chat-completions' : 'openai-responses'])(connection.codexModel || 'default', 128_000)];
}

async function codexConfig() {
  const base0 = await base.getCodexConfig();
  const connection = find(selected.codex);
  return {
    ...base0,
    configPath: 'C:\\Users\\demo\\.codex\\config.toml', exists: true,
    mode: connection ? 'compatible' : 'official',
    officialModel: connection ? '' : officialModel,
    activeProvider: connection ? 'xwx_deck' : 'openai',
    activeBaseUrl: connection ? connection.baseUrl : 'https://api.openai.com/v1',
    configuredProviders: connection ? ['openai', 'xwx_deck'] : ['openai'],
    modelCatalogSource: 'none', configOwnership: 'deck',
    modelContextWindow: contextWindows[selected.codex ?? 'official'],
    compatible: { provider: 'xwx_deck', model: connection?.codexModel ?? '', baseUrl: connection?.baseUrl ?? '', bearerToken: connection?.bearerToken ?? '' }
  };
}
const claudeModels = () => clone(find(selected.claude)?.claudeModels ?? empty);

// Trace storage that matches the sample usage (about 15.6M tokens recorded).
const withStorage = (state: any) => state && ({ ...state, traceStorageBytes: 612 * 1024 ** 2, storageText: `612 MB / ${state.traceWarningGB ?? 1} GB` });
const wrapState = (name: string) => { const fn = base[name]; if (fn) api[name] = async (...args: unknown[]) => withStorage(await fn(...args)); };
if (base.onState) api.onState = (listener: (state: unknown) => void) => base.onState((state: unknown) => listener(withStorage(state)));
for (const name of ['getState', 'refresh', 'toggleTracing', 'toggleClient', 'setTraceStoragePolicy', 'setTraceAppearance', 'setTheme', 'setStartupEnabled', 'updateTraceDirectories']) wrapState(name);

Object.assign(api, {
  openDashboard: async () => { window.open(new URL('./view.html', location.href).href, '_blank', 'noopener'); },
  getProviders: async () => providers(),
  saveProvider: async (input: any) => {
    const existing = find(input.id);
    const next = { ...(existing ?? { id: `svc-${Date.now().toString(36)}`, codexProviderId: 'xwx_deck', codexContextWindow: 0, claudeModels: { ...empty } }), ...input, codexApiFormat: input.adapter === 'anthropic-messages' ? 'responses' : input.adapter === 'chat-completions' ? 'chat-completions' : 'responses', codexModel: input.codexModel ?? existing?.codexModel ?? '' };
    connections = existing ? connections.map(c => c.id === next.id ? next : c) : [...connections, next];
    return providers();
  },
  deleteProvider: async (id: string) => {
    if (Object.values(selected).includes(id)) throw new Error('请先切换正在使用此连接的客户端，再删除。');
    connections = connections.filter(c => c.id !== id);
    return providers();
  },
  switchClientProvider: async ({ client, providerId }: { client: string; providerId: string | null }) => {
    if (providerId && !find(providerId)) throw new Error('模型服务不可用。');
    selected = { ...selected, [client]: providerId };
    return providers();
  },
  getModelServices: async () => {
    const services = await base.getModelServices();
    const claude = !!selected.claude;
    return { ...services, claude, codex: !!selected.codex, claudeStatus: { ...services.claudeStatus, enabled: claude, status: claude ? 'active' : 'disabled', configPath: 'C:\\Users\\demo\\.claude\\settings.json', traceManaged: false } };
  },
  getCodexConfig: codexConfig,
  updateCodexConfig: async (value: any) => {
    const connection = find(selected.codex);
    if (connection) {
      const model = value.compatibleModel;
      if (model) connections = connections.map(c => c.id === connection.id ? { ...c, codexModel: model } : c);
    } else if (value.officialModel) officialModel = value.officialModel;
    if ('modelContextWindow' in value) contextWindows[selected.codex ?? 'official'] = typeof value.modelContextWindow === 'number' ? value.modelContextWindow : undefined;
    return codexConfig();
  },
  getClaudeModels: async () => claudeModels(),
  updateClaudeModels: async ({ expectedProviderId: _expected, ...roles }: any) => {
    const id = selected.claude;
    if (id) connections = connections.map(c => c.id === id ? { ...c, claudeModels: { ...c.claudeModels, ...roles } } : c);
    return claudeModels();
  },
  fetchModels: async (payload?: { expectedProviderId?: string | null }) => {
    const id = payload && 'expectedProviderId' in payload ? payload.expectedProviderId : selected.codex;
    return clone(catalogFor(find(id)));
  },
  fetchProviderModels: async ({ providerId }: { providerId: string }) => clone(catalogFor(find(providerId))),
  validateProvider: async (input: any) => { const c = find(input.providerId); return { status: 'valid', providerId: input.providerId, providerName: c?.displayName ?? '', protocol: c?.adapter === 'chat-completions' ? 'chat-completions' : c?.adapter === 'anthropic-messages' ? 'anthropic-messages' : 'responses', httpStatus: 200 }; },

  /* Subscriptions */
  getSubscriptionAccounts: async () => snapshot(),
  refreshSubscriptionUsage: async () => snapshot(),
  setSubscriptionRouting: async ({ platform, policy }: any) => { routing = { ...routing, [platform]: clone(policy) }; return snapshot(); },
  renameSubscriptionAccount: async ({ accountId, label }: { accountId: string; label: string }) => {
    accounts = accounts.map(a => a.id === accountId ? { ...a, label } : a);
    connections = connections.map(c => c.subscriptionAccountId === accountId ? { ...c, displayName: label } : c);
    return providers();
  },
  getOfficialChatgptAccount: async () => clone(withQuota(accounts.find(a => a.id === 'official-chatgpt'))),
  getOfficialChatgptResetCredits: async (accountId: string) => clone(withQuota(accounts.find(a => a.id === accountId))),
  consumeOfficialChatgptResetCredit: async ({ accountId }: { accountId: string }) => {
    const u = usage[accountId];
    if (!u || u.credits < 1) return { outcome: 'nothingToReset' };
    u.credits -= 1; u.short = [100, 5 * HOUR];
    return { outcome: 'reset' };
  },
  beginSubscriptionSignIn: async (input: { accountId?: string; platform?: string }) => {
    const official = input.platform === 'chatgpt-official';
    const platform = official ? 'chatgpt' : input.platform ?? 'chatgpt';
    const accountId = input.accountId ?? (official ? `official-chatgpt-${Date.now().toString(36)}` : platform === 'claude' ? `claude-subscription-${Date.now().toString(36)}` : `${platform}-${Date.now().toString(36)}`);
    flow = { id: `flow-${Date.now()}`, platform, authKind: official ? 'official' : 'api', accountId, status: 'waiting', ...(platform === 'copilot' ? { userCode: 'DEMO-2026' } : {}) };
    const current = flow;
    // Sign-in completes on its own a moment later, so the full flow can be previewed.
    setTimeout(() => {
      if (flow !== current) return;
      if (!accounts.some(a => a.id === accountId)) {
        accounts = [...accounts, { id: accountId, platform, ...(official ? { authKind: 'official', accountKey: `k-${accountId}` } : {}), label: '新账号', email: 'new.account@example.com', status: 'connected' }];
        if (official) usage[accountId] = { plan: 'plus', short: [100, 5 * HOUR], week: [100, 7 * DAY], credits: 0 };
      } else accounts = accounts.map(a => a.id === accountId ? { ...a, status: 'connected' } : a);
      flow = { ...current, status: 'complete' };
    }, 2400);
    return snapshot();
  },
  cancelSubscriptionSignIn: async () => { flow = null; return snapshot(); },
  connectSubscriptionAccount: async (accountId: string) => {
    flow = null;
    if (!connections.some(c => c.subscriptionAccountId === accountId)) {
      const account = accounts.find(a => a.id === accountId);
      const claude = accountId.startsWith('claude-subscription');
      connections = [...connections, claude
        ? subscription(accountId, account?.label ?? '新账号', account?.email ?? '', 'anthropic-messages', 'https://api.anthropic.com/v1', '', { ...empty })
        : subscription(accountId, account?.label ?? '新账号', account?.email ?? '', 'responses', 'https://chatgpt.com/backend-api', '', { ...empty })];
    }
    return providers();
  },
  signOutSubscriptionAccount: async (input: string | { accountId: string }) => {
    const id = typeof input === 'string' ? input : input.accountId;
    accounts = accounts.map(a => a.id === id ? { ...a, status: 'signed-out' } : a);
    return { revoked: true, localCredentialsCleared: true };
  }
});

const publicPages = new Set(['models', 'settings', 'signal']);
const go = (page: string) => { if (publicPages.has(page)) window.dispatchEvent(new CustomEvent('xwxdeck:navigate', { detail: page })); };
addEventListener('hashchange', () => go(location.hash.slice(1)));
// Parent page can switch views without reloading the frame.
addEventListener('message', event => { if (event.source === window.parent && event.origin === location.origin && typeof event.data?.deckPage === 'string') go(event.data.deckPage); });
import('../../src/renderer/main').then(() => { const p = location.hash.slice(1); if (p) setTimeout(() => go(p), 60); });

api.openDashboard = async () => {
  if (window.parent !== window) window.parent.postMessage({ deckDashboard: true }, location.origin);
  else window.open(new URL('./view.html', location.href).href, '_blank', 'noopener');
};
