export type ProviderPresetId =
  | 'auto'
  | 'openai-compatible'
  | 'compatible'
  | 'volcengine-ark'
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
