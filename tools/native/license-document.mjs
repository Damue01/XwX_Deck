import { createHash } from 'node:crypto';

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Identical bodies share one section; each package/file attribution remains.
// Copyright differences therefore always produce separate sections.
export function renderLicenseDocument(notices, sources) {
  const groups = new Map();
  for (const { label, text } of sources) {
    const digest = createHash('sha256').update(text).digest('hex');
    let group = groups.get(digest);
    if (!group) groups.set(digest, group = { text, labels: new Set() });
    if (group.text !== text) throw Error('许可证摘要冲突，未生成页面');
    group.labels.add(label);
  }
  const sections = [...groups].map(([digest, group]) =>
    `<section id="license-${digest}"><h2>${[...group.labels].sort().map(escape).join('<br>')}</h2><pre>${escape(group.text)}</pre></section>`
  ).join('\n');
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>XwX Deck 开源许可证</title>' +
    '<style>body{font:14px system-ui;margin:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}h2{font-size:14px;line-height:1.6;margin-top:32px}</style>' +
    '<h1>开源许可证</h1><pre>' + [...new Set(notices)].sort().map(escape).join('\n') + '</pre>' + sections + '</html>';
}
