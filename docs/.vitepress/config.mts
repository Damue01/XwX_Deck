import { defineConfig } from 'vitepress';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readerContent } from './reader-content.mjs';

const base = process.env.DOCS_BASE || '/';
// Publish only the user manual. Repository maintenance records stay in Git.
const readerPages = new Set([
  'index.md', 'download.md', 'connections.md', 'models-and-clients.md',
  'accounts-and-switching.md', 'trace-and-usage.md', 'settings-and-data.md',
  'troubleshooting.md', 'user-manual.md', 'macos-first-run.md',
  'provider-compatibility.md', 'getting-started.md', 'about.md'
]);
const docsRoot = fileURLToPath(new URL('../', import.meta.url));
function markdownFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.')) return [];
    const relative = prefix + entry.name;
    return entry.isDirectory()
      ? markdownFiles(join(directory, entry.name), relative + '/')
      : entry.name.endsWith('.md') ? [relative] : [];
  });
}

export default defineConfig({
  lang: 'zh-CN',
  title: 'XwX Deck 文档',
  description: 'XwX Deck 使用手册：安装、服务配置、模型选择、请求追踪与故障排查。',
  base,
  srcExclude: markdownFiles(docsRoot).filter(page => !readerPages.has(page)),
  cleanUrls: true,
  appearance: false,
  markdown: {
    config: md => readerContent(md, { readerPages, docsRoot, base })
  },
  head: [
    ['link', { rel: 'icon', href: `${base}icon.png` }],
    ['meta', { name: 'theme-color', content: '#fcfcfb' }]
  ],
  themeConfig: {
    logo: '/icon.png',
    siteTitle: 'XwX Deck',
    nav: [
      { text: '官网', link: 'https://xwxdeck.com', target: '_self' },
      { text: 'GitHub', link: 'https://github.com/Damue01/XwX_Deck' }
    ],
    sidebar: [
      { text: '开始使用', items: [
        { text: '快速开始', link: '/', activeMatch: '^/(?:getting-started)?$' },
        { text: '下载与安装', link: '/download' }
      ] },
      { text: '使用指南', items: [
        { text: '服务与配置', link: '/connections' },
        { text: '模型与客户端', link: '/models-and-clients' },
        { text: '账号与服务切换', link: '/accounts-and-switching' },
        { text: 'Trace 与用量', link: '/trace-and-usage' },
        { text: '设置与本地数据', link: '/settings-and-data' },
        { text: '常见问题', link: '/troubleshooting' }
      ] },
      { text: '进一步了解', items: [
        { text: '功能与范围', link: '/about' },
        { text: '手册索引', link: '/user-manual' },
        { text: '接口与兼容边界', link: '/provider-compatibility' }
      ] }
    ],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    sidebarMenuLabel: '文档目录',
    skipToContentLabel: '跳到正文',
    returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '外观',
    notFound: { title: '页面未找到', quote: '可以返回快速开始，或搜索需要的内容。', linkLabel: '打开文档', linkText: '快速开始' },
    search: {
      provider: 'local',
      options: {
        async _render(source, env, md) {
          if (!readerPages.has(env.relativePath)) return '';
          return md.renderAsync(source, env);
        },
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详细结果', resetButtonTitle: '清除搜索',
                backButtonTitle: '返回', noResultsText: '没有找到相关内容',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
              }
            }
          }
        }
      }
    }
  }
});
