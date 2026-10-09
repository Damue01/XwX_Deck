/** Download / installation pages only; this catalog does not imply Trace support. */
export const CLIENT_DOWNLOADS = [
  { id: 'codex', label: 'ChatGPT', downloadLabel: 'ChatGPT Desktop', icon: 'chatgpt', url: 'https://learn.chatgpt.com/docs/app' },
  { id: 'claude', label: 'Claude', downloadLabel: 'Claude Desktop', icon: 'claude', url: 'https://claude.com/download' },
  { id: 'deepseek-harness', label: 'DeepSeek Harness', icon: 'deepseek', url: 'https://deepseek.com/harness/' },
  { id: 'zcode', label: 'ZCode（智谱）', icon: 'zhipu', url: 'https://zcode.z.ai/cn/docs/install' },
  { id: 'kimi-code', label: 'Kimi Code', icon: 'kimi', url: 'https://www.kimi.com/code/docs/' },
  { id: 'minimax-code', label: 'MiniMax Code', icon: 'minimax', url: 'https://agent.minimax.io' },
  { id: 'codex-cli', label: 'Codex CLI', icon: 'chatgpt', url: 'https://learn.chatgpt.com/docs/codex/cli' },
  { id: 'claude-code', label: 'Claude Code', downloadLabel: 'Claude Code CLI', icon: 'claude', url: 'https://code.claude.com/docs/en/setup' },
  { id: 'gemini-cli', label: 'Gemini CLI', icon: 'gemini', url: 'https://geminicli.com/docs/get-started/installation/' },
  { id: 'qwen-code', label: 'Qwen Code', downloadLabel: 'Qwen Code Desktop', icon: 'qwen', url: 'https://github.com/QwenLM/qwen-code/releases/tag/desktop-latest' },
  { id: 'grok-build', label: 'Grok Build', icon: 'xai', url: 'https://x.ai/build' },
  { id: 'cursor', label: 'Cursor', downloadLabel: 'Cursor Desktop', icon: 'cursor', url: 'https://cursor.com/downloads' },
  { id: 'windsurf', label: 'Devin（Windsurf）', icon: 'windsurf', url: 'https://devin.ai/download' },
  { id: 'vscode', label: 'VS Code', icon: 'vscode', url: 'https://code.visualstudio.com/download' },
  { id: 'zed', label: 'Zed', icon: 'zed', url: 'https://zed.dev/download' },
  { id: 'trae', label: 'TRAE', icon: 'trae', url: 'https://www.trae.cn/download' },
  { id: 'opencode', label: 'OpenCode', downloadLabel: 'OpenCode Desktop', icon: 'opencode', url: 'https://opencode.ai/download' },
  { id: 'cline', label: 'Cline', icon: 'cline', url: 'https://docs.cline.bot/getting-started/installing-cline' },
  { id: 'goose', label: 'Goose', icon: 'goose', url: 'https://block.github.io/goose/' },
  { id: 'pi', label: 'Pi', downloadLabel: 'Pi CLI', icon: 'pi', url: 'https://github.com/earendil-works/pi#getting-started' },
  { id: 'oh-my-pi', label: 'oh-my-pi', downloadLabel: 'oh-my-pi CLI', icon: 'omp', url: 'https://github.com/can1357/oh-my-pi#install' },
  { id: 'crush', label: 'Crush', downloadLabel: 'Crush CLI', icon: 'crush', url: 'https://github.com/charmbracelet/crush#installation' },
  { id: 'qoder', label: 'Qoder', downloadLabel: 'Qoder CLI', icon: 'qoder', url: 'https://docs.qoder.com/cli/installation' },
  { id: 'droid', label: 'Droid', downloadLabel: 'Droid CLI', icon: 'factory', url: 'https://docs.factory.com/droid-cli/quickstart' },
  { id: 'copilot-cli', label: 'GitHub Copilot', downloadLabel: 'GitHub Copilot CLI', icon: 'copilot', url: 'https://docs.github.com/en/copilot/get-started/cli-quickstart' },
  { id: 'cursor-cli', label: 'Cursor CLI', icon: 'cursor', url: 'https://cursor.com/docs/cli/installation' },
  { id: 'mimo-code', label: 'MiMo Code', downloadLabel: 'MiMo Code CLI', icon: 'mimocode', url: 'https://github.com/XiaomiMiMo/MiMo-Code#installation' },
  { id: 'workbuddy', label: 'WorkBuddy', downloadLabel: 'WorkBuddy Desktop', icon: 'workbuddy', url: 'https://www.codebuddy.cn/app/' },
  { id: 'codebuddy-code', label: 'CodeBuddy Code', downloadLabel: 'CodeBuddy Code CLI', icon: 'codebuddy', url: 'https://www.codebuddy.ai/docs/cli/quickstart' },
  { id: 'hermes-agent', label: 'Hermes Agent', downloadLabel: 'Hermes Agent CLI', icon: 'hermes', url: 'https://github.com/NousResearch/hermes-agent#installation' },
  { id: 'antigravity-cli', label: 'Antigravity', downloadLabel: 'Antigravity CLI', icon: 'antigravity', url: 'https://www.antigravity.google/docs/cli/install/' },
  { id: 'openchamber', label: 'OpenChamber', downloadLabel: 'OpenChamber Desktop', icon: 'openchamber', url: 'https://github.com/openchamber/openchamber' },
  { id: 't3-code', label: 'T3 Code', downloadLabel: 'T3 Code Desktop', icon: 't3code', url: 'https://github.com/pingdotgg/t3code' },
  { id: 'cherry-studio', label: 'Cherry Studio', icon: 'cherry-studio', url: 'https://www.cherry-ai.com/download' },
  { id: 'ollama-app', label: 'Ollama', icon: 'ollama', url: 'https://ollama.com/download' },
  { id: 'lmstudio-app', label: 'LM Studio', icon: 'lmstudio', url: 'https://lmstudio.ai/download' }
] as const;

export function clientDownloadLabel(client: typeof CLIENT_DOWNLOADS[number]): string {
  return 'downloadLabel' in client ? client.downloadLabel : client.label;
}

/** Product names for the directory; version names belong in download details. */
export function clientCatalogLabel(client: typeof CLIENT_DOWNLOADS[number]): string {
  return client.id === 'codex' ? 'ChatGPT / Codex' : client.label;
}

export const MODEL_CLIENT_ADDED_EVENT = 'xwxdeck:model-client-added';

export function modelClientRoute(id: DownloadClientId): 'claude' | 'codex' | null {
  if (id === 'claude' || id === 'claude-code') return 'claude';
  if (id === 'codex' || id === 'codex-cli') return 'codex';
  return null;
}

export type DownloadClientId = typeof CLIENT_DOWNLOADS[number]['id'];
export function canonicalModelClient(id: DownloadClientId): DownloadClientId {
  return modelClientRoute(id) ?? (id === 'cursor-cli' ? 'cursor' : id);
}

export const MODEL_CLIENT_CATALOG = CLIENT_DOWNLOADS.filter(client => !['codex-cli', 'claude-code', 'cursor-cli'].includes(client.id));

/** Clients with reversible configuration adapters, rather than download-only entries. */
const MANAGED_MODEL_CLIENTS: readonly DownloadClientId[] = ['claude', 'codex', 'opencode', 'gemini-cli', 'qwen-code', 'pi', 'mimo-code', 'crush', 'qoder', 'droid', 'codebuddy-code', 'workbuddy'];
export function supportsManagedModels(client: DownloadClientId): boolean {
  return MANAGED_MODEL_CLIENTS.includes(canonicalModelClient(client));
}

export interface ClientInstallationSnapshot {
  readonly available: boolean;
  readonly clients: readonly { id: DownloadClientId; installed: boolean }[];
}

export function normalizeModelClients(ids: readonly DownloadClientId[]): DownloadClientId[] {
  return [...new Set(ids.filter(id => CLIENT_DOWNLOADS.some(client => client.id === id)).map(canonicalModelClient))];
}
export type DownloadClientIcon = typeof CLIENT_DOWNLOADS[number]['icon'];
export const ADDITIONAL_CLIENT_WEBSITES = Object.fromEntries(CLIENT_DOWNLOADS.filter(client => client.id !== 'codex' && client.id !== 'claude').map(client => [`download-${client.id}`, client.url])) as Readonly<Record<`download-${Exclude<DownloadClientId, 'codex' | 'claude'>}`, string>>;
