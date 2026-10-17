import type { ProviderConnection, ProviderInput } from './providers';

// Official API presets, including local servers. No preset creates a connection.
// Source links are kept with each preset so endpoint updates are reviewable.
export const OFFICIAL_PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', adapter: 'responses', consoleUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com/guides/responses_api/' },
  { id: 'qwen', label: '千问', displayName: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', adapter: 'responses', consoleUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key', docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses' },
  { id: 'ark', label: '火山方舟', displayName: 'Volcengine-Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: 'responses', providerPreset: 'volcengine-ark', consoleUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey', docsUrl: 'https://docs.volcengine.com/docs/ark/product-overview?lang=zh' },
  { id: 'zhipu', label: '智谱 GLM', displayName: 'Zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'chat-completions', consoleUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/quick-start' },
  { id: 'kimi', label: 'Kimi', displayName: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', adapter: 'chat-completions', consoleUrl: 'https://platform.kimi.com/console/api-keys', docsUrl: 'https://platform.kimi.com/docs/get-api-key' },
  { id: 'minimax', label: 'MiniMax', displayName: 'MiniMax', baseUrl: 'https://api.minimax.cn/v1', adapter: 'chat-completions', consoleUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key', docsUrl: 'https://platform.minimax.cn/docs/api-reference/text-openai-api' },
  { id: 'tencent', label: '腾讯 TokenHub', displayName: 'Tencent-TokenHub', baseUrl: 'https://tokenhub.tencentmaas.com/v1', adapter: 'chat-completions', consoleUrl: 'https://console.cloud.tencent.com/tokenhub/apikey?regionId=1', docsUrl: 'https://cloud.tencent.com/document/product/1823/130078' },
  { id: 'openai-api', label: 'OpenAI', displayName: 'OpenAI_API', baseUrl: 'https://api.openai.com/v1', adapter: 'responses', icon: 'chatgpt', consoleUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://developers.openai.com/api/docs/quickstart' },
  { id: 'anthropic', label: 'Anthropic', displayName: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', adapter: 'anthropic-messages', icon: 'claude', consoleUrl: 'https://platform.claude.com/settings/keys', docsUrl: 'https://platform.claude.com/docs/en/api/messages' },
  { id: 'siliconflow', label: '硅基流动', displayName: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', adapter: 'chat-completions', consoleUrl: 'https://cloud.siliconflow.cn/account/ak', docsUrl: 'https://docs.siliconflow.cn/docs/userguide/quickstart' },
  { id: 'groq', label: 'Groq', displayName: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', adapter: 'chat-completions', consoleUrl: 'https://console.groq.com/keys', docsUrl: 'https://console.groq.com/docs/api-reference' },
  { id: 'mistral', label: 'Mistral', displayName: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', adapter: 'chat-completions', consoleUrl: 'https://console.mistral.ai/api-keys', docsUrl: 'https://docs.mistral.ai/api' },
  { id: 'xai', label: 'xAI', displayName: 'xAI', baseUrl: 'https://api.x.ai/v1', adapter: 'responses', consoleUrl: 'https://console.x.ai', docsUrl: 'https://docs.x.ai/developers/rest-api-reference/inference' },
  { id: 'qwen-coding', label: '百炼 Coding Plan', displayName: 'Bailian_Coding', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', adapter: 'chat-completions', icon: 'qwen', providerPreset: 'qwen-coding-plan', codingPlan: true, consoleUrl: 'https://bailian.console.aliyun.com/cn-beijing/?tab=globalset#/efm/coding_plan', docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan' },
  { id: 'zhipu-coding', label: '智谱 Coding Plan', displayName: 'GLM_Coding', baseUrl: 'https://open.bigmodel.cn/api/v1', adapter: 'responses', icon: 'zhipu', providerPreset: 'zhipu-coding-plan', codingPlan: true, consoleUrl: 'https://bigmodel.cn/coding-plan/personal/overview', docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/codex' },
  { id: 'gemini', label: 'Gemini', displayName: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', adapter: 'chat-completions', consoleUrl: 'https://aistudio.google.com/api-keys', docsUrl: 'https://ai.google.dev/gemini-api/docs/openai' },
  { id: 'openrouter', label: 'OpenRouter', displayName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', adapter: 'chat-completions', consoleUrl: 'https://openrouter.ai/settings/keys', docsUrl: 'https://openrouter.ai/docs/quickstart' },
  { id: 'together', label: 'Together AI', displayName: 'Together', baseUrl: 'https://api.together.ai/v1', adapter: 'chat-completions', consoleUrl: 'https://api.together.ai/settings/api-keys', docsUrl: 'https://docs.together.ai/docs/inference/openai-compatibility' },
  { id: 'fireworks', label: 'Fireworks AI', displayName: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', adapter: 'chat-completions', consoleUrl: 'https://app.fireworks.ai/settings/users/api-keys', docsUrl: 'https://docs.fireworks.ai/tools-sdks/openai-compatibility' },
  { id: 'nvidia', label: 'NVIDIA NIM', displayName: 'NVIDIA', baseUrl: 'https://integrate.api.nvidia.com/v1', adapter: 'chat-completions', consoleUrl: 'https://build.nvidia.com', docsUrl: 'https://docs.api.nvidia.com/nim/reference/llm-apis' },
  { id: 'cerebras', label: 'Cerebras', displayName: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', adapter: 'chat-completions', consoleUrl: 'https://cloud.cerebras.ai/platform', docsUrl: 'https://inference-docs.cerebras.ai/quickstart' },
  { id: 'perplexity', label: 'Perplexity', displayName: 'Perplexity', baseUrl: 'https://api.perplexity.ai/router/v1', adapter: 'chat-completions', consoleUrl: 'https://www.perplexity.ai/account/api/keys', docsUrl: 'https://docs.perplexity.ai/docs/getting-started/quickstart' },
  { id: 'huggingface', label: 'Hugging Face', displayName: 'HuggingFace', baseUrl: 'https://router.huggingface.co/v1', adapter: 'chat-completions', consoleUrl: 'https://huggingface.co/settings/tokens', docsUrl: 'https://huggingface.co/docs/inference-providers/tasks/chat-completion' },
  { id: 'stepfun', label: '阶跃星辰', displayName: 'StepFun', baseUrl: 'https://api.stepfun.com/v1', adapter: 'chat-completions', consoleUrl: 'https://platform.stepfun.com/console/api-keys', docsUrl: 'https://platform.stepfun.com' },
  { id: 'zai', label: 'Z.AI', displayName: 'ZAI', baseUrl: 'https://api.z.ai/api/paas/v4', adapter: 'chat-completions', consoleUrl: 'https://z.ai/manage-apikey/apikey-list', docsUrl: 'https://docs.z.ai/guides/overview/quick-start' },
  { id: 'kimi-coding', label: 'Kimi Code', displayName: 'Kimi_Code', baseUrl: 'https://api.kimi.com/coding/v1', adapter: 'responses', icon: 'kimi', providerPreset: 'kimi-coding-plan', codingPlan: true, consoleUrl: 'https://www.kimi.com/code/console', docsUrl: 'https://www.kimi.com/code/docs/' },
  { id: 'minimax-coding', label: 'MiniMax M Plan', displayName: 'MiniMax_M_Plan', baseUrl: 'https://api.minimax.io/v1', adapter: 'chat-completions', icon: 'minimax', providerPreset: 'minimax-coding-plan', codingPlan: true, consoleUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key', docsUrl: 'https://platform.minimax.io/docs/m-plan/intro' },
  { id: 'zai-coding', label: 'Z.AI Coding Plan', displayName: 'ZAI_Coding', baseUrl: 'https://api.z.ai/api/v1', adapter: 'responses', icon: 'zai', providerPreset: 'zai-coding-plan', codingPlan: true, consoleUrl: 'https://z.ai/manage-apikey/apikey-list', docsUrl: 'https://docs.z.ai/devpack/tool/others' },
  { id: 'ollama', label: 'Ollama', displayName: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', adapter: 'chat-completions', providerPreset: 'local-ollama', local: true, consoleUrl: 'https://ollama.com/download', docsUrl: 'https://docs.ollama.com/api/openai-compatibility' },
  { id: 'lmstudio', label: 'LM Studio', displayName: 'LM_Studio', baseUrl: 'http://127.0.0.1:1234/v1', adapter: 'responses', providerPreset: 'local-lmstudio', local: true, consoleUrl: 'https://lmstudio.ai/download', docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat' },
  { id: 'llamacpp', label: 'llama.cpp', displayName: 'llama_cpp', baseUrl: 'http://127.0.0.1:8080/v1', adapter: 'chat-completions', providerPreset: 'local-llamacpp', local: true, hidden: true, consoleUrl: 'https://github.com/ggml-org/llama.cpp/releases', docsUrl: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md' },
  { id: 'vllm', label: 'vLLM', displayName: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', adapter: 'chat-completions', providerPreset: 'local-vllm', local: true, hidden: true, consoleUrl: 'https://docs.vllm.ai/en/latest/getting_started/installation/', docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server/' },
  { id: 'localai', label: 'LocalAI', displayName: 'LocalAI', baseUrl: 'http://127.0.0.1:8080/v1', adapter: 'chat-completions', providerPreset: 'local-localai', local: true, hidden: true, consoleUrl: 'https://localai.io', docsUrl: 'https://localai.io/docs/reference/api/' }
] as const;

// Retired presets remain recognizable in saved connections without occupying the directory.
export const LISTED_OFFICIAL_PROVIDERS = OFFICIAL_PROVIDERS.filter(provider => !('hidden' in provider && provider.hidden));
export type OfficialProviderId = typeof OFFICIAL_PROVIDERS[number]['id'];
export const OFFICIAL_PROVIDER_WEBSITES = Object.fromEntries(OFFICIAL_PROVIDERS.map(provider => [provider.id, provider.consoleUrl])) as Readonly<Record<OfficialProviderId, string>>;

/** Exact endpoint metadata, never infer billing or protocol from a connection's name. */
export function officialProviderForUrl(baseUrl: string) {
  try {
    const normalized = new URL(baseUrl);
    return OFFICIAL_PROVIDERS.find(provider => {
      const preset = new URL(provider.baseUrl);
      return normalized.origin === preset.origin && normalized.pathname.replace(/\/+$/, '') === preset.pathname.replace(/\/+$/, '');
    });
  } catch { return undefined; }
}

export function isCodingPlanConnection(connection: { baseUrl: string; providerPreset?: string }): boolean {
  if (OFFICIAL_PROVIDERS.some(provider => 'codingPlan' in provider && 'providerPreset' in provider && provider.providerPreset === connection.providerPreset)) return true;
  const baseUrl = connection.baseUrl;
  const provider = officialProviderForUrl(baseUrl);
  return !!provider && 'codingPlan' in provider && provider.codingPlan;
}

export function isLocalProvider(connection: { baseUrl: string; providerPreset?: string }): boolean {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection.baseUrl).hostname); }
  catch { return false; }
}

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
