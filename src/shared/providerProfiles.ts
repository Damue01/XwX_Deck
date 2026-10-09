export type ProviderPresetId =
  | 'auto'
  | 'openai-compatible'
  | 'compatible'
  | 'volcengine-ark'
  | 'qwen-coding-plan'
  | 'zhipu-coding-plan'
  | 'kimi-coding-plan' | 'minimax-coding-plan' | 'zai-coding-plan'
  | 'local-ollama' | 'local-lmstudio' | 'local-llamacpp' | 'local-vllm' | 'local-localai'
  | 'custom';

export type ProviderModelCatalogMode = 'auto' | 'openai' | 'multi-protocol' | 'manual';

export interface ProviderProfile {
  readonly id: ProviderPresetId;
  readonly label: string;
  readonly defaultDisplayName: string;
  readonly defaultBaseUrl: string;
  readonly modelCatalogMode: ProviderModelCatalogMode;
  readonly supportsClaude: boolean;
  readonly imageGenerationPolicy: 'allow' | 'block';
  readonly description: string;
}

export const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  {
    id: 'auto',
    label: '自动识别',
    defaultDisplayName: '兼容服务',
    defaultBaseUrl: '',
    modelCatalogMode: 'auto',
    supportsClaude: false,
    imageGenerationPolicy: 'allow',
    description: '自动尝试标准 OpenAI 和多协议模型目录，并按模型元数据选择协议。'
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI 兼容',
    defaultDisplayName: '兼容服务',
    defaultBaseUrl: '',
    modelCatalogMode: 'openai',
    supportsClaude: false,
    imageGenerationPolicy: 'allow',
    description: '适用于提供 /models、/responses 或 /chat/completions 的 Bearer Token 中转服务。'
  },
  {
    id: 'compatible',
    label: '兼容服务 多协议',
    defaultDisplayName: '兼容服务',
    defaultBaseUrl: '',
    modelCatalogMode: 'multi-protocol',
    supportsClaude: true,
    imageGenerationPolicy: 'block',
    description: '同时探测 OpenAI、Anthropic 和 Gemini 目录，并支持 Claude Messages 路由。'
  },
  {
    id: 'volcengine-ark',
    label: '火山方舟',
    defaultDisplayName: '火山方舟',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelCatalogMode: 'auto',
    supportsClaude: false,
    imageGenerationPolicy: 'allow',
    description: '自动尝试方舟模型目录；若账户不公开目录，再降级为手动填写 Endpoint ID。'
  },
  {
    id: 'qwen-coding-plan', label: '百炼 Coding Plan', defaultDisplayName: 'Bailian_Coding',
    defaultBaseUrl: 'https://coding.dashscope.aliyuncs.com/v1', modelCatalogMode: 'auto', supportsClaude: true,
    imageGenerationPolicy: 'block', description: '编程套餐的独立地址与密钥，保存后由客户端新任务验证，不自动发送测试消息。'
  },
  {
    id: 'zhipu-coding-plan', label: '智谱 Coding Plan', defaultDisplayName: 'GLM_Coding',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/v1', modelCatalogMode: 'auto', supportsClaude: true,
    imageGenerationPolicy: 'block', description: '智谱编程套餐的 Codex Responses 入口，不混用普通按量 API。'
  },
  { id: 'kimi-coding-plan', label: 'Kimi Code', defaultDisplayName: 'Kimi_Code', defaultBaseUrl: 'https://api.kimi.com/coding/v1', modelCatalogMode: 'openai', supportsClaude: true, imageGenerationPolicy: 'block', description: '编程套餐的独立配置。' },
  { id: 'minimax-coding-plan', label: 'MiniMax M Plan', defaultDisplayName: 'MiniMax_M_Plan', defaultBaseUrl: 'https://api.minimax.io/v1', modelCatalogMode: 'openai', supportsClaude: true, imageGenerationPolicy: 'block', description: '编程套餐的独立配置。' },
  { id: 'zai-coding-plan', label: 'Z.AI Coding Plan', defaultDisplayName: 'ZAI_Coding', defaultBaseUrl: 'https://api.z.ai/api/v1', modelCatalogMode: 'openai', supportsClaude: true, imageGenerationPolicy: 'block', description: '编程套餐的独立配置。' },
  { id: 'local-ollama', label: 'Ollama', defaultDisplayName: 'Ollama', defaultBaseUrl: 'http://127.0.0.1:11434/v1', modelCatalogMode: 'openai', supportsClaude: true, imageGenerationPolicy: 'allow', description: '本机 OpenAI 兼容服务。' },
  { id: 'local-lmstudio', label: 'LM Studio', defaultDisplayName: 'LM_Studio', defaultBaseUrl: 'http://127.0.0.1:1234/v1', modelCatalogMode: 'openai', supportsClaude: true, imageGenerationPolicy: 'allow', description: '本机 OpenAI 兼容服务。' },
  { id: 'local-llamacpp', label: 'llama.cpp', defaultDisplayName: 'llama_cpp', defaultBaseUrl: 'http://127.0.0.1:8080/v1', modelCatalogMode: 'openai', supportsClaude: true, imageGenerationPolicy: 'allow', description: '本机 OpenAI 兼容服务。' },
  { id: 'local-vllm', label: 'vLLM', defaultDisplayName: 'vLLM', defaultBaseUrl: 'http://127.0.0.1:8000/v1', modelCatalogMode: 'openai', supportsClaude: true, imageGenerationPolicy: 'allow', description: '本机 OpenAI 兼容服务。' },
  { id: 'local-localai', label: 'LocalAI', defaultDisplayName: 'LocalAI', defaultBaseUrl: 'http://127.0.0.1:8080/v1', modelCatalogMode: 'openai', supportsClaude: true, imageGenerationPolicy: 'allow', description: '本机 OpenAI 兼容服务。' },
  {
    id: 'custom',
    label: '自定义',
    defaultDisplayName: '自定义服务',
    defaultBaseUrl: '',
    modelCatalogMode: 'openai',
    supportsClaude: false,
    imageGenerationPolicy: 'allow',
    description: '保留完整地址并按 OpenAI 兼容接口尝试模型目录。'
  }
];

export function providerProfile(value: unknown): ProviderProfile {
  return PROVIDER_PROFILES.find(profile => profile.id === value)
    ?? PROVIDER_PROFILES[0];
}

export function normalizeProviderPreset(value: unknown): ProviderPresetId {
  return providerProfile(value).id;
}

export function detectProviderPreset(baseUrl: string): ProviderPresetId {
  try {
    const url = new URL(baseUrl);
    if (
      /(?:^|\.)volces\.com$/i.test(url.hostname)
      && /\/api\/v3\/?$/i.test(url.pathname)
    ) {
      return 'volcengine-ark';
    }
  } catch {
    // Invalid URLs are rejected by the caller.
  }
  return 'auto';
}

export function providerBaseHasVersionRoot(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.replace(/\/+$/, '');
    return /\/v\d+(?:beta\d*)?$/i.test(pathname);
  } catch {
    return false;
  }
}
