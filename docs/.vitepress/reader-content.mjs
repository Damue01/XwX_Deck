import { existsSync } from 'node:fs';
import { posix, resolve, sep } from 'node:path';

/** @param {import('vitepress').MarkdownRenderer} md */
export function readerContent(md, { readerPages, docsRoot, base = '/' }) {
  const publicRoot = resolve(docsRoot, 'public');
  function available(href, source) {
    if (!href || href.startsWith('#') || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(href)) return true;
    let pathname;
    try { pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]); }
    catch { return false; }
    if (base !== '/' && pathname.startsWith(base)) pathname = pathname.slice(base.length);
    else if (pathname.startsWith('/')) pathname = pathname.slice(1);
    else pathname = posix.join(posix.dirname(source || 'index.md'), pathname);
    pathname = posix.normalize(pathname);
    if (pathname.startsWith('../')) return false;
    if (pathname === '.' || pathname.endsWith('/')) pathname = pathname.replace(/^\.$/, '') + 'index.md';
    const extension = posix.extname(pathname);
    if (!extension) pathname += '.md';
    else if (extension === '.html') pathname = pathname.slice(0, -5) + '.md';
    if (pathname.endsWith('.md')) return readerPages.has(pathname);
    const asset = resolve(publicRoot, pathname);
    return asset.startsWith(publicRoot + sep) && existsSync(asset);
  }

  // Unpublished or missing local destinations keep their text without a link.
  md.core.ruler.push('reader_available_links', state => {
    for (const block of state.tokens) {
      const stack = [];
      for (const token of block.children || []) {
        if (token.type === 'link_open') {
          const disabled = !available(token.attrGet('href'), state.env.relativePath);
          stack.push(disabled);
          if (disabled) {
            token.type = 'reader_disabled_link_open';
            token.tag = 'span';
            token.attrs = [['class', 'doc-link-unavailable'], ['aria-disabled', 'true'], ['title', '暂无可跳转页面']];
          }
        } else if (token.type === 'link_close' && stack.pop()) {
          token.type = 'reader_disabled_link_close';
          token.tag = 'span';
        }
      }
    }
  });

  const tableOpen = md.renderer.rules.table_open || ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options));
  const tableClose = md.renderer.rules.table_close || ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options));
  md.renderer.rules.table_open = (tokens, index, options, env, renderer) => {
    let columns = 0;
    let keyed = false;
    for (let i = index + 1; i < tokens.length && tokens[i].type !== 'thead_close'; i++) {
      if (tokens[i].type === 'th_open') columns++;
      if (columns === 1 && tokens[i].type === 'inline' && tokens[i].content === '编号') keyed = true;
    }
    tokens[index].attrJoin('class', `doc-table doc-table--${Math.min(columns, 4)}${keyed ? ' doc-table--keyed' : ''}`);
    return '<div class="doc-table-scroll" role="region" aria-label="表格，可横向滚动" tabindex="0">\n' + tableOpen(tokens, index, options, env, renderer);
  };
  md.renderer.rules.table_close = (tokens, index, options, env, renderer) => tableClose(tokens, index, options, env, renderer) + '</div>\n';
}
