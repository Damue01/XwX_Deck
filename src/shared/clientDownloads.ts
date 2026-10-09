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
  { id: 'qwen-code', label: 'Qwen Code', icon: 'qwen', url: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/' },
  { id: 'grok-build', label: 'Grok Build', icon: 'xai', url: 'https://x.ai/build' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor', url: 'https://cursor.com/downloads' },
  { id: 'windsurf', label: 'Devin（Windsurf）', icon: 'windsurf', url: 'https://devin.ai/download' },
  { id: 'vscode', label: 'VS Code', icon: 'vscode', url: 'https://code.visualstudio.com/download' },
  { id: 'zed', label: 'Zed', icon: 'zed', url: 'https://zed.dev/download' },
  { id: 'trae', label: 'TRAE', icon: 'trae', url: 'https://www.trae.cn/download' },
  { id: 'opencode', label: 'OpenCode', icon: 'opencode', url: 'https://opencode.ai/download' },
  { id: 'cline', label: 'Cline', icon: 'cline', url: 'https://docs.cline.bot/getting-started/installing-cline' },
  { id: 'goose', label: 'Goose', icon: 'goose', url: 'https://block.github.io/goose/' },
  { id: 'cherry-studio', label: 'Cherry Studio', icon: 'cherry-studio', url: 'https://www.cherry-ai.com/download' },
  { id: 'ollama-app', label: 'Ollama', icon: 'ollama', url: 'https://ollama.com/download' },
  { id: 'lmstudio-app', label: 'LM Studio', icon: 'lmstudio', url: 'https://lmstudio.ai/download' }
] as const;

export function clientDownloadLabel(client: typeof CLIENT_DOWNLOADS[number]): string {
  return 'downloadLabel' in client ? client.downloadLabel : client.label;
}

export const MODEL_CLIENT_ADDED_EVENT = 'xwxdeck:model-client-added';

export function modelClientRoute(id: DownloadClientId): 'claude' | 'codex' | null {
  if (id === 'claude' || id === 'claude-code') return 'claude';
  if (id === 'codex' || id === 'codex-cli') return 'codex';
  return null;
}

export type DownloadClientId = typeof CLIENT_DOWNLOADS[number]['id'];
export const MODEL_CLIENT_CATALOG = CLIENT_DOWNLOADS.filter(client => !['codex-cli', 'claude-code'].includes(client.id));

export interface ClientInstallationSnapshot {
  readonly available: boolean;
  readonly clients: readonly { id: DownloadClientId; installed: boolean }[];
}

export function normalizeModelClients(ids: readonly DownloadClientId[]): DownloadClientId[] {
  return [...new Set(ids.filter(id => CLIENT_DOWNLOADS.some(client => client.id === id)).map(id => modelClientRoute(id) ?? id))];
}
export type DownloadClientIcon = typeof CLIENT_DOWNLOADS[number]['icon'];
export const ADDITIONAL_CLIENT_WEBSITES = Object.fromEntries(CLIENT_DOWNLOADS.filter(client => client.id !== 'codex' && client.id !== 'claude').map(client => [`download-${client.id}`, client.url])) as Readonly<Record<`download-${Exclude<DownloadClientId, 'codex' | 'claude'>}`, string>>;
