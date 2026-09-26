export interface TrayQuitRisk {
  readonly activeUserResponses: number;
  readonly pendingContinuations: number;
  readonly modelDependencies: readonly {
    readonly clientName: string;
    readonly model: string;
  }[];
  readonly inspectionFailed?: boolean;
}

export function shouldConfirmTrayQuit(risk: TrayQuitRisk): boolean {
  return risk.activeUserResponses > 0
    || risk.pendingContinuations > 0;
}

export function buildTrayQuitPrompt(risk: TrayQuitRisk): Electron.MessageBoxOptions {
  const activeUserResponses = Math.max(0, Math.floor(risk.activeUserResponses));
  const pendingContinuations = Math.max(0, Math.floor(risk.pendingContinuations));
  let message = '暂时无法确认是否可以安全退出。';
  let detail = '确认后仍会先恢复并校验客户端配置，再关闭后台代理。';

  if (activeUserResponses > 0 && pendingContinuations > 0) {
    message = `${activeUserResponses} 个回复正在生成，${pendingContinuations} 个会话等待工具调用。`;
    detail = '退出会中断回复，并可能丢失工具结果。';
  } else if (activeUserResponses > 0) {
    message = `${activeUserResponses} 个回复正在生成。`;
    detail = '退出会中断正在生成的回复。';
  } else if (pendingContinuations > 0) {
    message = `${pendingContinuations} 个会话正在等待工具调用。`;
    detail = '退出可能丢失尚未提交的工具结果。';
  } else if (risk.modelDependencies.length > 0) {
    const dependency = risk.modelDependencies[0];
    if (risk.modelDependencies.length === 1) {
      message = `当前 ${dependency.clientName} 模型需要 XwX Deck。`;
      detail = `${dependency.model} 需要 XwX Deck 转换协议。退出后该模型将暂时无法继续使用，建议取消退出并切换其他模型。`;
    } else {
      message = '当前模型需要 XwX Deck。';
      detail = '部分客户端当前使用的模型需要 XwX Deck 转换协议。退出后这些模型将暂时无法继续使用，建议取消退出并切换其他模型。';
    }
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
