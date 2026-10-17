(() => {
  'use strict';
  const storageKey = 'xwx-deck-hero-preview-v2';
  const originalFonts = {
    original: '"Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif',
    system: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei UI", sans-serif',
    humanist: '"Avenir Next", Avenir, "PingFang SC", "Microsoft YaHei UI", sans-serif',
  };
  const baseGroups = {
    hero: { weight: 500, scale: 100, tracking: -.035, leading: 1.24 },
    section: { weight: 660, scale: 100, tracking: -.035, leading: 1.3 },
    body: { weight: 400, scale: 100, tracking: 0, leading: 1.7 },
    control: { weight: 400, scale: 100, tracking: 0, leading: 1.4 },
  };
  const newType = () => ({ mode: 'custom', latin: 'urbanist', chinese: 'noto', groups: {
    hero: { ...baseGroups.hero, weight: 300 }, section: { ...baseGroups.section, weight: 300 },
    body: { ...baseGroups.body, weight: 300 }, control: { ...baseGroups.control, weight: 400 },
  } });
  const defaults = { style: 'solid', height: 38, font: 'system', weight: 500, field: 'standard', motion: 'flow', footer: 'center' };
  const intensities = { soft: .28, standard: .44, strong: .65 };
  const bounds = { weight: [100, 900], scale: [75, 140], tracking: [-.08, .12], leading: [1, 2.2] };
  let confirmedVersion;
  try { confirmedVersion = JSON.parse(document.getElementById('confirmed-design')?.textContent); } catch { /* No bundled preset. */ }
  let settings = confirmedVersion ? structuredClone(confirmedVersion.settings) : { ...defaults, typography: newType() };
  let target = 'hero';
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    for (const [key, values] of Object.entries({ style: ['solid', 'outline'], height: [34, 38, 42], font: Object.keys(originalFonts), weight: [400, 500, 600], field: Object.keys(intensities), motion: ['flow', 'still', 'off'], footer: ['original', 'center', 'compact'] })) {
      if (values.includes(saved?.[key])) settings[key] = saved[key];
    }
    const savedType = saved?.typography;
    for (const [key, values] of Object.entries({ mode: ['original', 'custom'], latin: ['original', 'urbanist'], chinese: ['original', 'noto'] })) {
      if (values.includes(savedType?.[key])) settings.typography[key] = savedType[key];
    }
    for (const group of Object.keys(baseGroups)) for (const [key, [min, max]] of Object.entries(bounds)) {
      const value = savedType?.groups?.[group]?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) settings.typography.groups[group][key] = value;
    }
  } catch { /* Controls also work without storage. */ }
  const versionsKey = 'xwx-deck-design-versions-v1';
  let versions = [];
  try { versions = JSON.parse(localStorage.getItem(versionsKey)) || []; } catch { /* Optional storage. */ }
  if (!Array.isArray(versions)) versions = [];
  const initialVersionId = 'confirmed-2026-10-17';
  if (!versions.some(version => version.id === initialVersionId)) {
    versions.unshift(confirmedVersion || { id: initialVersionId, name: '已确认字体 2026-10-17', createdAt: new Date().toISOString(), settings: structuredClone(settings) });
    try { localStorage.setItem(versionsKey, JSON.stringify(versions)); } catch { /* Export still works. */ }
  }
  const softwareKey = 'xwx-deck-app-typography-preview-v1';
  let softwareMode = 'balanced';
  try { if (localStorage.getItem(softwareKey) === 'original') softwareMode = 'original'; } catch { /* Optional storage. */ }
  const tools = document.createElement('details');
  tools.className = 'preview-tools';
  tools.innerHTML = `<summary aria-label="预览设置">预览设置</summary>
    <div class="preview-panel">
      <div class="preview-panel-head"><h2>字体与版式</h2><button type="button" id="preview-close" aria-label="关闭预览设置">关闭</button></div>
      <div class="font-compare" role="group" aria-label="字体版本"><button type="button" data-font-mode="original">原版字体</button><button type="button" data-font-mode="custom">新字体 / 调整版</button></div>
      <p class="preview-hint">切换版本会保留调整值。以下参数调整官网文字。</p>
      <div class="font-family-controls"><label for="latin-font">英文字体<select id="latin-font"><option value="urbanist">Urbanist</option><option value="original">原版字体</option></select></label>
      <label for="chinese-font">中文字体<select id="chinese-font"><option value="noto">Noto Sans SC</option><option value="original">原版字体</option></select></label></div>
      <p class="preview-hint font-status" role="status" aria-live="polite"></p>
      <label for="type-target">调整范围<select id="type-target"><option value="hero">首屏标题</option><option value="section">章节标题</option><option value="body">正文说明</option><option value="control">按钮与导航</option></select></label>
      <div class="type-adjustments">
        ${[['weight', '字重', 100, 900, 100, ''], ['scale', '字号比例', 75, 140, 1, '%'], ['tracking', '字距', -.08, .12, .005, 'em'], ['leading', '行高', 1, 2.2, .02, '倍']].map(([key, label, min, max, step, unit]) => `<div class="type-setting"><label for="type-${key}">${label}<span>${unit}</span></label><div><input id="type-${key}" data-type-key="${key}" type="range" min="${min}" max="${max}" step="${step}"><input aria-label="${label}数值" data-type-number="${key}" type="number" min="${min}" max="${max}" step="${step}"></div></div>`).join('')}
      </div>
      <button type="button" id="reset-type" class="preview-text-action">恢复新字体初值</button>
      <details class="preview-group"><summary>保存的版本</summary>
        <label for="design-version">选择版本<select id="design-version"></select></label>
        <div class="version-actions"><button type="button" id="restore-version">恢复此版本</button><button type="button" id="save-version">另存当前版本</button></div>
        <p class="preview-hint version-status" role="status" aria-live="polite"></p>
        <details><summary class="preview-text-action">查看配置 JSON</summary><textarea id="version-json" aria-label="保存的配置 JSON" readonly spellcheck="false"></textarea><a id="export-version" download="xwx-deck-design.json" class="preview-text-action">导出配置</a></details>
      </details>
      <details class="preview-group" open><summary>软件字体预览</summary>
        <div class="font-compare" role="group" aria-label="软件字体版本"><button type="button" data-software-mode="original">原版字体</button><button type="button" data-software-mode="balanced">新字体 / 平衡版</button></div>
        <p class="preview-hint">正文 400，控件 500，标题 550。代码与数据保留等宽字体。仅影响本地演示。</p>
        <a href="design-lab-app.html?trace-live=1#models" target="_blank" rel="noopener" class="preview-text-action">单独查看软件预览</a>
      </details>
      <details class="preview-group"><summary>尾页布局</summary><label for="footer-layout">布局与文案<select id="footer-layout"><option value="center">方案 2：居中文字链接</option><option value="compact">方案 3：紧凑分栏</option><option value="original">原版按钮布局</option></select></label><a class="preview-text-action" href="#community">查看尾页</a></details>
      <details class="preview-group"><summary>点阵与下载按钮</summary>
        <label for="hero-field-tone">点阵浓度<select id="hero-field-tone"><option value="soft">柔和</option><option value="standard">标准</option><option value="strong">明显</option></select></label>
        <label for="hero-motion">点阵动态<select id="hero-motion"><option value="flow">缓慢流动</option><option value="still">静止</option><option value="off">关闭</option></select></label>
        <label for="download-style">按钮样式<select id="download-style"><option value="solid">实心</option><option value="outline">描边</option></select></label>
        <label for="download-height">按钮高度<select id="download-height"><option value="34">34 px</option><option value="38">38 px</option><option value="42">42 px</option></select></label>
      </details>
    </div>`;
  document.body.append(tools);
  tools.open = new URLSearchParams(location.search).get('panel') === 'fonts';
  const invitation = document.createElement('p');
  invitation.className = 'community-copy';
  invitation.textContent = '感谢您的使用';
  document.querySelector('.community .title').append(invitation);
  const communityTitle = document.getElementById('community-title');
  const communityLinks = [...document.querySelectorAll('.community-link span')];
  const originalLabels = communityLinks.map(link => link.textContent);
  const originalTitle = communityTitle.textContent;
  const controls = { style: '#download-style', height: '#download-height', field: '#hero-field-tone', motion: '#hero-motion', footer: '#footer-layout' };
  let versionUrl;
  function syncVersions(selectedId) {
    const select = tools.querySelector('#design-version');
    select.replaceChildren(...versions.map(version => new Option(version.name, version.id)));
    if (selectedId) select.value = selectedId;
    showVersion();
  }
  function showVersion() {
    const version = versions.find(item => item.id === tools.querySelector('#design-version').value);
    const json = JSON.stringify(version, null, 2);
    tools.querySelector('#version-json').value = json;
    if (versionUrl) URL.revokeObjectURL(versionUrl);
    versionUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    tools.querySelector('#export-version').href = versionUrl;
  }
  tools.querySelector('#design-version').addEventListener('change', showVersion);
  tools.querySelector('#save-version').addEventListener('click', () => {
    const stamp = new Date();
    const version = { id: `saved-${stamp.getTime()}`, name: `调整版 ${stamp.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`, createdAt: stamp.toISOString(), settings: structuredClone(settings) };
    versions.unshift(version);
    try { localStorage.setItem(versionsKey, JSON.stringify(versions)); tools.querySelector('.version-status').textContent = '已保存，可随时恢复或导出。'; }
    catch { tools.querySelector('.version-status').textContent = '浏览器无法保存，请导出配置以保留此版本。'; }
    syncVersions(version.id);
  });
  tools.querySelector('#restore-version').addEventListener('click', () => {
    const version = versions.find(item => item.id === tools.querySelector('#design-version').value);
    if (!version) return;
    settings = structuredClone(version.settings); apply();
    tools.querySelector('.version-status').textContent = `已恢复：${version.name}`;
  });
  syncVersions(initialVersionId);
  function applySoftware(persist = true) {
    tools.querySelectorAll('[data-software-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.softwareMode === softwareMode)));
    for (const frame of document.querySelectorAll('#app-demo, #dashboard-demo')) frame.contentWindow?.postMessage({ deckTypography: softwareMode }, location.origin);
    if (persist) try { localStorage.setItem(softwareKey, softwareMode); } catch { /* Preview still works. */ }
  }
  tools.querySelectorAll('[data-software-mode]').forEach(button => button.addEventListener('click', () => { softwareMode = button.dataset.softwareMode; applySoftware(); }));
  for (const frame of document.querySelectorAll('#app-demo, #dashboard-demo')) frame.addEventListener('load', () => applySoftware(false));
  addEventListener('storage', event => { if (event.key === softwareKey && ['balanced', 'original'].includes(event.newValue)) { softwareMode = event.newValue; applySoftware(false); } });
  applySoftware();
  let fontLoadVersion = 0;
  let fontLoadKey;
  function updateFontStatus() {
    const type = settings.typography;
    const key = [type.mode, type.latin, type.chinese].join(':');
    if (key === fontLoadKey) return;
    fontLoadKey = key;
    const version = ++fontLoadVersion;
    const status = tools.querySelector('.font-status');
    if (type.mode === 'original') { status.textContent = '正在对比原版字体。'; return; }
    const faces = [];
    if (type.latin === 'urbanist') faces.push(document.fonts.load('300 16px "Urbanist"', 'XwX Deck'));
    if (type.chinese === 'noto') faces.push(document.fonts.load('300 16px "Noto Sans SC"', '您的建议，很高兴与您交流'));
    status.textContent = faces.length ? '正在加载本地字体…' : '当前使用原版字体。';
    Promise.all(faces).then(loaded => {
      if (version !== fontLoadVersion) return;
      status.textContent = loaded.length ? (loaded.every(rows => rows.length) ? '所选字体已从本地加载。' : '字体未加载，请刷新重试。') : '当前使用原版字体。';
    }).catch(() => { if (version === fontLoadVersion) status.textContent = '字体加载失败，当前显示备用字体。'; });
  }
  function syncTypeControls() {
    const values = settings.typography.groups[target];
    tools.querySelector('#type-target').value = target;
    for (const key of Object.keys(bounds)) {
      tools.querySelector(`[data-type-key="${key}"]`).value = values[key];
      tools.querySelector(`[data-type-number="${key}"]`).value = values[key];
    }
  }
  function apply(persist = true) {
    const type = settings.typography;
    const original = type.mode === 'original';
    const stack = [type.latin === 'urbanist' ? '"Urbanist"' : '"Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI"', type.chinese === 'noto' ? '"Noto Sans SC"' : '"PingFang SC", "Microsoft YaHei UI"', 'system-ui, sans-serif'].join(', ');
    const root = document.documentElement.style;
    root.setProperty('--sans', original ? originalFonts.original : stack);
    root.setProperty('--hero-font', original ? originalFonts[settings.font] : stack);
    for (const [name, group] of Object.entries(original ? { ...baseGroups, hero: { ...baseGroups.hero, weight: settings.weight } } : type.groups)) {
      root.setProperty(`--${name}-weight`, group.weight);
      root.setProperty(`--${name}-scale`, group.scale / 100);
      root.setProperty(`--${name}-tracking`, `${group.tracking}em`);
      root.setProperty(`--${name}-leading`, group.leading);
    }
    document.body.dataset.fontMode = type.mode;
    document.body.dataset.downloadStyle = settings.style;
    document.body.dataset.fieldMotion = settings.motion;
    document.body.dataset.footerLayout = settings.footer;
    root.setProperty('--download-height', `${settings.height}px`);
    root.setProperty('--field-opacity', intensities[settings.field]);
    communityTitle.textContent = settings.footer === 'original' ? originalTitle : settings.footer === 'center' ? '您的建议，让 Deck 更好用' : '很高兴与您交流';
    communityLinks.forEach((link, index) => { link.textContent = settings.footer === 'original' ? originalLabels[index] : ['GitHub', 'QQ 群聊', 'Discord'][index]; });
    for (const [key, selector] of Object.entries(controls)) tools.querySelector(selector).value = settings[key];
    tools.querySelector('#latin-font').value = type.latin;
    tools.querySelector('#chinese-font').value = type.chinese;
    tools.querySelectorAll('[data-font-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fontMode === type.mode)));
    syncTypeControls(); updateFontStatus();
    document.dispatchEvent(new Event('preview:field'));
    if (persist) try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Controls also work without storage. */ }
  }
  for (const [key, selector] of Object.entries(controls)) tools.querySelector(selector).addEventListener('change', event => {
    settings[key] = key === 'height' ? Number(event.target.value) : event.target.value; apply();
  });
  tools.querySelectorAll('[data-font-mode]').forEach(button => button.addEventListener('click', () => { settings.typography.mode = button.dataset.fontMode; apply(); }));
  for (const [key, id] of [['latin', '#latin-font'], ['chinese', '#chinese-font']]) tools.querySelector(id).addEventListener('change', event => { settings.typography[key] = event.target.value; settings.typography.mode = 'custom'; apply(); });
  tools.querySelector('#type-target').addEventListener('change', event => { target = event.target.value; syncTypeControls(); });
  for (const attr of ['data-type-key', 'data-type-number']) tools.querySelectorAll(`[${attr}]`).forEach(input => {
    input.addEventListener('input', () => {
      if (input.value === '') return;
      const key = input.getAttribute(attr), [min, max] = bounds[key], value = Number(input.value);
      if (!Number.isFinite(value) || value < min || value > max) return;
      settings.typography.groups[target][key] = value; settings.typography.mode = 'custom'; apply();
    });
    input.addEventListener('change', syncTypeControls);
  });
  tools.querySelector('#reset-type').addEventListener('click', () => { settings.typography = newType(); apply(); });
  const close = () => { tools.open = false; tools.querySelector('summary').focus(); };
  tools.querySelector('#preview-close').addEventListener('click', close);
  addEventListener('keydown', event => { if (event.key === 'Escape' && tools.open) close(); });
  document.addEventListener('pointerdown', event => { if (tools.open && !tools.contains(event.target)) tools.open = false; });
  apply(false);
})();
