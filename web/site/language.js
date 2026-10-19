/* Landing-page copy stays separate from product settings and example data. */
(() => {
  const messages = {
    title: ['XwX Deck：好工具，更简单', 'XwX Deck: Good tools, made simple'],
    description: ['为 Claude、ChatGPT 等客户端管理模型服务，在本机查看请求、响应与用量。', 'Manage model services for Claude, ChatGPT and other clients. Inspect requests, responses and usage locally.'],
    skip: ['跳到正文', 'Skip to content'],
    navigation: ['主导航', 'Main navigation'],
    docs: ['文档', 'Docs'],
    language: ['选择语言', 'Choose language'],
    heroStart: ['好工具，', 'Good tools, '],
    heroEnd: ['更简单', 'made simple'],
    chooseDownload: ['选择下载版本', 'Choose a download'],
    downloadMac: ['下载 Mac 版', 'Download for Mac'],
    downloadWindows: ['下载 Windows 版', 'Download for Windows'],
    otherVersions: ['其他版本', 'Other versions'],
    chipHelp: ['如何查看 Mac 芯片', 'Find your Mac chip'],
    chipDescription: ['打开苹果菜单 → 关于本机。Apple M 系列请选择 Apple Silicon；Intel 处理器请选择 Intel。', 'Open the Apple menu → About This Mac. Choose Apple Silicon for Apple M-series chips, or Intel for Intel processors.'],
    releases: ['历史版本', 'All releases'],
    missingDownload: ['当前未配置下载地址，请查看已发布版本。', 'No download is configured. Please check the published releases.'],
    windowsArm: ['当前提供 Windows x64 下载，尚无原生 ARM64 版。', 'Windows x64 is available. A native ARM64 version is not available yet.'],
    featuresTitle: ['配置与请求，一目了然', 'Your setup and requests, at a glance'],
    features: ['功能', 'Features'],
    models: ['切换模型服务', 'Switch models'],
    settings: ['集中管理服务', 'Manage services'],
    signal: ['查看 Trace', 'Explore Trace'],
    dashboard: ['查看仪表盘', 'View dashboard'],
    modelsCopy: ['为客户端选择服务和模型，相关配置会自动写入。', 'Choose a service and model for your client. Deck writes the configuration for you.'],
    settingsCopy: ['统一管理服务地址与访问密钥。支持从 CC Switch、Magpie 导入配置，来源文件保持不变。', 'Manage service URLs and API keys in one place. Import configurations from CC Switch or Magpie while preserving the source files.'],
    signalCopy: ['按需开启请求追踪（Trace），在本机记录已接入客户端的模型请求与响应。', 'Enable Trace when you need it to record connected clients’ model requests and responses locally.'],
    dashboardCopy: ['查看脱敏的真实对话，了解各次请求的上下文、工具调用和用量。', 'Explore a real conversation with private information removed, including context, tool calls and usage for each request.'],
    appPreview: ['XwX Deck 功能演示', 'XwX Deck interactive preview'],
    dashboardPreview: ['XwX Deck 仪表盘真实对话', 'XwX Deck dashboard: a real conversation'],
    loading: ['正在加载交互预览', 'Loading interactive preview'],
    safetyTitle: ['模型与数据，由您掌握', 'Your models. Your data. Your control.'],
    localTitle: ['本地处理', 'Processed locally'],
    localCopy: ['配置和日志保存在本机，上下文适配也在本机完成。模型请求直接发往您选择的服务商。XwX Deck 不设云端中转，不修改系统代理。', 'Configurations, logs and context adaptation stay on your machine. Model requests go directly to your chosen provider. XwX Deck uses no cloud relay and leaves your system proxy unchanged.'],
    switchingTitle: ['切换服务，继续对话', 'Switch services, keep talking'],
    switchingCopy: ['您可以按需切换模型服务。本地网关会适配协议与兼容的上下文，方便您继续当前对话。', 'Switch model services as needed. The local gateway adapts protocols and compatible context so you can continue your conversation.'],
    traceTitle: ['查看请求详情', 'Inspect every request'],
    traceCopy: ['开启请求追踪（Trace）后，仪表盘会记录已接入客户端的模型请求和响应。展开请求，即可查看上下文、工具调用和用量。', 'Enable Trace to record connected clients’ model requests and responses. Expand a request in the dashboard to inspect context, tool calls and usage.'],
    updatesTitle: ['自动更新模型资料', 'Up-to-date model information'],
    updatesCopy: ['模型价格、上下文容量等资料会自动刷新。应用启动时检查更新，运行期间每 6 小时检查一次公开资料源。历史请求保留当时的参考费用。', 'Model prices and context limits refresh automatically. Deck checks for updates at startup and checks public data sources every 6 hours while running. Past requests retain their original reference costs.'],
    supportTitle: ['当前适配', 'Works with your tools'],
    clients: ['客户端', 'Clients'],
    services: ['模型服务', 'Model services'],
    qwen: ['千问', 'Qwen'],
    ark: ['火山方舟', 'Volcengine Ark'],
    zhipu: ['智谱 GLM', 'Zhipu GLM'],
    tencent: ['腾讯 TokenHub', 'Tencent TokenHub'],
    siliconflow: ['硅基流动', 'SiliconFlow'],
    stepfun: ['阶跃星辰', 'StepFun'],
    openaiCompatible: ['OpenAI 兼容接口', 'OpenAI-compatible APIs'],
    anthropicCompatible: ['Anthropic 兼容接口', 'Anthropic-compatible APIs'],
    customServices: ['自定义服务', 'Custom services'],
    communityTitle: ['您的建议，让 Deck 更好用', 'Your ideas make Deck better'],
    communityCopy: ['感谢您的使用', 'Thanks for using Deck'],
    qq: ['QQ 群聊', 'QQ group'],
  };
  const storageKey = 'xwx-deck.site.language';
  const supported = value => value === 'zh-CN' || value === 'en';
  let language = 'zh-CN';
  for (const locale of navigator.languages || [navigator.language]) {
    if (/^zh\b/i.test(locale)) { language = 'zh-CN'; break; }
    if (/^en\b/i.test(locale)) { language = 'en'; break; }
  }
  try {
    const saved = localStorage.getItem(storageKey);
    if (supported(saved)) language = saved;
  } catch { /* Switching remains usable when storage is unavailable. */ }
  const text = key => messages[key]?.[language === 'en' ? 1 : 0] ?? key;
  function apply(next) {
    if (!supported(next)) return;
    language = next;
    document.documentElement.lang = next;
    document.title = text('title');
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = text(node.dataset.i18n);
    for (const attribute of ['aria-label', 'title', 'content', 'data-copy']) {
      for (const node of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        node.setAttribute(attribute, text(node.getAttribute(`data-i18n-${attribute}`)));
      }
    }
    for (const option of document.querySelectorAll('[data-language]')) {
      option.setAttribute('aria-checked', String(option.dataset.language === next));
    }
    dispatchEvent(new CustomEvent('site-language', { detail: next }));
  }
  window.siteLanguage = { text, get current() { return language; } };
  apply(language);

  const picker = document.querySelector('.language-picker');
  const trigger = document.getElementById('language-trigger');
  const menu = document.getElementById('language-menu');
  const options = [...menu.querySelectorAll('[data-language]')];
  picker.hidden = false;
  function close(restoreFocus = false) {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  function open(index = options.findIndex(option => option.dataset.language === language)) {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    options[index].focus({ preventScroll: true });
  }
  trigger.addEventListener('click', () => menu.hidden ? open() : close());
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      open(event.key === 'ArrowDown' ? 0 : options.length - 1);
    }
  });
  options.forEach(option => option.addEventListener('click', () => {
    try { localStorage.setItem(storageKey, option.dataset.language); } catch { /* Keep the current choice in memory. */ }
    apply(option.dataset.language);
    close(true);
  }));
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); close(true); }
    if (menu.hidden || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next].focus({ preventScroll: true });
  });
  document.addEventListener('pointerdown', event => { if (!picker.contains(event.target)) close(); });
  picker.addEventListener('focusout', event => { if (!picker.contains(event.relatedTarget)) close(); });
})();
