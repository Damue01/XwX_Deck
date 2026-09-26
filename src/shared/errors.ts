/** Keep Electron transport wrappers and exception stacks out of user feedback. */
export function normalizeErrorMessage(error: unknown): string {
  const raw = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : typeof error === 'string' ? error : '';
  let message = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
  let previous: string;
  do {
    previous = message;
    message = message
      .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/u, '')
      .replace(/^(?:Uncaught\s+)?(?:Error|TypeError|RangeError):\s*/u, '')
      .trim();
  } while (previous !== message);
  return message;
}

export function userErrorMessage(error: unknown, fallback = '操作失败。请重试；如果持续失败，可打开“诊断与修复”查看技术细节。'): string {
  const message = normalizeErrorMessage(error);
  if (/\b401\b|unauthorized|invalid[_ -]?api[_ -]?key|token_expired/i.test(message)) {
    return '服务拒绝了身份验证。请检查登录状态、服务地址和访问密钥后重试。';
  }
  if (/\b403\b|forbidden|permission denied|权限不足/i.test(message)) {
    return '服务拒绝了当前权限。请检查访问密钥、账号权限和服务地址后重试。';
  }
  if (/\b404\b|\b405\b|not found|method not allowed/i.test(message)) {
    return '服务没有提供这个接口。请检查 API 地址；如果只是模型目录检查失败，可以直接使用已知模型名。';
  }
  if (/\b429\b|rate.?limit|too many requests|限流|额度不足/i.test(message)) {
    return '请求过于频繁或服务额度不足。请稍后重试，并检查服务商额度。';
  }
  if (/invalid\s*(?:json|character)|json.*(?:parse|解析|格式)|unexpected token/i.test(message)) {
    return '服务返回了无法识别的数据格式。请检查 API 地址和服务兼容性；已保存的配置不会因此丢失。';
  }
  if (/HTTP\s*5\d\d|\b5\d\d\b|bad gateway|service unavailable|上游不可用/i.test(message)) {
    const status = message.match(/\b5\d\d\b/)?.[0];
    return `${status ? `HTTP ${status}：` : ''}上游服务暂时不可用。请稍后重试；本地已经保存的配置不会因此丢失。`;
  }
  if (/^(?:Failed to fetch|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN)$/i.test(message)) {
    if (/ECONNREFUSED/i.test(message)) return '无法连接到服务，服务可能尚未启动。请检查服务地址和网络代理后重试。';
    if (/ECONNRESET/i.test(message)) return '连接被服务端中断。请检查网络、代理和服务状态后重试。';
    return '网络连接失败，请检查网络、网络代理和服务地址后重试。';
  }
  if (/^(?:AbortError:\s*)?(?:This operation was aborted|The operation was aborted)|timed out|timeout|ETIMEDOUT/i.test(message)) {
    return '连接检查超时或已取消，请检查网络、代理和服务状态后重试。';
  }
  // Only display deliberate localized messages. Arbitrary upstream bodies and
  // English exceptions can contain credentials; full details belong in logs.
  if (!/[\u3400-\u9fff]/u.test(message)) return fallback;
  return message
    .replace(/https?:\/\/[^\s<>"'，。；）]+/giu, '[服务地址]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [已隐藏]')
    .replace(/\bsk-[\w-]+/gu, '[密钥已隐藏]')
    .replace(/\b(?:token|api[_-]?key|authorization)\s*[:=]\s*[^\s，。；]+/giu, '[凭据已隐藏]');
}
