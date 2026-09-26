import { normalizeErrorMessage, userErrorMessage } from './errors';

/** User-facing lifecycle guidance. Raw errors stay in the runtime log. */
export interface LifecycleNotice {
  readonly message: string;
  readonly description?: string;
  readonly type?: 'success' | 'error' | 'info';
  /** Only safety/blocking states should occupy the persistent top notice. */
  readonly persistent?: boolean;
  readonly action?: 'repair' | 'repair-settings' | 'repair-codex-config' | 'models' | 'start-trace' | 'stop-trace';
  readonly secondaryAction?: LifecycleNotice['action'];
  readonly secondaryActionLabel?: string;
  readonly actionLabel?: string;
}

export function isPersistentLifecycleNotice(notice: LifecycleNotice | undefined | null): boolean {
  return notice?.persistent === true;
}

function requiresPersistentNotice(reason: string): boolean {
  return /关闭未完成|恢复直连未完成|重试恢复直连|本次关闭.*取消/.test(reason)
    || /设置文件.*(?:解析|读取)|settings\.json.*(?:JSON|parse)/i.test(reason)
    || /(?:Trace\s*)?索引(?:不可用|损坏|缺失)|index\.json|trace index/i.test(reason)
    || /配置恢复冲突|配置仍指向.*(?:本地|停止)|恢复.*(?:冲突|失败)/.test(reason)
    || /本地转发服务已停止/.test(reason)
    || /ENOSPC|磁盘.*(?:空间|已满)|数据.*(?:丢失|未能保存)|记录.*(?:丢失|未能保存)|Trace.*(?:写入|记录).*(?:失败|不可用|停止)|写入租约|已有写入进程|第二个 Gateway helper|写入不完整|会话.*写入.*(?:不完整|未取得进展)/i.test(reason);
}

export function lifecycleFailure(error: unknown, operation: string): LifecycleNotice {
  const reason = normalizeErrorMessage(error);
  if (reason.startsWith('升级配置迁移未完成：')) {
    return { message: '升级配置迁移待重试', description: userErrorMessage(reason, '原设置已保留，请检查配置后重试。'),
      type: 'error', persistent: true, action: /ChatGPT 配置暂时无法读取/.test(reason) ? 'models' : 'repair' };
  }
  const startupRecovery = /^启动恢复未完成：/.test(reason)
    || /Gateway.*后台进程(?:提前退出|启动超时)/.test(reason);
  let description: string;
  let action: LifecycleNotice['action'];
  if (/本地转发服务已停止/.test(reason)) {
    description = '本地转发已停止，客户端可能仍连接旧端口。请重新开启 Trace，或恢复直连配置后重开客户端。';
    action = 'start-trace';
  } else if (/需要 Trace.*协议转换|开启 Trace 后/.test(reason)) {
    // The model page remembers the rejected choice, so opening Trace from this
    // notice completes it. Promising a manual re-selection would be wrong now.
    description = '所选模型需要 Trace 提供协议转换。开启 Trace 后会自动继续刚才的选择；也可以改用支持 Responses 直连的模型。';
    action = 'start-trace';
  } else if (/环境变量|environment.override/i.test(reason)) {
    description = '客户端正在使用环境变量中的连接，本地设置不会优先生效。请检查并移除或修正相关环境变量，再重新打开客户端和 Deck 后重试。';
  } else if (/系统代理|SOCKS/i.test(reason)) {
    description = '系统设置中的网络代理不可用或暂不受支持。请检查网络代理软件是否运行及其设置，再重试；重新开启 Trace 无法修复网络代理。';
  } else if (/设置文件.*(?:解析|读取)|settings\.json.*(?:JSON|parse)|禁止覆盖原文件/i.test(reason)) {
    description = 'XwX Deck 设置无法读取。修复会先备份原文件，再尽量保留可读取的设置；仍可继续使用不依赖这些设置的功能。';
    action = 'repair-settings';
  } else if (/ChatGPT config\.toml 格式错误|ChatGPT.*TOML.*(?:错误|解析)/i.test(reason)) {
    description = 'ChatGPT 配置格式错误。修复会先备份原文件，再按模型页已保存的选择重建最小可用配置。';
    action = 'repair-codex-config';
  } else if (/客户端配置恢复未完成/.test(reason)) {
    description = 'Trace 已停止，但客户端直连配置还没有全部恢复。原文件未删除；再次点“恢复直连”会重试，正在使用本地代理的客户端请随后重新打开。';
    action = 'stop-trace';
  } else if (/索引|index\.json|trace index/i.test(reason)) {
    description = 'Trace 记录索引无法读取，记录可能未开启。请保留 Trace 数据并联系维护者修复索引；不要清空记录或完全重置。';
  } else if (/ENOSPC|磁盘.*(?:空间|已满)/i.test(reason)) {
    description = '磁盘空间不足，配置或记录可能未能保存。请释放数据目录所在磁盘的空间，再重试。';
  } else if (/EACCES|EPERM|EBUSY|权限|写入失败|配置写入|无法写入/i.test(reason)) {
    description = '文件无法写入，配置可能尚未更新。请检查文件权限或占用，关闭正在修改配置的软件后重试；仍失败时查看运行日志。';
  } else if (/外部.*修改|其他软件修改|配置仍指向|恢复冲突|配置.*(?:恢复|还原).*失败|配置文件已被外部删除/i.test(reason)) {
    description = /其他软件修改|写入前被.*修改/i.test(reason)
      ? '客户端配置已被其他软件修改。本次未覆盖新内容；修复会备份当前文件，并按模型页已保存的选择恢复可用配置。'
      : '客户端配置未能完整恢复。请检查当前服务设置并重新选择服务。';
    action = /ChatGPT.*(?:其他软件修改|写入前被.*修改)/i.test(reason) ? 'repair-codex-config'
      : /其他软件修改|写入前被.*修改/i.test(reason) ? 'repair' : 'models';
  } else if (/token_expired|authentication token is expired|provided authentication token is expired/i.test(reason)) {
    description = 'ChatGPT / Codex 的官方登录令牌已过期。请在对应客户端重新登录后再发送请求；登录过期只影响上游认证，不应阻止停止 Trace 或退出 XwX Deck。';
  } else if (/401|403|认证|鉴权|密钥.*(?:无效|缺少)|缺少.*密钥/i.test(reason)) {
    description = '服务拒绝认证或连接信息不完整。官方服务请检查登录状态；第三方服务请检查地址、密钥和访问权限，再重试。';
    action = 'models';
  } else if (/429|rate.?limit|限流|额度不足/i.test(reason)) {
    description = '服务限制了请求或可用额度。请稍后重试，并到对应服务商检查额度与限制；重启 Trace 通常无法解决。';
  } else if (/Gateway.*(?:请求仍在传输|等待工具调用)|等待.*请求.*升级/i.test(reason)) {
    description = '这是旧版 Gateway 的阻塞式切换提示。当前版本的服务切换不会等待正在生成的回复；若升级后仍看到此提示，请重新打开 Deck 并查看运行日志。';
  } else if (/Gateway.*(?:后台版本切换|升级尚未完成)/i.test(reason)) {
    description = '后台组件正在完成版本切换，当前服务没有改变。应用会自动重试；稍候再切换，若持续出现请打开运行日志。';
  } else if (/状态不确定|cannot confirm|uncertain|控制.*(?:失败|超时|不可用)|control.*(?:failed|timeout|timed out)/i.test(reason)) {
    description = '暂时无法确认后台连接状态，不能据此判断服务已停止。请稍后重试；若对话也连接失败，重新打开 Deck，再重启相应客户端。';
  } else if (/EADDRINUSE|端口.*占用|lease|租约|已有写入进程|另一个.*(?:进程|实例)|another.*(?:writer|helper)/i.test(reason)) {
    description = '本地服务资源被其他实例占用。请退出重复运行的 Deck 或 Trace 实例后重试；不要结束无法确认来源的进程。';
  } else if (/Gateway|helper|路由尚未|本地代理尚未|loopback-residue|连接方式无法与 Trace/i.test(reason)) {
    description = '本地转发尚未就绪或存在旧连接冲突。请重新打开 Deck 并开启所需功能；若客户端仍连接失败，再完全退出并重新打开客户端。';
  } else if (/上游不可用|HTTP 5\d\d|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out|timeout|fetch failed|Failed to fetch|网络|超时|连通性检查失败/i.test(reason)) {
    description = '连接检查失败，可能是网络、网络代理或服务商暂时不可用。请检查网络与服务地址后重试；仅凭连接失败无法确认是哪一端故障。';
  } else if (/缺少.*(?:地址|base_url)|尚未缓存|请先.*(?:地址|密钥)|没有可供|不支持.*(?:模型|服务)|无法验证.*模型/i.test(reason)) {
    description = '当前模型服务或模型配置不完整或不兼容。请到“模型”和“设置 → 模型服务”检查所选服务及模型，再重试。';
  } else {
    const safeReason = userErrorMessage(reason, '').replace(/[。；;，,\s]+$/u, '');
    description = safeReason
      ? `操作未完成：${safeReason}。请按提示检查后重试；完整技术信息已写入运行日志。`
      : '操作未完成，但返回的信息不足以安全展示具体原因。请查看“诊断与修复”中的运行日志；不要仅凭此提示清空数据。';
  }
  // Preserve concrete, localized backend reasons (for example HTTP 502 or a
  // restoration conflict) when they already explain how to proceed.
  const concrete = userErrorMessage(reason, '');
  if (/[\u3400-\u9fff]/u.test(reason) && concrete && /请|建议/.test(concrete)) description = concrete;
  if (/原服务配置|HTTP\s*5\d\d.*原配置/.test(reason)) {
    description += ' 已保留原服务配置。';
  } else if (/原配置未更改|已保留原.*配置|配置未切换到本地代理/.test(reason)) {
    description += ' 本次检查保留了原客户端配置。';
  }
  const recoveryOnly = /客户端配置恢复未完成/.test(reason);
  const stopping = /关闭未完成|恢复直连未完成|重试恢复直连|本次关闭.*取消/.test(reason)
    && action !== 'repair-settings' && action !== 'repair-codex-config';
  if (recoveryOnly) action = 'stop-trace';
  if (stopping) action = 'stop-trace';
  if (/后台清理未完成/.test(reason)) action = 'stop-trace';
  const retryStartup = startupRecovery && !action;
  if (retryStartup) action = 'start-trace';
  return { message: recoveryOnly ? 'Trace 已关闭，但直连恢复未完成' : stopping ? 'Trace 关闭未完成' : `${operation}${/[a-z]$/i.test(operation) ? ' ' : ''}失败`, description, type: 'error',
    persistent: startupRecovery || requiresPersistentNotice(reason),
    action,
    actionLabel: recoveryOnly || stopping ? '恢复直连' : retryStartup ? '重试 Trace' : action === 'repair-settings' || action === 'repair-codex-config' || action === 'repair' ? '修复' : undefined,
    secondaryAction: /本地转发服务已停止/.test(reason) ? 'stop-trace'
      : action === 'start-trace' ? 'models' : action === 'stop-trace' ? 'repair' : undefined,
    secondaryActionLabel: /本地转发服务已停止/.test(reason) ? '恢复直连配置' : undefined };
}

export function traceStoppedNotice(forwarding = false): LifecycleNotice {
  return {
    message: forwarding ? 'Trace 关闭未完成' : 'Trace 已关闭',
    description: forwarding
      ? '后台仍在运行。请检查恢复结果后重试关闭。'
      : 'Trace 记录已停止，客户端配置已恢复直连或继续使用无记录模型路由。已保存的记录仍可查看。',
    type: forwarding ? 'error' : 'success',
    persistent: forwarding,
    action: forwarding ? 'stop-trace' : undefined
  };
}
