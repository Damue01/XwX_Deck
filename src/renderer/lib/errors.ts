/** Convert Electron/JavaScript transport errors into text suitable for the UI. */
export function userErrorMessage(error: unknown, fallback = '操作失败，请稍后重试。'): string {
  const raw = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : typeof error === 'string'
      ? error
      : '';
  const message = raw
    .split(/\r?\n/, 1)[0]
    ?.trim()
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^(?:(?:Uncaught\s+)?(?:Error|TypeError|RangeError):\s*)+/u, '')
    .trim() ?? '';
  if (/^(?:Failed to fetch|fetch failed)$/iu.test(message)) {
    return '网络连接失败，请检查网络或代理后重试。';
  }
  if (/^(?:AbortError:\s*)?(?:This operation was aborted|The operation was aborted)$/iu.test(message)) {
    return '请求超时或已取消，请稍后重试。';
  }
  return message || fallback;
}

export function operationError(error: unknown, action: string): string {
  const detail = userErrorMessage(error, '');
  return detail ? `${action}：${detail}` : action;
}
