import type { ProviderConnection, ProviderInput } from './providers';

// Ordinary domestic API accounts. Coding Plan endpoints and keys are separate.
// Source links are kept with each preset so endpoint updates are reviewable.
export const OFFICIAL_PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', adapter: 'responses', consoleUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com/guides/responses_api/' },
  { id: 'qwen', label: '千问', displayName: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', adapter: 'responses', consoleUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key', docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses' },
  { id: 'ark', label: '火山方舟', displayName: 'Volcengine-Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: 'responses', providerPreset: 'volcengine-ark', consoleUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey', docsUrl: 'https://docs.volcengine.com/docs/ark/product-overview?lang=zh' },
  { id: 'zhipu', label: '智谱 GLM', displayName: 'Zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'chat-completions', consoleUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/quick-start' },
  { id: 'kimi', label: 'Kimi', displayName: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', adapter: 'chat-completions', consoleUrl: 'https://platform.kimi.com/console/api-keys', docsUrl: 'https://platform.kimi.com/docs/get-api-key' },
  { id: 'minimax', label: 'MiniMax', displayName: 'MiniMax', baseUrl: 'https://api.minimax.cn/v1', adapter: 'chat-completions', consoleUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key', docsUrl: 'https://platform.minimax.cn/docs/api-reference/text-openai-api' },
  { id: 'tencent', label: '腾讯 TokenHub', displayName: 'Tencent-TokenHub', baseUrl: 'https://tokenhub.tencentmaas.com/v1', adapter: 'chat-completions', consoleUrl: 'https://console.cloud.tencent.com/tokenhub/apikey?regionId=1', docsUrl: 'https://cloud.tencent.com/document/product/1823/130078' }
] as const;

export type OfficialProviderId = typeof OFFICIAL_PROVIDERS[number]['id'];
export const OFFICIAL_PROVIDER_WEBSITES = Object.fromEntries(OFFICIAL_PROVIDERS.map(provider => [provider.id, provider.consoleUrl])) as Readonly<Record<OfficialProviderId, string>>;

export function newProviderDraft(connections: readonly ProviderConnection[] = [], id: OfficialProviderId | 'custom' = 'deepseek'): ProviderInput {
  const preset = OFFICIAL_PROVIDERS.find(provider => provider.id === id);
  const initialName = preset?.displayName ?? 'Custom';
  const names = new Set(connections.flatMap(provider => [provider.displayName, provider.codexProviderId]));
  let displayName: string = initialName;
  for (let suffix = 2; names.has(displayName); suffix++) displayName = `${initialName}-${suffix}`;
  return {
    displayName, baseUrl: preset?.baseUrl ?? '', bearerToken: '', adapter: preset?.adapter ?? 'auto',
    ...(preset && 'providerPreset' in preset ? { providerPreset: preset.providerPreset } : {})
  };
}
