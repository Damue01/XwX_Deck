import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import esbuild from 'esbuild';
import { rawTextPlugin } from './raw-text-plugin.mjs';

const root = resolve(import.meta.dirname, '..');
const docsRoot = resolve(root, 'docs');
const rendererDist = resolve(root, 'dist', 'renderer');
const host = '127.0.0.1';
const port = Number(process.env.PREVIEW_PORT) || 58123;
const largeLogPreview = process.env.XWX_DECK_LARGE_LOG_PREVIEW === '1';
const largeRequestPadding = largeLogPreview ? 'x'.repeat(4 * 1024 * 1024) : 'preview';
const largeResponsePadding = largeLogPreview ? 'y'.repeat(2 * 1024 * 1024) : 'preview';
const largeSnapshotPadding = largeLogPreview ? 'z'.repeat(1024 * 1024) : 'preview';
const largeSseEvents = largeLogPreview
  ? Array.from({ length: 1200 }, (_, index) => ({
      event: 'response.output_text.delta',
      data: JSON.stringify({ type: 'response.output_text.delta', delta: `chunk-${index}-${'d'.repeat(256)}` }),
      timestampMs: index
    }))
  : [];

// Build the renderer so dist/renderer is up to date.
console.log('[preview] building renderer…');
const build = spawnSync(process.execPath, [resolve(root, 'esbuild.config.mjs')], {
  cwd: root,
  stdio: 'inherit'
});
if (build.status !== 0) process.exit(build.status ?? 1);

// Build viewer HTML inline (unchanged from previous implementation).
const viewerBundle = await esbuild.build({
  stdin: {
    contents: [
      "export { renderTapViewerHtml } from './src/main/trace/webview/viewerHtml.ts';",
      "export { setCatalogPriceRules } from './src/main/trace/pricing.ts';"
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'viewer-preview-entry.ts',
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [rawTextPlugin],
  logLevel: 'silent'
});
const viewerModuleUrl = `data:text/javascript;base64,${Buffer.from(viewerBundle.outputFiles[0].text).toString('base64')}`;
const { renderTapViewerHtml, setCatalogPriceRules } = await import(viewerModuleUrl);
const bundledPricing = JSON.parse(readFileSync(resolve(root, 'assets/models-dev-pricing.json'), 'utf8'));
setCatalogPriceRules(Array.isArray(bundledPricing.rules) ? bundledPricing.rules : []);
const previewStartedAt = '2026-07-17T08:00:00.000Z';
const viewerPreviewHtml = renderTapViewerHtml({
  mode: 'static',
  state: {
    active: false,
    rootPath: 'browser-preview',
    generatedAt: previewStartedAt,
    pricingModelIds: [
      'claude-sonnet-5',
      'codex-auto-review',
      'gemini-3.1-pro-preview',
      'qwen3.8-max'
    ],
    sessions: [
      {
        id: 'viewer-preview',
        startedAt: previewStartedAt,
        updatedAt: '2026-07-17T08:02:35.000Z',
        traceCount: 3,
        jsonlPath: 'browser-preview.jsonl',
        firstPrompt: '请完整显示所有角色标签和消息内容。',
        source: 'codex-cli',
        durationMs: 155000,
        firstModel: 'gpt-5.1-codex'
      },
      {
        id: 'viewer-preview-2',
        startedAt: '2026-07-17T09:00:00.000Z',
        updatedAt: '2026-07-17T09:45:12.000Z',
        traceCount: 8,
        jsonlPath: 'browser-preview-2.jsonl',
        firstPrompt: '帮我分析这段代码的性能问题。',
        source: 'claude-cli',
        durationMs: 2712000,
        firstModel: 'claude-opus-4-6'
      },
      {
        id: 'viewer-preview-3',
        startedAt: '2026-07-17T10:00:00.000Z',
        updatedAt: '2026-07-17T10:00:30.000Z',
        traceCount: 1,
        jsonlPath: 'browser-preview-3.jsonl',
        firstPrompt: '写一个快速排序算法。',
        source: 'codex-cli',
        durationMs: 30000,
        firstModel: 'qwen3.8-max',
        totalTokens: 462942,
        usageByModel: {
          'qwen3.8-max': {
            version: 2,
            input: 3271,
            output: 1473,
            cacheRead: 456996,
            cacheCreation: 1202,
            total: 462942,
            apiType: 'responses'
          }
        }
      }
    ],
    traces: [],
    sessionTraces: {
      'viewer-preview': [{
        id: 'trace-preview',
        sessionId: 'viewer-preview',
        turn: 1,
        source: 'codex-cli',
        startedAt: previewStartedAt,
        completedAt: '2026-07-17T08:00:01.000Z',
        durationMs: 1000,
        clientIdentity: {
          family: 'codex',
          surface: 'desktop',
          source: 'codex-vscode',
          client: 'ChatGPT',
          confidence: 'strong',
          evidence: [largeLogPreview ? 'e'.repeat(20 * 1024) : 'preview-evidence']
        },
        request: {
          method: 'POST',
          path: '/v1/responses',
          model: 'gpt-5.1-codex',
          headers: {
            authorization: '<redacted>',
            'x-preview-visible': 'visible-header-value'
          },
          rawBody: JSON.stringify({
            model: 'gpt-5.1-codex',
            input: [
              { role: 'developer', content: 'RAW_BODY_PREVIEW_DEVELOPER' },
              { role: 'user', content: 'RAW_BODY_PREVIEW_USER' }
            ],
            payload: largeRequestPadding
          }),
          body: {
            model: 'gpt-5.1-codex',
            tools: [
              {
                type: 'function',
                name: 'shell',
                description: 'Run a command in the selected workspace.',
                parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
              },
              {
                type: 'function',
                name: 'read_file',
                description: 'Read one local file.',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
              }
            ],
            input: [
              { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEVELOPER_CONTENT_SENTINEL' }, { type: 'text', text: 'DEVELOPER_SECOND_BLOCK' }] },
              { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'HISTORICAL_USER_CONTENT' }] },
              { type: 'function_call', call_id: 'call_preview', name: 'shell', arguments: '{"command":"git status"}' },
              { type: 'function_call_output', call_id: 'call_preview', output: 'working tree clean' },
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Historical assistant response' }] },
              { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CURRENT_USER_CONTENT' }] }
            ]
          }
        },
        response: {
          statusCode: 200,
          headers: {},
          body: { id: 'resp_preview', output: largeResponsePadding },
          snapshot: {
            apiType: 'responses',
            model: 'gpt-5.1-codex',
            content: [{ type: 'text', text: 'Preview response' }],
            raw: { duplicatedPayload: largeSnapshotPadding }
          }
        },
        sse: { events: largeSseEvents },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      }, {
        id: 'trace-provider-switch',
        sessionId: 'viewer-preview',
        turn: 2,
        source: 'codex-cli',
        routedBy: 'prevResponseId',
        providerTransition: { source: 'official', target: 'compatible' },
        startedAt: '2026-07-17T08:01:00.000Z',
        completedAt: '2026-07-17T08:01:01.200Z',
        durationMs: 1200,
        request: {
          method: 'POST',
          path: '/v1/responses',
          model: 'gpt-5.1-codex',
          headers: {},
          body: {
            model: 'gpt-5.1-codex',
            previous_response_id: 'resp_official',
            input: [{ role: 'user', content: '继续处理，并切换到 兼容服务。' }]
          }
        },
        upstream: {
          baseUrl: 'https://compatible.example/v1',
          url: 'https://compatible.example/v1/responses'
        },
        response: { statusCode: 200, headers: {}, body: { id: 'resp_compatible' } },
        usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 }
      }, {
        id: 'trace-provider-switch-back',
        sessionId: 'viewer-preview',
        turn: 3,
        source: 'codex-cli',
        routedBy: 'clientConversationKey',
        startedAt: '2026-07-17T08:02:30.000Z',
        completedAt: '2026-07-17T08:02:35.000Z',
        durationMs: 5000,
        request: {
          method: 'POST',
          path: '/v1/responses',
          model: 'gpt-5.1-codex',
          headers: {},
          body: {
            model: 'gpt-5.1-codex',
            input: [{ role: 'user', content: '切回官方服务继续处理。' }]
          }
        },
        upstream: {
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          url: 'https://chatgpt.com/backend-api/codex/responses'
        },
        response: { statusCode: 200, headers: {}, body: { id: 'resp_official_back' } },
        usage: { inputTokens: 130, outputTokens: 25, totalTokens: 155 }
      }]
    },
    currentSessionId: 'viewer-preview-2'
  }
});

const productionSidebarPreviewTraces = [
  {
    id: 'nested-main',
    turn: 12,
    source: 'codex-vscode',
    client: 'ChatGPT',
    startedAt: '2026-08-05T08:20:04.000Z',
    completedAt: '2026-08-05T08:20:15.200Z',
    durationMs: 11200,
    request: { method: 'POST', path: '/v1/responses', model: 'gpt-5.6-sol', headers: {}, body: { input: [{ role: 'user', content: 'Inspect nested routing.' }] } },
    response: { statusCode: 200, headers: {}, snapshot: { apiType: 'responses', content: [{ type: 'text', text: 'Delegating the routing inspection.' }] } },
    usage: { inputTokens: 67600, outputTokens: 400, totalTokens: 68000 }
  },
  ...[
    ['nested-root-1', 13, 'Trace routing investigator', { invocationId: 'agent-root', depth: 1, agentType: 'general-purpose' }, 'claude-opus-5', 31200, 8700],
    ['nested-root-2', 14, 'Trace routing investigator', { invocationId: 'agent-root', depth: 1, agentType: 'general-purpose' }, 'claude-opus-5', 29800, 9100],
    ['nested-child-1', 15, 'Sagan', { invocationId: 'agent-child', parentInvocationId: 'agent-root', depth: 2, agentType: 'explorer' }, 'gpt-5.4-mini', 18500, 5800],
    ['nested-grandchild-1', 16, 'Curie', { invocationId: 'agent-grandchild', parentInvocationId: 'agent-child', depth: 3, agentType: 'code reviewer' }, 'gpt-5.4-mini', 17300, 6400],
    ['nested-grandchild-2', 17, 'Curie', { invocationId: 'agent-grandchild', parentInvocationId: 'agent-child', depth: 3, agentType: 'code reviewer' }, 'gpt-5.4-mini', 17700, 4900],
    ['nested-child-2', 18, 'Sagan', { invocationId: 'agent-child', parentInvocationId: 'agent-root', depth: 2, agentType: 'explorer' }, 'gpt-5.4-mini', 18200, 5100]
  ].map(([id, turn, subagent, subagentInfo, model, tokens, durationMs]) => ({
    id,
    turn,
    source: 'codex-vscode',
    client: 'ChatGPT',
    subagent,
    subagentInfo,
    startedAt: new Date(Date.parse('2026-08-05T08:20:04.000Z') + Number(turn) * 1000).toISOString(),
    completedAt: new Date(Date.parse('2026-08-05T08:20:04.000Z') + Number(turn) * 1000 + Number(durationMs)).toISOString(),
    durationMs,
    request: { method: 'POST', path: '/v1/responses', model, headers: {}, body: { input: [{ role: 'user', content: `Preview request ${turn}` }] } },
    response: { statusCode: 200, headers: {}, snapshot: { apiType: 'responses', content: [{ type: 'text', text: `Preview response ${turn}` }] } },
    usage: { inputTokens: Number(tokens) - 400, outputTokens: 400, totalTokens: Number(tokens) }
  })),
  // 回归夹具：一条 auxiliary 探测（19）夹在同一个 Sagan 段的两条请求（18 / 20）之间。
  // 严格时间序要求 Sagan 在此处断成两张卡；否则 20 会并进前面那张卡，而 19 落到它下方，
  // 侧栏的「请求 N」序列就不再单调递增。
  {
    id: 'nested-aux-probe',
    turn: 19,
    source: 'codex-vscode',
    client: 'ChatGPT',
    auxiliary: 'count',
    startedAt: '2026-08-05T08:20:23.000Z',
    completedAt: '2026-08-05T08:20:23.300Z',
    durationMs: 300,
    request: { method: 'POST', path: '/v1/messages/count_tokens', model: 'gpt-5.4-mini', headers: {}, body: { input: [{ role: 'user', content: 'token probe' }] } },
    response: { statusCode: 200, headers: {}, snapshot: { apiType: 'responses', content: [{ type: 'text', text: '{"input_tokens":1200}' }] } },
    usage: { inputTokens: 1200, outputTokens: 0, totalTokens: 1200 }
  },
  {
    id: 'nested-child-3',
    turn: 20,
    source: 'codex-vscode',
    client: 'ChatGPT',
    subagent: 'Sagan',
    subagentInfo: { invocationId: 'agent-child', parentInvocationId: 'agent-root', depth: 2, agentType: 'explorer' },
    startedAt: '2026-08-05T08:20:25.000Z',
    completedAt: '2026-08-05T08:20:30.400Z',
    durationMs: 5400,
    request: { method: 'POST', path: '/v1/responses', model: 'gpt-5.4-mini', headers: {}, body: { input: [{ role: 'user', content: 'Preview request 20' }] } },
    response: { statusCode: 200, headers: {}, snapshot: { apiType: 'responses', content: [{ type: 'text', text: 'Preview response 20' }] } },
    usage: { inputTokens: 15600, outputTokens: 400, totalTokens: 16000 }
  }
];
const productionSidebarPreviewBase = renderTapViewerHtml({
  mode: 'static',
  state: {
    active: false,
    rootPath: 'sidebar-production-preview',
    generatedAt: '2026-08-05T08:21:00.000Z',
    sessions: [{
      id: 'nested-production-session',
      startedAt: '2026-08-05T08:20:04.000Z',
      updatedAt: '2026-08-05T08:21:20.000Z',
      traceCount: 18,
      jsonlPath: 'nested-production-session.jsonl',
      firstPrompt: 'Inspect nested SubAgent routing.',
      source: 'codex-vscode',
      firstClient: 'ChatGPT',
      firstModel: 'gpt-5.6-sol'
    }],
    traces: productionSidebarPreviewTraces,
    sessionTraces: { 'nested-production-session': productionSidebarPreviewTraces },
    currentSessionId: 'nested-production-session'
  }
});
const productionSidebarPreviewHtml = productionSidebarPreviewBase.replace(
  '</body>',
  `<script>setTimeout(()=>{const row=document.querySelector('[data-sid="nested-production-session"]');if(row)row.click();},0);</script></body>`
);

const nestedSubagentPreviewHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trace · 嵌套 SubAgent 预览</title>
<style>
:root{
  --bg:#f6f7f4;--panel:#fff;--soft:#f0f2ef;--hover:#e9eeeb;
  --text:#2b2d2a;--muted:#69706a;--faint:#929a94;
  --line:#d9ded9;--line2:#e8ebe7;--blue:#315f7b;--green:#37745a;
  --violet:#75659a;--violet-bg:#f2eff8;--cyan:#31727b;--cyan-bg:#eef6f6;
  --amber:#9a7138;--mono:"Cascadia Mono","SFMono-Regular",Consolas,monospace;
  --sans:Inter,"Segoe UI",system-ui,sans-serif;
}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font:13px/1.55 var(--sans);background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
button{font:inherit}
.top{height:48px;display:flex;align-items:center;padding:0 16px;border-bottom:1px solid var(--line2);background:var(--panel)}
.brand{font-weight:700}.crumb{margin-left:9px;padding-left:10px;border-left:1px solid var(--line);color:var(--faint)}
.live{margin-left:auto;font:11px var(--mono);color:var(--green)}
.app{height:calc(100% - 48px);display:flex;min-height:0}
.rail{width:328px;flex:0 0 auto;border-right:1px solid var(--line);background:#f8f9f7;display:flex;flex-direction:column;min-height:0}
.rail-head{display:flex;align-items:center;gap:8px;padding:10px 12px 7px}
.rail-title{font-weight:650}.rail-count{color:var(--faint);font:11px var(--mono)}
.fold-all{margin-left:auto;border:0;background:transparent;color:var(--faint);font-size:11px;padding:3px 0;cursor:pointer}
.fold-all:hover{color:var(--text);text-decoration:underline;text-underline-offset:2px}
.fold-all:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:3px}
.list{overflow:auto;padding:0 0 18px}
.request-row{display:grid;grid-template-columns:52px 1fr;gap:6px;padding:9px 13px;cursor:pointer;transition:background .12s}
.request-row:hover{background:var(--hover)}
.request-row.selected{background:color-mix(in srgb,var(--violet) 9%,var(--panel))}
.req-no{font:650 11px var(--mono);color:var(--text)}
.req-main{min-width:0}.req-line{display:flex;align-items:baseline;gap:7px;min-width:0}
.model{margin-left:auto;max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:10.5px var(--mono);color:var(--faint)}
.req-meta{display:flex;gap:8px;margin-top:3px;font:10.5px var(--mono);color:var(--faint)}
.req-meta .tok{color:var(--blue)}.req-meta .dur{color:var(--green)}
.agent-shell{margin:7px 8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--panel);overflow:hidden}
.agent-head{width:100%;display:grid;grid-template-columns:14px minmax(0,1fr) auto;align-items:center;gap:7px;border:0;background:transparent;padding:8px 9px;text-align:left;cursor:pointer;color:var(--text)}
.agent-head:hover{background:color-mix(in srgb,var(--hover) 68%,var(--panel))}
.agent-head:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
.chev{color:var(--faint);font-size:10px;transition:transform .16s ease}
.agent-label{min-width:0;display:flex;align-items:baseline;gap:6px}
.agent-name{font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-role{font:10.5px var(--mono);color:var(--faint);white-space:nowrap}
.agent-summary{display:flex;gap:8px;font:10px var(--mono);color:var(--faint);white-space:nowrap}
.agent-summary .tok{color:var(--blue)}
.agent-body{display:grid;grid-template-rows:1fr;transition:grid-template-rows .18s ease}
.agent-body-inner{min-height:0;overflow:hidden}
.agent-group.collapsed>.agent-head .chev{transform:rotate(-90deg)}
.agent-group:not(.collapsed)>.agent-head .agent-summary{display:none}
.agent-group.collapsed>.agent-body{grid-template-rows:0fr}
.agent-direct>.request-row{padding-left:13px}
.nested-zone{margin:6px 7px 7px 12px;padding:0}
.nested-zone>.agent-group{border:1px solid var(--line2);border-radius:6px;background:#fbfcfa;overflow:hidden}
.nested-zone .nested-zone{margin:6px 6px 7px 10px}
.nested-zone .nested-zone>.agent-group{background:var(--panel)}
.nested-zone .agent-head{padding:7px 8px;border-radius:5px}
.main{flex:1;min-width:0;overflow:auto;padding:18px 22px 40px}
.detail-head{display:flex;align-items:baseline;gap:12px;margin-bottom:15px;color:var(--faint)}
.source{font:700 10.5px var(--mono);color:var(--green);text-transform:uppercase}
.detail-title{font-weight:700;color:var(--text)}
.detail-path{font:11px var(--mono);color:var(--violet)}
.detail-spacer{margin-left:auto}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:7px;background:var(--panel);margin-bottom:14px}
.metric{padding:11px 14px}.metric+.metric{border-left:1px solid var(--line2)}
.metric-k{font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.04em}
.metric-v{margin-top:3px;font:700 16px var(--mono)}.metric-v.green{color:var(--green)}.metric-v.blue{color:var(--blue)}
.section{border:1px solid var(--line);border-radius:7px;background:var(--panel);margin-bottom:10px}
.section-h{display:flex;align-items:center;padding:11px 13px;font-weight:650}.section-h span{margin-left:auto;color:var(--faint);font:10.5px var(--mono)}
.section-b{border-top:1px solid var(--line2);padding:13px 15px;color:var(--muted)}
.code{font:11.5px/1.65 var(--mono);white-space:pre-wrap;color:var(--text)}
.hint{margin-top:18px;padding:10px 12px;border-radius:6px;background:var(--soft);color:var(--muted);font-size:11.5px}
@media(max-width:780px){.rail{width:280px}.metrics{grid-template-columns:1fr 1fr}.metric:nth-child(3){border-left:0;border-top:1px solid var(--line2)}.metric:nth-child(4){border-top:1px solid var(--line2)}.agent-head{grid-template-columns:14px minmax(0,1fr)}.agent-summary{display:none!important}.agent-label{display:block}.agent-role{display:block;margin-top:1px}.agent-name{white-space:normal;overflow:visible;text-overflow:clip;line-height:1.25}}
@media(prefers-reduced-motion:reduce){.agent-body,.chev{transition:none}}
</style>
</head>
<body>
<header class="top"><div class="brand">Trace</div><div class="crumb">嵌套 SubAgent 预览</div><div class="live">STATIC PREVIEW</div></header>
<div class="app">
  <aside class="rail">
    <div class="rail-head"><span class="rail-title">请求记录</span><span class="rail-count">18 requests</span><button class="fold-all" id="foldAll">收起全部 SubAgents</button></div>
    <div class="list">
      <div class="request-row">
        <div class="req-no">请求 12</div>
        <div class="req-main"><div class="req-line"><strong>主 Agent</strong><span class="model">gpt-5.6-sol</span></div><div class="req-meta"><span class="tok">68.0k tok</span><span class="dur">11.2s</span><span>18:20:04</span></div></div>
      </div>

      <section class="agent-shell agent-group" data-agent>
        <button class="agent-head" aria-expanded="true">
          <span class="chev">▼</span><span class="agent-label"><span class="agent-name">Trace routing investigator</span><span class="agent-role">general-purpose</span></span>
          <span class="agent-summary"><span>6 req</span><span class="tok">129k</span></span>
        </button>
        <div class="agent-body"><div class="agent-body-inner">
          <div class="agent-direct">
            <div class="request-row"><div class="req-no">请求 13</div><div class="req-main"><div class="req-line"><strong>读取路由代码</strong><span class="model">claude-opus-5</span></div><div class="req-meta"><span class="tok">31.2k tok</span><span class="dur">8.7s</span></div></div></div>
            <div class="request-row"><div class="req-no">请求 14</div><div class="req-main"><div class="req-line"><strong>分析 session 匹配</strong><span class="model">claude-opus-5</span></div><div class="req-meta"><span class="tok">29.8k tok</span><span class="dur">9.1s</span></div></div></div>
          </div>

          <div class="nested-zone">
            <section class="agent-group" data-agent>
              <button class="agent-head" aria-expanded="true">
                <span class="chev">▼</span><span class="agent-label"><span class="agent-name">Sagan</span><span class="agent-role">explorer</span></span>
                <span class="agent-summary"><span>3 req</span><span class="tok">54k</span></span>
              </button>
              <div class="agent-body"><div class="agent-body-inner">
                <div class="agent-direct">
                  <div class="request-row"><div class="req-no">请求 15</div><div class="req-main"><div class="req-line"><strong>查找 transport 字段</strong><span class="model">gpt-5.4-mini</span></div><div class="req-meta"><span class="tok">18.5k tok</span><span class="dur">5.8s</span></div></div></div>
                </div>
                <div class="nested-zone">
                  <section class="agent-group" data-agent>
                    <button class="agent-head" aria-expanded="true">
                      <span class="chev">▼</span><span class="agent-label"><span class="agent-name">Curie</span><span class="agent-role">code reviewer</span></span>
                      <span class="agent-summary"><span>2 req</span><span class="tok">35k</span></span>
                    </button>
                    <div class="agent-body"><div class="agent-body-inner agent-direct">
                      <div class="request-row selected"><div class="req-no">请求 16</div><div class="req-main"><div class="req-line"><strong>复核嵌套路由</strong><span class="model">gpt-5.4-mini</span></div><div class="req-meta"><span class="tok">17.3k tok</span><span class="dur">6.4s</span></div></div></div>
                      <div class="request-row"><div class="req-no">请求 17</div><div class="req-main"><div class="req-line"><strong>输出风险清单</strong><span class="model">gpt-5.4-mini</span></div><div class="req-meta"><span class="tok">17.7k tok</span><span class="dur">4.9s</span></div></div></div>
                    </div></div>
                  </section>
                </div>
                <div class="agent-direct">
                  <div class="request-row"><div class="req-no">请求 18</div><div class="req-main"><div class="req-line"><strong>汇总字段来源</strong><span class="model">gpt-5.4-mini</span></div><div class="req-meta"><span class="tok">18.2k tok</span><span class="dur">5.1s</span></div></div></div>
                </div>
              </div></div>
            </section>
          </div>
        </div></div>
      </section>
    </div>
  </aside>

  <main class="main">
    <div class="detail-head"><span class="source">ChatGPT</span><span class="detail-title">请求 16</span><span class="detail-path">Trace routing investigator › Sagan › Curie</span><span class="detail-spacer"></span><span>18:20:31</span></div>
    <div class="metrics">
      <div class="metric"><div class="metric-k">Input</div><div class="metric-v">16,842</div></div>
      <div class="metric"><div class="metric-k">Output</div><div class="metric-v blue">492</div></div>
      <div class="metric"><div class="metric-k">Duration</div><div class="metric-v green">6.4s</div></div>
      <div class="metric"><div class="metric-k">Status</div><div class="metric-v">200</div></div>
    </div>
    <section class="section"><div class="section-h">Prompt <span>Curie · code reviewer</span></div><div class="section-b code">Review the nested SubAgent routing model.

Confirm that request ordering remains global while Agent grouping follows invocation ancestry.</div></section>
    <section class="section"><div class="section-h">Response <span>2 content blocks</span></div><div class="section-b">父子关系应由 invocation ID 驱动。折叠父 Agent 时隐藏全部后代；单独折叠子 Agent 时保留父 Agent 自己的请求。</div></section>
    <div class="hint">精简卡片方案：保留每个 Agent 的折叠卡片，移除树线和层级编号。展开时只显示名称与角色，收起后才显示请求数和 Token 汇总。</div>
  </main>
</div>
<script>
const groups = Array.from(document.querySelectorAll('[data-agent]'));
function syncLabel(){
  const open = groups.some(group => !group.classList.contains('collapsed'));
  document.getElementById('foldAll').textContent = open ? '收起全部 SubAgents' : '展开全部 SubAgents';
}
for(const group of groups){
  const head = group.querySelector(':scope > .agent-head');
  head.addEventListener('click', () => {
    const collapsed = group.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    syncLabel();
  });
}
document.getElementById('foldAll').addEventListener('click', () => {
  const anyOpen = groups.some(group => !group.classList.contains('collapsed'));
  for(const group of groups){
    group.classList.toggle('collapsed', anyOpen);
    group.querySelector(':scope > .agent-head').setAttribute('aria-expanded', anyOpen ? 'false' : 'true');
  }
  syncLabel();
});
</script>
</body>
</html>`;

const subagentTimelinePreviewHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trace · SubAgent 时间线预览</title>
<style>
:root{
  --bg:#f6f7f4;--panel:#fff;--soft:#f0f2ef;--hover:#e9eeeb;
  --text:#2b2d2a;--muted:#69706a;--faint:#929a94;
  --line:#d9ded9;--line2:#e8ebe7;--blue:#315f7b;--green:#37745a;
  --violet:#75659a;--cyan:#31727b;
  --mono:"Cascadia Mono","SFMono-Regular",Consolas,monospace;
  --sans:Inter,"Segoe UI",system-ui,sans-serif;
}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font:13px/1.55 var(--sans);background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
button{font:inherit}
.top{height:48px;display:flex;align-items:center;padding:0 16px;border-bottom:1px solid var(--line2);background:var(--panel)}
.brand{font-weight:700}.crumb{margin-left:9px;padding-left:10px;border-left:1px solid var(--line);color:var(--faint)}
.variant{margin-left:auto;font:11px var(--mono);color:var(--green)}
.app{height:calc(100% - 48px);display:flex;min-height:0}
.rail{width:328px;flex:0 0 auto;border-right:1px solid var(--line);background:#f8f9f7;display:flex;flex-direction:column;min-height:0}
.rail-head{display:flex;align-items:center;gap:8px;padding:10px 12px 7px;border-bottom:1px solid var(--line2)}
.rail-title{font-weight:650}.rail-count{color:var(--faint);font:11px var(--mono)}
.fold-all{margin-left:auto;border:0;background:transparent;color:var(--faint);font-size:11px;padding:3px 0;cursor:pointer}
.fold-all:hover{color:var(--text);text-decoration:underline;text-underline-offset:2px}
.fold-all:focus-visible,.agent-marker:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
.timeline{flex:1;overflow:auto;padding:4px 0 20px}
.trace-row{display:grid;grid-template-columns:58px minmax(0,1fr);gap:4px;padding:8px 13px;cursor:pointer;transition:background .12s}
.trace-row:hover{background:var(--hover)}
.trace-row.selected{background:color-mix(in srgb,var(--violet) 9%,var(--panel))}
.trace-no{font:650 11px var(--mono);color:var(--text);white-space:nowrap}
.trace-main{min-width:0}.trace-title{display:flex;align-items:baseline;gap:7px;min-width:0}
.trace-title strong{font-size:12.5px}
.model{margin-left:auto;max-width:106px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:10.5px var(--mono);color:var(--faint)}
.trace-meta{display:flex;gap:8px;margin-top:3px;font:10.5px var(--mono);color:var(--faint)}
.trace-meta .tok{color:var(--blue)}.trace-meta .dur{color:var(--green)}
.agent-block{position:relative}
.agent-block.depth-2,.agent-block.depth-3{margin-left:18px;padding-left:10px;border-left:1px solid var(--line)}
.agent-block.depth-3{margin-left:16px}
.agent-block.depth-2::before,.agent-block.depth-3::before{content:"";position:absolute;left:-1px;top:17px;width:8px;border-top:1px solid var(--line)}
.agent-marker{width:100%;display:grid;grid-template-columns:14px minmax(0,1fr) auto;align-items:center;gap:7px;padding:7px 13px;border:0;background:transparent;text-align:left;color:var(--text);cursor:pointer}
.agent-block.depth-2>.agent-marker,.agent-block.depth-3>.agent-marker{padding-left:2px}
.agent-marker:hover{background:color-mix(in srgb,var(--hover) 65%,transparent)}
.chev{font-size:9px;color:var(--faint);transition:transform .16s ease}
.agent-label{min-width:0;display:flex;align-items:baseline;gap:6px}
.agent-name{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-type{font:10.5px var(--mono);color:var(--faint);white-space:nowrap}
.agent-block.depth-1 .agent-name{color:var(--violet)}
.agent-block.depth-2 .agent-name,.agent-block.depth-3 .agent-name{color:var(--cyan)}
.marker-summary{display:none;font:10px var(--mono);color:var(--faint);white-space:nowrap}
.agent-body{display:grid;grid-template-rows:1fr;transition:grid-template-rows .18s ease}
.agent-body-inner{min-height:0;overflow:hidden}
.agent-block.collapsed>.agent-marker .chev{transform:rotate(-90deg)}
.agent-block.collapsed>.agent-marker .marker-summary{display:block}
.agent-block.collapsed>.agent-body{grid-template-rows:0fr}
.timeline-note{margin:8px 13px 0;padding-top:8px;border-top:1px solid var(--line2);font-size:10.5px;color:var(--faint)}
.main{flex:1;min-width:0;overflow:auto;padding:18px 22px 40px}
.detail-head{display:flex;align-items:baseline;gap:12px;margin-bottom:15px;color:var(--faint)}
.source{font:700 10.5px var(--mono);color:var(--green);text-transform:uppercase}
.detail-title{font-weight:700;color:var(--text)}
.detail-path{font:11px var(--mono);color:var(--violet)}
.detail-spacer{margin-left:auto}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:7px;background:var(--panel);margin-bottom:14px}
.metric{padding:11px 14px}.metric+.metric{border-left:1px solid var(--line2)}
.metric-k{font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.04em}
.metric-v{margin-top:3px;font:700 16px var(--mono)}.metric-v.green{color:var(--green)}.metric-v.blue{color:var(--blue)}
.section{border:1px solid var(--line);border-radius:7px;background:var(--panel);margin-bottom:10px}
.section-h{display:flex;align-items:center;padding:11px 13px;font-weight:650}.section-h span{margin-left:auto;color:var(--faint);font:10.5px var(--mono)}
.section-b{border-top:1px solid var(--line2);padding:13px 15px;color:var(--muted)}
.code{font:11.5px/1.65 var(--mono);white-space:pre-wrap;color:var(--text)}
.hint{margin-top:18px;padding:10px 12px;border-radius:6px;background:var(--soft);color:var(--muted);font-size:11.5px}
@media(max-width:780px){
  .rail{width:280px}.metrics{grid-template-columns:1fr 1fr}
  .metric:nth-child(3){border-left:0;border-top:1px solid var(--line2)}.metric:nth-child(4){border-top:1px solid var(--line2)}
  .agent-label{display:block}.agent-type{display:block;margin-top:1px}.agent-name{white-space:normal;line-height:1.25}
  .agent-marker{grid-template-columns:14px minmax(0,1fr)}.marker-summary{display:none!important}
}
@media(prefers-reduced-motion:reduce){.agent-body,.chev{transition:none}}
</style>
</head>
<body>
<header class="top"><div class="brand">Trace</div><div class="crumb">SubAgent 时间线预览</div><div class="variant">FLAT TIMELINE</div></header>
<div class="app">
  <aside class="rail">
    <div class="rail-head"><span class="rail-title">请求记录</span><span class="rail-count">18 requests</span><button class="fold-all" id="timelineFoldAll">收起全部</button></div>
    <div class="timeline">
      <div class="trace-row">
        <div class="trace-no">请求 12</div>
        <div class="trace-main"><div class="trace-title"><strong>主 Agent</strong><span class="model">gpt-5.6-sol</span></div><div class="trace-meta"><span class="tok">68.0k tok</span><span class="dur">11.2s</span><span>18:20:04</span></div></div>
      </div>

      <section class="agent-block depth-1" data-timeline-agent>
        <button class="agent-marker" aria-expanded="true">
          <span class="chev">▼</span>
          <span class="agent-label"><span class="agent-name">Trace routing investigator</span><span class="agent-type">general-purpose</span></span>
          <span class="marker-summary">6 req · 129k</span>
        </button>
        <div class="agent-body"><div class="agent-body-inner">
          <div class="trace-row"><div class="trace-no">请求 13</div><div class="trace-main"><div class="trace-title"><strong>读取路由代码</strong><span class="model">claude-opus-5</span></div><div class="trace-meta"><span class="tok">31.2k tok</span><span class="dur">8.7s</span></div></div></div>
          <div class="trace-row"><div class="trace-no">请求 14</div><div class="trace-main"><div class="trace-title"><strong>分析 session 匹配</strong><span class="model">claude-opus-5</span></div><div class="trace-meta"><span class="tok">29.8k tok</span><span class="dur">9.1s</span></div></div></div>

          <section class="agent-block depth-2" data-timeline-agent>
            <button class="agent-marker" aria-expanded="true">
              <span class="chev">▼</span>
              <span class="agent-label"><span class="agent-name">Sagan</span><span class="agent-type">explorer</span></span>
              <span class="marker-summary">3 req · 54k</span>
            </button>
            <div class="agent-body"><div class="agent-body-inner">
              <div class="trace-row"><div class="trace-no">请求 15</div><div class="trace-main"><div class="trace-title"><strong>查找 transport 字段</strong><span class="model">gpt-5.4-mini</span></div><div class="trace-meta"><span class="tok">18.5k tok</span><span class="dur">5.8s</span></div></div></div>

              <section class="agent-block depth-3" data-timeline-agent>
                <button class="agent-marker" aria-expanded="true">
                  <span class="chev">▼</span>
                  <span class="agent-label"><span class="agent-name">Curie</span><span class="agent-type">code reviewer</span></span>
                  <span class="marker-summary">2 req · 35k</span>
                </button>
                <div class="agent-body"><div class="agent-body-inner">
                  <div class="trace-row selected"><div class="trace-no">请求 16</div><div class="trace-main"><div class="trace-title"><strong>复核嵌套路由</strong><span class="model">gpt-5.4-mini</span></div><div class="trace-meta"><span class="tok">17.3k tok</span><span class="dur">6.4s</span></div></div></div>
                  <div class="trace-row"><div class="trace-no">请求 17</div><div class="trace-main"><div class="trace-title"><strong>输出风险清单</strong><span class="model">gpt-5.4-mini</span></div><div class="trace-meta"><span class="tok">17.7k tok</span><span class="dur">4.9s</span></div></div></div>
                </div></div>
              </section>

              <div class="trace-row"><div class="trace-no">请求 18</div><div class="trace-main"><div class="trace-title"><strong>汇总字段来源</strong><span class="model">gpt-5.4-mini</span></div><div class="trace-meta"><span class="tok">18.2k tok</span><span class="dur">5.1s</span></div></div></div>
            </div></div>
          </section>
        </div></div>
      </section>
      <div class="timeline-note">请求保持全局顺序。Agent 层级只通过缩进和名称变化表达。</div>
    </div>
  </aside>

  <main class="main">
    <div class="detail-head"><span class="source">ChatGPT</span><span class="detail-title">请求 16</span><span class="detail-path">Trace routing investigator › Sagan › Curie</span><span class="detail-spacer"></span><span>18:20:31</span></div>
    <div class="metrics">
      <div class="metric"><div class="metric-k">Input</div><div class="metric-v">16,842</div></div>
      <div class="metric"><div class="metric-k">Output</div><div class="metric-v blue">492</div></div>
      <div class="metric"><div class="metric-k">Duration</div><div class="metric-v green">6.4s</div></div>
      <div class="metric"><div class="metric-k">Status</div><div class="metric-v">200</div></div>
    </div>
    <section class="section"><div class="section-h">Prompt <span>Curie · code reviewer · depth 3</span></div><div class="section-b code">Review the nested SubAgent routing model.

Confirm that request ordering remains global while Agent grouping follows invocation ancestry.</div></section>
    <section class="section"><div class="section-h">Response <span>2 content blocks</span></div><div class="section-b">请求时间线保持平铺。Agent 标题只在上下文切换时出现，不再使用分组卡片或 S1.1 编号。</div></section>
    <div class="hint">此方案只保留一套层级信号：缩进和一条中性引导线。展开状态不显示组统计，收起后才显示请求数与 Token 汇总。</div>
  </main>
</div>
<script>
const timelineGroups = Array.from(document.querySelectorAll('[data-timeline-agent]'));
function syncTimelineFoldLabel(){
  const anyOpen = timelineGroups.some(group => !group.classList.contains('collapsed'));
  document.getElementById('timelineFoldAll').textContent = anyOpen ? '收起全部' : '展开全部';
}
for(const group of timelineGroups){
  const marker = group.querySelector(':scope > .agent-marker');
  marker.addEventListener('click', () => {
    const collapsed = group.classList.toggle('collapsed');
    marker.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    syncTimelineFoldLabel();
  });
}
document.getElementById('timelineFoldAll').addEventListener('click', () => {
  const anyOpen = timelineGroups.some(group => !group.classList.contains('collapsed'));
  for(const group of timelineGroups){
    group.classList.toggle('collapsed', anyOpen);
    group.querySelector(':scope > .agent-marker').setAttribute('aria-expanded', anyOpen ? 'false' : 'true');
  }
  syncTimelineFoldLabel();
});
</script>
</body>
</html>`;

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml; charset=utf-8']
]);

function serveFile(response, filePath) {
  if (!existsSync(filePath)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': mimeTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
    'cache-control': 'no-store'
  });
  response.end(readFileSync(filePath));
}

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${host}:${port}`);

  // Viewer preview route (unchanged).
  if (url.pathname === '/viewer-preview.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(viewerPreviewHtml);
    return;
  }

  if (url.pathname === '/viewer-nested-sidebar-preview.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(productionSidebarPreviewHtml);
    return;
  }

  if (url.pathname === '/nested-subagent-preview.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(nestedSubagentPreviewHtml);
    return;
  }

  if (url.pathname === '/subagent-timeline-preview.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(subagentTimelinePreviewHtml);
    return;
  }

  // Manager SPA routes: serve from dist/renderer.
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/manager-preview.html') {
    serveFile(response, join(rendererDist, 'index.html'));
    return;
  }

  // Renderer static assets (app.js, app.css, sourcemaps).
  const assetName = url.pathname.replace(/^\//, '');
  if (assetName && !assetName.includes('..') && !isAbsolute(assetName)) {
    const assetPath = join(rendererDist, assetName);
    const rel = relative(rendererDist, assetPath);
    if (!rel.startsWith('..')) {
      serveFile(response, assetPath);
      return;
    }
  }

  // Docs static file fallback.
  const requested = url.pathname.replace(/^\/docs\//, '').replace(/^\//, '');
  const filePath = resolve(docsRoot, decodeURIComponent(requested));
  const rel = relative(docsRoot, filePath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  serveFile(response, filePath);
});

server.listen(port, host, () => {
  console.log(`\nXwX Deck Manager preview: http://${host}:${port}/`);
  console.log(`Tap Viewer preview:        http://${host}:${port}/viewer-preview.html\n`);
  console.log(`Production sidebar preview:http://${host}:${port}/viewer-nested-sidebar-preview.html\n`);
  console.log(`Nested SubAgent preview:   http://${host}:${port}/nested-subagent-preview.html\n`);
  console.log(`SubAgent timeline preview: http://${host}:${port}/subagent-timeline-preview.html\n`);
});
