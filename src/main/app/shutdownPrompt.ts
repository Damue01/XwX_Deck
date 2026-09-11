export interface TrayQuitRisk {
  readonly activeRequests: number;
  readonly pendingContinuations: number;
  readonly chatGptMayBeRunning: boolean;
  readonly claudeMayBeRunning: boolean;
}

export function buildTrayQuitPrompt(risk: TrayQuitRisk): Electron.MessageBoxOptions {
  const activeRequests = Math.max(0, Math.floor(risk.activeRequests));
  const pendingContinuations = Math.max(0, Math.floor(risk.pendingContinuations));
  let message = '退出会关闭后台代理。';
  let detail = '';

  if (activeRequests > 0 && pendingContinuations > 0) {
    message = `${activeRequests} 个请求进行中，${pendingContinuations} 个工具调用未完成。`;
    detail = '退出会中断回复，并可能丢失工具结果。';
  } else if (activeRequests > 0) {
    message = `${activeRequests} 个请求正在进行。`;
    detail = '退出会中断正在生成的回复。';
  } else if (pendingContinuations > 0) {
    message = `${pendingContinuations} 个工具调用尚未完成。`;
    detail = '退出可能丢失工具结果。';
  } else if (risk.chatGptMayBeRunning || risk.claudeMayBeRunning) {
    const clients = [
      risk.claudeMayBeRunning ? 'Claude' : '',
      risk.chatGptMayBeRunning ? 'ChatGPT' : ''
    ].filter(Boolean).join(' 和 ');
    message = `${clients} 正在使用后台代理。`;
    detail = '若对话无法继续，请重新打开 XwX Deck。';
  }

  return {
    type: 'warning',
    buttons: ['取消', '确认'],
    defaultId: 0,
    cancelId: 0,
    title: '退出 XwX Deck',
    message,
    detail
  };
}
