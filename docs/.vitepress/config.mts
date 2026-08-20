import { defineConfig } from 'vitepress';

const base = process.env.DOCS_BASE || '/';

export default defineConfig({
  lang: 'zh-CN',
  title: 'XwX Deck',
  description: '本地 Claude / ChatGPT 请求追踪与模型网关',
  base,
  cleanUrls: true,
  head: [
    ['link', { rel: 'icon', href: `${base}icon.png` }],
    ['meta', { name: 'theme-color', content: '#f6f6f3' }]
  ],
  themeConfig: {
    logo: '/icon.png',
    siteTitle: 'XwX Deck',
    nav: [
      { text: '指南', link: '/getting-started' },
      { text: '用户手册', link: '/user-manual' },
      { text: '架构', link: '/architecture' },
      { text: '服务商兼容', link: '/provider-compatibility' },
      { text: 'GitHub', link: 'https://github.com/Damue01/XwX_Deck' }
    ],
    sidebar: [
      {
        text: '使用',
        items: [
          { text: '首页', link: '/' },
          { text: '快速开始', link: '/getting-started' },
          { text: '用户手册', link: '/user-manual' },
          { text: 'macOS 首次运行', link: '/macos-first-run' },
          { text: '服务商兼容', link: '/provider-compatibility' }
        ]
      },
      {
        text: '维护',
        items: [
          { text: '架构', link: '/architecture' },
          { text: '模型能力', link: '/model-capability-maintenance' },
          { text: '会话路由', link: '/session-routing' },
          { text: 'Trace 捕获与恢复', link: '/trace-capture-session-recovery' },
          { text: '上下文可移植性', link: '/codex-context-compaction-portability' },
          { text: 'Roadmap', link: '/roadmap' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Damue01/XwX_Deck' }
    ],
    search: {
      provider: 'local'
    },
    footer: {
      message: 'Released under the Apache License 2.0.',
      copyright: 'Copyright © 2026 XwX Deck contributors'
    }
  }
});
