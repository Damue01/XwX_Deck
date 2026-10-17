import { normalizeErrorMessage, userErrorMessage } from './errors';

/** Convert catalog failures into a short explanation a user can act on. */
export function modelCatalogFailureMessage(error: unknown): string {
  const reason = normalizeErrorMessage(error);
  if (/写入前被.*修改|其他软件修改|外部修改/i.test(reason)) {
    return 'ChatGPT 配置在写入前被其他软件修改。XwX Deck 未覆盖新内容，可重新读取并重试。';
  }
  if (/config\.toml.*格式错误|TOML.*(?:错误|解析)/i.test(reason)) {
    return 'ChatGPT 配置格式错误。可先备份原文件，再根据已保存的模型选择修复。';
  }
  if (/404|405|未公开.*(?:目录|模型)|没有.*(?:目录|模型)/i.test(reason)) {
    return '该模型服务未公开模型目录。服务选择仍已保存，可以直接输入已知模型名。';
  }
  if (/401|403|认证|鉴权|密钥|unauthorized|forbidden/i.test(reason)) {
    return '模型目录需要有效的地址、密钥或权限。请检查后重试；服务选择仍已保存。';
  }
  if (/429|rate.?limit|限流|额度不足/i.test(reason)) {
    return '模型目录请求被限流或额度不足。请稍后重试；服务选择仍已保存。';
  }
  if (/invalid\s*(?:json|character)|json.*(?:parse|解析|格式)|无法解析.*json|无效.*json/i.test(reason)) {
    return '模型服务返回了无法识别的 JSON。请检查 API 地址和服务兼容性；服务选择仍已保存。';
  }
  if (/HTTP\s*5\d\d|\b5\d\d\b|上游不可用|服务器错误/i.test(reason)) {
    return '模型服务暂时不可用（上游 HTTP 5xx）。请稍后重试；服务选择仍已保存。';
  }
  if (/网络|超时|timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|Failed to fetch/i.test(reason)) {
    return '模型目录暂时无法访问。请检查网络、代理和服务地址；服务选择仍已保存。';
  }
  return userErrorMessage(
    error,
    '模型目录刷新失败。请检查模型服务地址、访问密钥或网络后重试；服务选择仍已保存。'
  );
}
