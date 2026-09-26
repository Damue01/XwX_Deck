import { userErrorMessage } from './errors';

/** Explain a failed update request without mistaking it for "already up to date". */
export function updateFailureDescription(error: unknown): string {
  const reason = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const httpStatus = reason.match(/\b(?:HTTP|HttpError:)\s+([1-5]\d\d)\b/i)?.[1];
  if (httpStatus) {
    return `更新服务器返回 HTTP ${httpStatus}，未能确认是否有新版本。请稍后重试或检查更新服务。`;
  }
  if (/ECONNREFUSED|ECONNRESET|ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|socket hang up/i.test(reason)) {
    return '无法连接更新服务器；服务器可能未启动，也可能是网络或代理中断。请检查后重试。';
  }
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/i.test(reason)) {
    return '无法找到更新服务器或当前网络不可用，未能确认是否有新版本。请检查网络与代理后重试。';
  }
  if (/ETIMEDOUT|ERR_TIMED_OUT|timed out|timeout|AbortError/i.test(reason)) {
    return '连接更新服务器超时，未能确认是否有新版本。请检查网络或稍后重试。';
  }
  return userErrorMessage(error, '更新请求未完成，请检查更新服务器、网络或代理后重试。');
}
