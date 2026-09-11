import { TapTraceRecord, TapSessionSummary } from '../types';
import { getPriceRules } from '../pricing';
import {
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_CAVEAT_TEXT,
  NOISE_TAGS
} from '../clientSignatures';
import { webviewCommonScript } from './common';
import { VIEWER_TOKEN_ALIASES, WEBVIEW_TOKEN_CSS } from './tokens';
import xwxIconSvg from '../../../../assets/icon.svg?raw';

export interface TapViewerState {
  readonly active: boolean;
  readonly localBaseUrl?: string;
  readonly rootPath: string;
  readonly storage?: {
    readonly rootPath: string;
    readonly totalBytes: number;
    readonly maxBytes?: number;
  };
  readonly generatedAt?: string;
  /** Exact model IDs currently exposed by the configured service. */
  readonly pricingModelIds?: readonly string[];
  readonly sessions: TapSessionSummary[];
  /** 当前 session 的 traces（dashboard 首屏 / 静态 HTML 快照走这条；live dashboard 切到 session 时再按需拉）。 */
  readonly traces: TapTraceRecord[];
  /**
   * 历史字段：早先版本会把所有 session 的 trace 全装这里。新版 live dashboard 不再下发，
   * 改用 /api/session/:id 按需拉单个 session 的 trace。静态 HTML 快照仍可用它批量装。
   */
  readonly sessionTraces?: Record<string, TapTraceRecord[]>;
  readonly currentSessionId?: string;
}

export function renderTapViewerHtml(input: {
  readonly state: TapViewerState;
  readonly mode?: 'static' | 'live';
}): string {
  const liveMode = input.mode === 'live';
  const bootstrap = JSON.stringify(input.state).replace(/</g, '\\u003c');
  const priceRules = JSON.stringify(getPriceRules()).replace(/</g, '\\u003c');
  const promptNoiseTags = JSON.stringify(NOISE_TAGS).replace(/</g, '\\u003c');
  const localCommandCaveatTag = JSON.stringify(LOCAL_COMMAND_CAVEAT_TAG);
  const localCommandCaveatText = JSON.stringify(LOCAL_COMMAND_CAVEAT_TEXT).replace(/</g, '\\u003c');
  const favicon = `data:image/svg+xml,${encodeURIComponent(xwxIconSvg)}`;
  return /* html */`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trace · 模型请求追踪</title>
<link rel="icon" href="${favicon}">
<style>
${WEBVIEW_TOKEN_CSS}
${VIEWER_TOKEN_ALIASES}
/* 底色分层（fill-tier）约定：卡片层级靠底色白↔灰↔白交替表达，边框只给最外层容器。
   T0 外框内壁/T2 叶子 = var(--panel) 白；T1 分组面 = var(--soft) 灰；页面底 = var(--bg)。
   往内一律不再描边。分隔默认靠留白；仅相邻同底色文本块用 var(--line-faint) 补极淡线。
   语义色调（thinking 琥珀 / diff 增绿删红）是唯一的"换色"层。
   保留的线：.metrics 列竖线、.sbs-diff 的 OLD|NEW 分列竖线——它们承载表格语义，非嵌套装饰。 */
*{box-sizing:border-box} html,body{height:100%;margin:0}
body{font-family:var(--sans);background:var(--bg);color:var(--text);font-size:13px;line-height:1.58;-webkit-font-smoothing:antialiased}
button,input{font:inherit} button{cursor:pointer}.tnum{font-variant-numeric:tabular-nums}
.top{height:48px;display:flex;align-items:center;gap:9px;padding:0 16px;border-bottom:1px solid var(--line2);background:var(--panel)}
.brand{display:flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer;transition:color .18s ease,background .14s ease;border:0;background:transparent;color:var(--text);font:inherit;font-weight:650;padding:0;border-radius:6px}.brand:hover{color:var(--blue)}.brand:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.top[data-view="session"] .brand{color:var(--muted);font-weight:600}.top[data-view="session"] .brand:hover{color:var(--blue)}
.top-actions{margin-left:auto;display:inline-flex;align-items:center;gap:10px;white-space:nowrap;height:22px}
.generated{color:var(--faint);font-family:var(--mono);font-size:11px;white-space:nowrap;display:inline-flex;align-items:center;height:22px;line-height:22px}
.generated .live-on{color:var(--green);font-weight:700}
.generated .live-off{color:var(--faint);font-weight:600}
.lang-toggle{border:0;background:transparent;color:var(--faint);border-radius:5px;padding:0 7px;height:22px;font-size:11px;font-weight:650;line-height:22px;cursor:pointer;font-family:var(--mono);display:inline-flex;align-items:center;justify-content:center;letter-spacing:.02em;position:relative;transition:color .12s,background .12s}
.lang-toggle::before{content:"";position:absolute;left:-5px;top:50%;transform:translateY(-50%);width:1px;height:12px;background:var(--line2)}
.lang-toggle:hover{background:var(--hover);color:var(--text)}
.lang-toggle:focus-visible{outline:2px solid var(--blue);outline-offset:1px;color:var(--text)}
.app{height:calc(100% - 48px);display:flex;min-height:0;position:relative;--rail-live-w:316px;--rail-mini-w:56px;--rail-spine-w:34px;--rail-ticks-w:42px;--rail-summary-w:72px}.rail{width:var(--rail-live-w);border-right:1px solid var(--rail-line);display:flex;flex-direction:column;min-height:0;background:var(--rail-bg);transition:width .18s ease}
.app.is-resizing .rail{transition:none}
.app.rail-snap .rail,.app.is-resizing.rail-snap .rail{transition:width .2s cubic-bezier(.4,0,.2,1)}
.rail-resizer{flex:0 0 auto;width:6px;margin:0 -3px;cursor:col-resize;position:relative;z-index:4;background:transparent}
.rail-resizer::after{content:"";position:absolute;inset:0 2px;border-radius:2px;background:transparent;transition:background .12s}
.rail-resizer:hover::after,.app.is-resizing .rail-resizer::after{background:color-mix(in srgb,var(--blue) 40%,transparent)}
.app[data-view="dashboard"] .rail-resizer{display:none}
.progress{display:flex;align-items:center;gap:14px;padding:9px 14px;color:var(--faint);font-size:12px;border-bottom:1px solid var(--rail-line2)}.progress .lbl{flex:0 0 auto;white-space:nowrap}.progress .cur{color:var(--text);font-weight:600}
.list{flex:1;overflow:auto;padding:2px 7px 16px;scrollbar-width:thin}
.list::-webkit-scrollbar{width:7px}.list::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--faint) 45%,transparent);border-radius:999px;background-clip:padding-box;border:2px solid transparent}.list::-webkit-scrollbar-thumb:hover{background:var(--faint);background-clip:padding-box}
.fold-toggle{margin-left:auto;font-size:11.5px;color:var(--faint);cursor:pointer;border:0;background:transparent;padding:0;font-family:inherit}
.fold-toggle:hover{color:var(--text);text-decoration:underline;text-underline-offset:2px}
.rail-more{padding:10px 14px;text-align:center;color:var(--faint);font-size:11.5px;font-variant-numeric:tabular-nums;cursor:pointer;user-select:none}
.rail-more:hover{color:var(--text);background:var(--rail-hover)}
.rail-more.loading{cursor:default;color:var(--muted)}
.rail-more.loading::before{content:"";display:inline-block;width:10px;height:10px;margin-right:7px;border-radius:999px;border:2px solid var(--rail-line);border-top-color:var(--blue);vertical-align:-1px;animation:xwxspin .8s linear infinite}
.row{margin:2px 0;padding:11px 10px 12px;border-radius:7px;cursor:pointer;position:relative;font-variant-numeric:tabular-nums;transition:background .12s,box-shadow .16s ease,transform .16s ease}.row:hover{background:var(--rail-hover)}
.row:focus-visible{outline:2px solid var(--blue);outline-offset:-2px;background:var(--rail-hover)}
.row::before{display:none}
.row.on{z-index:1;background:var(--panel);box-shadow:var(--shadow-soft),inset 0 0 0 1px var(--focus-line);transform:translateY(-1px)}
.row.on:hover{background:var(--panel);box-shadow:0 2px 4px rgba(40,47,54,.065),0 8px 22px rgba(40,47,54,.06),inset 0 0 0 1px var(--focus-line)}
.r1{display:flex;gap:7px;align-items:baseline}.turn{font-weight:650}.model{margin-left:auto;font-size:11px;color:var(--faint);max-width:108px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 特殊回合只用副标题识别，不再给整行铺色，避免和普通回合割裂。 */
.row.is-special:not(.on){background:transparent}
.row.is-special:not(.on):hover{background:var(--rail-hover)}
.row.is-special .mark{font-size:11px;font-weight:650;color:var(--req-color,var(--blue))}
/* 子 Agent 保持可折叠，用轻灰组块承载层级，不再使用侧边竖线。 */
/* 嵌套层级只靠"底色奇偶交替 + 缩进"表达，边框只留最外层——遵循本文件顶部的 fill-tier 约定。
   tier0/tier1 由 railGroupHtml 按 depth%2 输出，因此任意深度都能持续交替，不止三层。
   ⚠️ tier1 必须用足 --rail-bg：边框已移除，底色是唯一层级线索。早先的 34% 混色算出来是
   #FCFCFB，离纯白只差 3/255，当时靠边框兜底才不明显，现在会让相邻两层看起来完全一样。 */
.sagroup{margin:10px 1px;border:1px solid var(--rail-line);border-radius:7px;overflow:hidden}
.sagroup.tier0{background:var(--panel)}
.sagroup.tier1{background:var(--rail-bg)}
.sagroup.nested{margin:6px 7px 7px 14px;border:0;border-radius:6px}
.sahead{display:flex;align-items:baseline;gap:7px;padding:8px 9px;cursor:pointer;border:0;border-radius:0;background:transparent;box-shadow:none;user-select:none}
.sahead:hover{background:color-mix(in srgb,var(--rail-hover) 60%,var(--panel))}
.sahead .gname{font-weight:700;color:var(--text);font-size:13px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sahead .gkind{font-weight:500;color:var(--faint);font-size:11px;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 折叠态右侧要放「N 条 + token」摘要，宽度最紧：先让角色让位，保住 Agent 名称不被截断。 */
.sagroup:not(.open)>.sahead .gkind{display:none}
/* 续接标记：用分枝箭头表达“恢复旧分枝”，不再绘制抢眼的小方框。 */
.sahead .gcont{flex:0 0 auto;display:inline-flex;align-items:baseline;gap:3px;color:color-mix(in srgb,var(--cc,var(--blue)) 76%,var(--faint));font-size:10px;font-weight:600;white-space:nowrap}
.sahead .gcont::before{content:"↳";color:var(--cc,var(--blue));font-family:var(--mono);font-size:11px;font-weight:650}
/* 子 Agent 短 id：同名并行的子 Agent 只靠它区分，所以和 gcont 一样 flex:0 0 auto，
   也【不能】进上面那条折叠隐藏规则——折叠时它往往是唯一的区分标记。 */
.sahead .gid{flex:0 0 auto;font-family:var(--mono);font-size:9.5px;color:var(--cc,var(--faint));background:var(--cc-bg,transparent);border-radius:3px;padding:0 4px}
.sahead .gsum{margin-left:auto;flex:0 0 auto;font-family:var(--mono);font-size:10.5px;color:var(--faint);display:flex;gap:8px;white-space:nowrap}
.sahead .gsum .gtok{color:var(--blue)}
.sagroup.open>.sahead .gsum{display:none}
.sabody{display:grid;grid-template-rows:0fr;background:transparent;box-shadow:none;border-radius:0;transition:grid-template-rows .22s cubic-bezier(.4,0,.2,1)}
.sabody-inner{overflow:hidden;min-height:0}
.sagroup.open>.sabody{grid-template-rows:1fr}
.sabody .row{margin:3px 6px;padding-left:14px;border-radius:7px}
/* 灰底托白卡，白底托浅灰卡；选中的动作和阴影保持一致，只交换中性表面明度。 */
.sagroup.tier0>.sabody>.sabody-inner>.row.on{background:var(--pressed)}
.sagroup.tier0>.sabody>.sabody-inner>.row.on:hover{background:var(--pressed)}
.r2{font-family:var(--mono);font-size:11px;color:var(--faint);display:flex;gap:8px;margin-top:4px}.tok{color:var(--blue)}.dur{color:var(--green)}.bad .dur,.bad .err{color:var(--red)}.time{margin-left:auto}
.main{flex:1;min-width:0;display:flex;flex-direction:column}.scroll{flex:1;overflow:auto;padding:16px 18px 40px}
.head{display:flex;align-items:center;gap:0;flex-wrap:wrap;color:var(--faint);font-size:12px;margin-bottom:16px;row-gap:6px}
.head .src-tag{margin-right:12px}
.head .seg{display:inline-flex;align-items:baseline;gap:5px;padding:0 13px;border-left:1px solid var(--line2)}
.head .seg:first-of-type{border-left:0;padding-left:0}
.head .k{font-size:10.5px}.head b{color:var(--text);font-family:var(--mono);font-weight:650;font-size:12px}
.head b.dur{color:var(--green)}.head b.blue{color:var(--blue)}
.metrics{display:flex;align-items:center;position:relative;background:var(--panel);border:1px solid var(--line2);border-radius:var(--radius);overflow:hidden;cursor:pointer;transition:background .12s;margin-bottom:0;padding-left:15px}
.metrics:focus-visible,.sec-h:focus-visible,.tool-head:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
.metrics.open{border-bottom-left-radius:0;border-bottom-right-radius:0;border-bottom-color:transparent}
.metrics:hover{background:color-mix(in srgb,var(--panel) 55%,var(--hover))}
/* 展开三角与 .sec-h/.tool-head 同款：行首、10px、旋转而非换字符——这是"整行可点"的唯一视觉线索。
   左内缩 15+10+11=36px，与 .sec-h 的标题起点对齐。 */
.metrics .tw{font-size:10px;color:var(--faint);transition:transform .14s;width:10px;flex:0 0 auto}
.metrics.open .tw{transform:rotate(90deg)}
.metrics .mcol{flex:1;min-width:0;padding:12px 16px;display:flex;align-items:baseline;gap:8px}
.metrics .tw + .mcol{padding-left:11px}
.metrics .mcol + .mcol{border-left:1px solid var(--line2)}
.metrics .mk{font-size:10.5px;color:var(--faint);letter-spacing:.06em;text-transform:uppercase}
.metrics .mhero{font-family:var(--mono);font-size:18px;font-weight:700;color:var(--text);line-height:1;font-variant-numeric:tabular-nums}
/* padding-left 与 .metrics 的三角块(15+10)等宽：两处列竖线都落在同一 x，展开时不出现折角。 */
.metrics-detail{display:flex;border:1px solid var(--line2);border-top:0;border-radius:0 0 var(--radius) var(--radius);background:var(--soft);padding-left:25px}
.metrics-cw{overflow:hidden;max-height:0;margin-bottom:16px;transition:max-height .24s cubic-bezier(.4,0,.2,1)}
.metrics-cw.open{overflow:visible;max-height:none}
.metrics-detail .mdcol{flex:1;min-width:0;padding:11px 16px;display:flex;flex-direction:column;gap:9px}
.metrics-detail .mdcol:first-of-type{padding-left:11px}
.metrics-detail .mdcol + .mdcol{border-left:1px solid var(--line2)}
.metrics-detail .mdrow{display:flex;gap:14px 16px;flex-wrap:wrap;align-items:center}
.metrics-detail .m{display:flex;align-items:baseline;gap:5px;color:var(--faint);font-size:12px}
.metrics-detail .m b{font-family:var(--mono);font-weight:650;color:var(--text);font-size:13px;font-variant-numeric:tabular-nums}
.metrics-detail .metric{display:flex;align-items:center;gap:6px;color:var(--faint);font-size:12px}
.metrics-detail .metric i{width:7px;height:7px;border-radius:50%;display:inline-block}
.metrics-detail .metric b{font-family:var(--mono);font-weight:650;color:var(--text);font-variant-numeric:tabular-nums}
.metrics-detail .wf{display:flex;align-items:center}
.metrics-detail .wf-bar{display:flex;flex:1;gap:2px;height:6px;overflow:visible}
.metrics-detail .wf-seg{display:block;height:100%;border-radius:2px}
.bar{display:flex;align-items:center;gap:8px;margin:0 0 14px;flex-wrap:nowrap;min-width:0}
/* 统一分段控件（modeseg / dash-filters / fmt-bar）：同一套滑块风格 */
.modeseg,.dash-filters,.fmt-bar{position:relative;display:inline-flex;border:0;border-radius:9px;padding:3px;background:var(--soft);flex:0 0 auto}
.modeseg .seg-thumb,.dash-filters .seg-thumb,.fmt-bar .seg-thumb{position:absolute;top:3px;left:0;height:calc(100% - 6px);border-radius:7px;background:var(--panel);box-shadow:0 1px 2px rgba(43,42,38,.10),0 2px 6px rgba(43,42,38,.08);transition:transform .26s cubic-bezier(.22,.61,.36,1),width .26s cubic-bezier(.22,.61,.36,1);pointer-events:none;will-change:transform,width}
.modeseg button,.dash-filters .dash-filter,.fmt-bar .fmt-btn{position:relative;z-index:1;border:0;background:transparent;color:var(--muted);border-radius:7px;display:inline-flex;align-items:center;justify-content:center;line-height:1.58;cursor:pointer;font-family:inherit;transition:color .22s ease,transform .14s ease}
.modeseg button:hover:not(.active),.dash-filters .dash-filter:hover:not(.active),.fmt-bar .fmt-btn:hover:not(.active){color:var(--text)}
.modeseg button:active,.dash-filters .dash-filter:active,.fmt-bar .fmt-btn:active{transform:scale(.97)}
.modeseg button.active,.dash-filters .dash-filter.active,.fmt-bar .fmt-btn.active{color:var(--text);font-weight:600}
.modeseg button{padding:6px 16px;font-size:12.5px;font-weight:600}
.dash-filters .dash-filter{padding:6px 16px;font-size:12.5px;font-weight:600;gap:7px}
.dash-filters{margin:24px 0 14px}
.fmt-bar .fmt-btn{padding:6px 13px;font-size:10.5px;font-family:var(--mono);font-weight:700;letter-spacing:.04em}
.fmt-bar{margin-bottom:12px}
@media (prefers-reduced-motion: reduce){.modeseg .seg-thumb,.dash-filters .seg-thumb,.fmt-bar .seg-thumb{transition:transform .12s linear,width .12s linear}.modeseg button:active,.dash-filters .dash-filter:active,.fmt-bar .fmt-btn:active{transform:none}}
.cmp-controls{display:none;align-items:center;gap:9px}.app[data-detmode="compare"] .cmp-controls{display:inline-flex}
.cmp-controls .lbl{font-size:11px;color:var(--faint)}
.diff-sel-wrap{position:relative;display:inline-flex}
.diff-sel{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:4px 9px;cursor:pointer;white-space:nowrap;font-family:inherit;transition:background .12s,border-color .12s,box-shadow .12s}
.diff-sel:hover{background:var(--hover);border-color:color-mix(in srgb,var(--line) 55%,var(--faint))}
.diff-sel:focus-visible{outline:0;box-shadow:0 0 0 2px var(--focus-ring)}
.diff-sel .diff-sel-label{max-width:220px;overflow:hidden;text-overflow:ellipsis}
.diff-sel .diff-caret{flex:0 0 auto;color:var(--faint);transition:transform .18s var(--ease)}
.diff-sel-wrap.open .diff-caret{transform:rotate(180deg)}
.diff-pop{position:absolute;top:calc(100% + 6px);left:0;min-width:220px;max-width:340px;max-height:320px;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-raise);z-index:var(--z-menu);padding:5px;display:none}
.diff-sel-wrap.open .diff-pop{display:block}
.diff-pop .diff-optgroup{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);padding:7px 9px 3px}
.diff-pop .diff-opt{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text);border-radius:6px;padding:6px 9px;cursor:pointer;white-space:nowrap}
.diff-pop .diff-opt .diff-tick{flex:0 0 auto;width:13px;height:13px;color:var(--blue);opacity:0}
.diff-pop .diff-opt.selected{background:var(--soft)}.diff-pop .diff-opt.selected .diff-tick{opacity:1}
.diff-pop .diff-opt:hover,.diff-pop .diff-opt.hl{background:var(--hover)}
.cmp-controls .diff-nav{border:1px solid var(--line);background:var(--panel);color:var(--muted);border-radius:6px;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background .12s,color .12s,box-shadow .12s}
.cmp-controls .diff-nav svg{display:block}
.cmp-controls .diff-nav:hover{background:var(--hover);color:var(--text)}.cmp-controls .diff-nav:focus-visible{outline:0;box-shadow:0 0 0 2px var(--focus-ring)}.cmp-controls .diff-nav:disabled{opacity:.35;cursor:default}.cmp-controls .diff-nav:disabled:hover{background:var(--panel);color:var(--muted)}
.cmp-controls .diff-cur{font-size:12px;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:4px 10px;white-space:nowrap}
.acts{margin-left:auto;display:inline-flex;gap:2px;flex:0 0 auto}.acts .search-btn{background:var(--panel);border:1px solid var(--line);color:var(--faint);font-size:12.5px;padding:0 12px;border-radius:8px;display:inline-flex;align-items:center;justify-content:flex-start;gap:7px;min-width:172px;min-height:40px;line-height:1;font-weight:500}.acts .search-btn svg{display:block;flex:0 0 auto;opacity:.8}.acts .search-btn .search-ph{color:var(--faint);line-height:1}.acts .search-btn:hover{background:var(--hover);border-color:color-mix(in srgb,var(--line) 60%,var(--faint));color:var(--text)}.acts .search-btn:hover svg{opacity:1}.acts .search-btn:hover .search-ph{color:var(--text)}
.view-single{display:block}.app[data-detmode="compare"] .view-single,.app[data-detmode="raw"] .view-single{display:none}
.view-cmp{display:none}.app[data-detmode="compare"] .view-cmp{display:block}
.view-raw{display:none}.app[data-detmode="raw"] .view-raw{display:block}
.cmp-summary{display:flex;gap:18px;margin:0 0 14px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.trace-curl{font-family:var(--mono);font-size:12px;background:var(--panel);border:1px solid var(--line2);border-radius:var(--radius);padding:14px 16px;white-space:pre;overflow:auto;color:var(--text)}
.trace-pretty{background:var(--panel);border:1px solid var(--line2);border-radius:var(--radius);padding:12px 16px;font-size:12px;font-family:var(--mono);line-height:1.6}
.pp-grid{display:grid;grid-template-columns:max-content 1fr;column-gap:14px;row-gap:1px;align-items:baseline;min-width:0}
.pp-k{color:var(--blue);font-weight:700;white-space:nowrap}.pp-k::after{content:":";color:var(--faint);margin-left:1px}
.pp-v{min-width:0;overflow-wrap:anywhere;word-break:break-word;color:var(--text)}
.pp-nest{min-width:0}.pp-nest>.pp-sum{cursor:pointer;list-style:none;user-select:none;display:inline-flex;align-items:center;gap:6px;color:var(--faint);font-size:11px}.pp-nest>.pp-sum::-webkit-details-marker{display:none}.pp-tw{display:inline-block;width:9px;font-size:10px;transition:transform .12s}.pp-nest[open]>.pp-sum .pp-tw{transform:rotate(90deg)}
.pp-nest>.pp-grid{margin-top:2px;padding-left:14px;border-left:1px dashed var(--line2)}
.pp-str{color:var(--green)}.pp-num{color:var(--amber)}.pp-bool{color:var(--violet);font-weight:700}.pp-null{color:var(--faint);font-style:italic}.pp-empty-row{color:var(--faint);font-style:italic;grid-column:1 / -1}.pp-meta{color:var(--faint);font-family:var(--mono);font-size:11px}
.pp-multiline{font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--text);background:var(--soft);border:1px solid var(--line2);border-radius:4px;padding:8px 10px;margin:2px 0;max-height:none;overflow:visible}
.actions{display:flex;gap:14px;margin-bottom:12px;flex-wrap:wrap}.act{border:0;background:transparent;color:var(--muted);padding:4px 2px;font-size:12px}.act:hover{color:var(--text)}.act:active{transform:scale(.98)}
.error-banner{display:flex;gap:10px;margin-bottom:12px;padding:10px 12px;border-radius:var(--radius);background:var(--red-bg);color:var(--red)}.error-banner b{display:block;color:var(--red)}
.error-banner .retry{margin-left:auto;align-self:center;border:1px solid currentColor;border-radius:5px;background:transparent;color:inherit;padding:4px 9px;font-weight:650}
.notimpl-banner{display:flex;gap:10px;margin-bottom:12px;padding:10px 12px;border-radius:var(--radius);background:var(--amber-bg);color:var(--amber)}.notimpl-banner b{display:block;color:var(--amber)}
.r2 .notimpl{font-family:var(--mono);font-size:10.5px;font-weight:650;color:var(--amber)}
.sec{margin-bottom:10px}
.sec-h{display:flex;align-items:center;gap:11px;padding:13px 15px;border:1px solid var(--line2);border-radius:var(--radius);background:var(--panel);cursor:pointer;user-select:none;transition:background .12s;font-weight:650}
.sec-h:hover{background:color-mix(in srgb,var(--panel) 55%,var(--hover))}
.sec:not(.closed) .sec-h{border-bottom-left-radius:0;border-bottom-right-radius:0;border-bottom-color:transparent}
.sec-h .tw{font-size:10px;color:var(--faint);transition:transform .14s;width:10px;flex:0 0 auto}
.sec:not(.closed) .sec-h .tw{transform:rotate(90deg)}
.sec-h .cnt{margin-left:auto;color:var(--faint);font-weight:500;font-size:11px}
.sec-b{display:block;border:1px solid var(--line2);border-top:0;border-radius:0 0 var(--radius) var(--radius);padding:6px 16px 14px}
.cw{overflow:visible;max-height:none;transition:max-height .24s cubic-bezier(.4,0,.2,1)}
.sec.closed .cw{overflow:hidden;max-height:0}
.sysblk{padding:13px 0;border-top:1px solid var(--line-faint)}.sysblk:first-child{border-top:0;padding-top:8px}
.sysblk-body{font-family:var(--mono);font-size:12px;color:var(--muted);white-space:pre-wrap;word-break:break-word;line-height:1.6}
.resp-think{background:color-mix(in srgb,var(--amber-bg) 60%,var(--panel));border-radius:var(--radius-sm);padding:10px 13px;margin-bottom:12px}
.resp-think-h{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;font-weight:700;color:var(--amber);margin-bottom:6px}
.resp-think-h .tk{font-family:var(--mono);font-weight:500;color:var(--faint);margin-left:auto}
.resp-think-body{font-family:var(--mono);font-size:12px;color:var(--muted);white-space:pre-wrap;line-height:1.6}
.resp-think-body.empty{font-style:italic;color:var(--faint)}
.resp-think-sig{font-family:var(--mono);font-size:10.5px;color:var(--faint);word-break:break-all;margin-top:6px;max-height:none;overflow:visible;background:color-mix(in srgb,var(--amber-bg) 55%,var(--panel));border-radius:4px;padding:6px 8px;opacity:.8}
.resp-text{font-size:13.5px;line-height:1.72;white-space:pre-wrap;overflow-wrap:anywhere;max-width:82ch;color:var(--text)}
.resp-text code{font-family:var(--mono);background:var(--soft);padding:1px 5px;border-radius:3px;font-size:12.5px}
.resp-alert{margin:2px 0 12px;padding:8px 10px;border-radius:var(--radius-sm);background:color-mix(in srgb,var(--red-bg) 70%,var(--panel));color:var(--red);font-size:12px}.resp-refusal{margin:8px 0;padding:10px 12px;border-left:3px solid var(--red);border-radius:0 var(--radius-sm) var(--radius-sm) 0;background:color-mix(in srgb,var(--red-bg) 55%,var(--panel))}.resp-refusal-k{font-family:var(--mono);font-size:10px;font-weight:750;letter-spacing:.06em;color:var(--red);margin-bottom:5px}.resp-choice{margin:8px 0 14px;padding:9px 11px;border:1px solid var(--line2);border-radius:var(--radius-sm)}.resp-choice-k{font-family:var(--mono);font-size:10px;font-weight:750;color:var(--faint);margin-bottom:8px}
.tool-block{background:var(--soft);border-radius:var(--radius-sm);margin:7px 0;overflow:hidden}.tool-head{display:flex;align-items:baseline;gap:10px;padding:9px 12px;cursor:pointer}.tool-head:hover{background:color-mix(in srgb,var(--soft) 60%,var(--hover))}.tool-tw{font-size:10px;color:var(--faint);transition:transform .14s}.tool-block.open .tool-tw{transform:rotate(90deg)}.tool-name{color:var(--cyan);font-family:var(--mono);font-weight:700}.tool-desc{color:var(--faint);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tool-body{display:block;border-top:1px solid var(--line-faint);padding:11px 12px 13px}.tool-block:not(.open) .cw{overflow:hidden;max-height:0}.tool-block.open .cw{overflow:visible;max-height:none}.tool-full{color:var(--muted);white-space:pre-wrap;margin-bottom:11px}.param-title{font-size:10.5px;font-weight:700;color:var(--muted);margin-bottom:8px}.param{background:var(--panel);border-radius:var(--radius-sm);padding:8px 10px;margin:5px 0}.param-line{display:flex;align-items:center;gap:8px}.param-name{color:var(--blue);font-family:var(--mono);font-weight:700}.type-tag{font-size:10px;font-family:var(--mono);color:var(--amber)}.req{font-size:10px;font-weight:700;color:var(--red)}.param-desc{color:var(--faint);margin-top:5px;font-size:12px}
.tool-kind{font-size:10px;font-family:var(--mono);color:var(--faint)}.tool-note{color:var(--faint);font-size:12px;padding:5px 0}
/* 声明里改变工具行为的非 schema 字段：max_uses / external_web_access / defer_loading… */
.tool-flags{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 9px}
.tool-flag{font-family:var(--mono);font-size:10.5px;color:var(--muted);padding:1px 0}.tool-flag+.tool-flag::before{content:'·';color:var(--faint);margin:0 7px 0 1px}
.tool-flag-k{color:var(--faint);margin-right:5px}
.tool-subtools{margin-top:10px}.tool-child{margin:7px 0;border:1px solid var(--line2);border-radius:7px;background:var(--panel);overflow:hidden}.tool-child-head{display:flex;align-items:baseline;gap:8px;padding:9px 10px;cursor:pointer;list-style:none}.tool-child-head::-webkit-details-marker{display:none}.tool-child-head::before{content:'▶';font-size:8px;color:var(--faint);transition:transform .14s}.tool-child[open]>.tool-child-head::before{transform:rotate(90deg)}.tool-child-head:hover{background:color-mix(in srgb,var(--panel) 70%,var(--hover))}.tool-child-body{padding:10px 12px 12px;border-top:1px solid var(--line-faint)}.tool-child-name{font-family:var(--mono);font-weight:700;color:var(--cyan)}.tool-child-desc{color:var(--faint);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.schema-list{display:flex;flex-direction:column;gap:10px;padding:3px 0 5px}.schema-row{min-width:0;padding-left:calc(var(--schema-depth,0)*18px)}.schema-row.schema-depth-0+.schema-row.schema-depth-0{margin-top:2px}.schema-head{display:flex;align-items:baseline;gap:9px;min-width:0;flex-wrap:wrap}.schema-field{font-family:var(--mono);font-weight:650;color:var(--text);overflow-wrap:anywhere}.schema-type{font-family:var(--mono);font-size:10.5px;color:var(--faint);white-space:nowrap}.schema-required{font-family:var(--sans);font-size:10px;color:var(--muted)}.schema-help{max-width:760px;margin-top:3px;font-size:12px;color:var(--muted);line-height:1.48;overflow-wrap:anywhere}.schema-help-empty{display:none}
.embedded-tools{margin:2px 0 10px;border-top:1px solid var(--line-faint)}.embedded-tool-row{display:grid;grid-template-columns:minmax(170px,.62fr) minmax(260px,1.5fr);gap:12px;align-items:baseline;padding:7px 0;border-bottom:1px solid var(--line-faint)}.embedded-tool-name{font-family:var(--mono);font-weight:650;color:var(--cyan);overflow-wrap:anywhere}.embedded-tool-desc{font-size:12px;color:var(--muted);line-height:1.45}.embedded-tool-note{margin-top:6px;font-size:11px;color:var(--faint)}
@media(max-width:760px){.schema-row{padding-left:calc(var(--schema-depth,0)*14px)}.embedded-tool-row{grid-template-columns:1fr;gap:3px;padding:8px 0}}
/* .pill.system 保留为 .pill.developer 的别名：roleClass 已把两者归一到紫色，但历史快照/
   外部引用可能仍带 system 类，别让它退回无色。 */
.msg{padding:11px 0}.msg+.msg{border-top:1px solid var(--line-faint)}.msg-role{min-height:18px;margin-bottom:6px;display:flex;align-items:baseline;gap:7px}.msg-phase{font-family:var(--mono);font-size:9px;color:var(--faint);letter-spacing:.03em}.msg-body{min-width:0}.pill{display:inline-block;font-weight:750;font-size:10px;letter-spacing:.04em;text-transform:uppercase}.pill.user{color:var(--blue)}.pill.assistant{color:var(--green)}.pill.system,.pill.developer{color:var(--violet)}.pill.tool{color:var(--amber)}.pill.unknown{color:var(--faint)}
.tool-use-label{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}.tool-link-id{display:inline-flex;align-items:baseline;gap:4px;max-width:100%;font-family:var(--mono);font-size:10px;font-weight:500;color:var(--muted);background:var(--soft);border:1px solid var(--line2);border-radius:4px;padding:1px 6px;overflow-wrap:anywhere}.tool-link-k{font-size:8.5px;font-weight:750;letter-spacing:.05em;color:var(--faint)}.tool-linked-name{font-family:var(--mono);font-size:10.5px;color:var(--cyan)}
.content-block{margin-top:7px;position:relative}.content-block.block-framed{padding:8px 2px}.content-block.txtsib+.content-block.txtsib{border-top:1px solid var(--line-faint);margin-top:0}.pre-text,.txt,.json,.sys,.sse-data{font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--muted)}.txt{font-family:var(--sans);font-size:13px;color:var(--text)}
.block-fmt{position:absolute;top:6px;right:8px;display:none;gap:1px;padding:1px;border:1px solid var(--line2);border-radius:4px;background:var(--panel);z-index:1}.content-block:hover .block-fmt{display:inline-flex}.block-fmt-btn{border:0;background:transparent;color:var(--faint);font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.05em;padding:2px 6px;border-radius:3px;cursor:pointer}.block-fmt-btn:hover{color:var(--text)}.block-fmt-btn.active{background:var(--soft);color:var(--text)}
.sys-wrap{position:relative}.sys-fmt{position:absolute;top:10px;right:0;display:none;gap:1px;padding:1px;border:1px solid var(--line2);border-radius:4px;background:var(--panel);z-index:1}.sys-wrap:hover .sys-fmt{display:inline-flex}.sys-fmt-btn{border:0;background:transparent;color:var(--faint);font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.05em;padding:2px 6px;border-radius:3px;cursor:pointer}.sys-fmt-btn:hover{color:var(--text)}.sys-fmt-btn.active{background:var(--soft);color:var(--text)}
.md{font-size:13px;line-height:1.6}.md .md-h{font-weight:700;margin:10px 0 4px;color:var(--text)}.md h1.md-h{font-size:18px}.md h2.md-h{font-size:16px}.md h3.md-h{font-size:14px}.md h4.md-h,.md h5.md-h,.md h6.md-h{font-size:13px}.md .md-p{margin:4px 0;white-space:pre-wrap;word-break:break-word}.md .md-list{margin:4px 0 4px 19px;padding:0}.md .md-ol{margin-left:22px}.md .md-list .md-list{margin-top:3px;margin-bottom:2px}.md .md-list li{margin:2px 0}.md .md-li-text{white-space:pre-wrap;word-break:break-word}.md .md-br{height:6px}.md .md-code{background:var(--soft);border-radius:4px;padding:8px 10px;margin:6px 0;font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word}.md code{background:var(--soft);padding:1px 5px;border-radius:3px;font-family:var(--mono);font-size:12px;color:var(--text)}
.sys-pane>.md{font-family:var(--sans);color:var(--text);white-space:normal}.sys-pane>.md .md-h{margin:9px 0 3px}.sys-pane>.md h1.md-h{font-size:16px}.sys-pane>.md h2.md-h{font-size:15px}.sys-pane>.md h3.md-h{font-size:14px}.sys-pane>.md h4.md-h,.sys-pane>.md h5.md-h,.sys-pane>.md h6.md-h{font-size:13px}.sys-pane>.md>.md-h:first-child{margin-top:2px}
.thinking{background:var(--amber-bg);border-radius:var(--radius-sm);padding:9px 11px}.thinking-label,.tool-use-label{font-family:var(--mono);font-size:11px;font-weight:700;margin-bottom:5px}.thinking-label{color:var(--amber)}.tool-use-label{color:var(--cyan)}
.think-hidden{color:var(--faint);font-size:12px;font-style:italic}
/* 密文/签名默认折起来：Codex 一条 reasoning 就有 1KB base64，铺开会把对话挤走。 */
.think-blob{margin-top:6px}
.think-blob>summary{cursor:pointer;list-style:none;font-family:var(--mono);font-size:10.5px;color:var(--faint)}
.think-blob>summary::-webkit-details-marker{display:none}
.think-blob>summary:hover{color:var(--muted)}
.think-blob-len{opacity:.8}
.think-sig{font-family:var(--mono);font-size:10.5px;color:var(--faint);word-break:break-all;margin-top:6px;max-height:none;overflow:visible;background:color-mix(in srgb,var(--amber-bg) 55%,var(--panel));border-radius:4px;padding:6px 8px;opacity:.8}
/* web_search 回答的来源出处：跟在正文后面的一排脚注 chip。 */
.citations{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:7px}
.citations-k{font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--faint)}
.citation{font-family:var(--mono);font-size:10.5px;color:var(--cyan);text-decoration:none;background:var(--cyan-bg);border-radius:4px;padding:2px 7px;max-width:46ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a.citation:hover{background:color-mix(in srgb,var(--cyan-bg) 70%,var(--cyan));color:var(--panel)}
.xml-fold{margin:0}
.xml-fold-sum{cursor:pointer;list-style:none;font:inherit;color:inherit;user-select:none}
.xml-fold-sum::-webkit-details-marker{display:none}
.xml-tag{font:inherit;color:var(--cyan);font-weight:600}
.xml-tag .xml-attr{color:var(--faint);margin-left:0;font-weight:400}
.xml-meta{color:var(--faint);font:inherit;margin-left:6px}
.xml-fold-body{font:inherit;line-height:inherit;white-space:pre-wrap;word-break:break-word;color:inherit;padding:0;margin:0}
.xml-tag-close{display:none}
.xml-fold.env-context{margin:2px 0;background:var(--soft);border-radius:var(--radius-sm);padding:9px 11px}
.env-context>.xml-fold-sum{display:flex;align-items:baseline;gap:7px;min-width:0}
.env-context>.xml-fold-sum::before{content:'▶';flex:0 0 auto;font-size:8px;color:var(--faint);transition:transform .14s}
.env-context[open]>.xml-fold-sum::before{transform:rotate(90deg)}
.env-context>.xml-fold-sum>.xml-tag{color:var(--muted);font-weight:650}
.env-context>.xml-fold-sum>.xml-meta{margin-left:auto;white-space:nowrap}
.env-context>.xml-fold-body{padding:10px 1px 1px;white-space:normal}
.env-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px 24px}
.env-fact{min-width:0}.env-fact-k{display:block;margin-bottom:2px;font-size:10px;color:var(--faint)}
.env-fact-v{display:block;font-family:var(--mono);font-size:11.5px;color:var(--text);white-space:pre-wrap;word-break:break-word}
.env-file{margin-top:10px;padding-top:8px;border-top:1px solid var(--line-faint)}
.env-file-sum{display:flex;align-items:baseline;gap:7px;cursor:pointer;list-style:none;min-width:0}
.env-file-sum::-webkit-details-marker{display:none}.env-file-sum::before{content:'▶';flex:0 0 auto;font-size:8px;color:var(--faint);transition:transform .14s}.env-file[open]>.env-file-sum::before{transform:rotate(90deg)}
.env-file-k{font-size:11.5px;font-weight:650;color:var(--muted)}.env-file-meta{margin-left:auto;font-size:10.5px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.env-file-body{display:flex;flex-direction:column;gap:6px;padding:9px 0 2px 15px}
.env-file-row{display:grid;grid-template-columns:58px minmax(0,1fr);gap:10px;align-items:baseline;min-width:0}.env-file-label{font-size:10px;color:var(--faint)}.env-file-value{font-family:var(--mono);font-size:11.5px;color:var(--text);white-space:pre-wrap;word-break:break-word}
@media(max-width:760px){.env-facts{grid-template-columns:1fr}.env-context>.xml-fold-sum>.xml-meta,.env-file-meta{white-space:normal;text-align:right}}
.content-image{max-width:100%;max-height:420px;border-radius:var(--radius-sm);border:1px solid var(--line2);display:block}
.codebox{font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;word-break:break-word;background:var(--soft);border-radius:var(--radius-sm);padding:9px 11px;color:var(--muted);overflow:visible;max-height:none}
.sse-group,.sse-row{border-bottom:1px solid var(--line2);font-family:var(--mono);font-size:11px}.sse-group:last-child,.sse-row:last-child{border-bottom:0}.sse-sum,.sse-group-sum{display:grid;grid-template-columns:78px clamp(160px,30%,220px) minmax(0,1fr) 78px;gap:12px;align-items:baseline;padding:6px 0;cursor:pointer;list-style:none;user-select:none;border-radius:3px}.sse-sum::-webkit-details-marker,.sse-group-sum::-webkit-details-marker{display:none}.sse-sum:focus,.sse-group-sum:focus{outline:none}.sse-sum:focus-visible,.sse-group-sum:focus-visible{outline:1px solid var(--focus-line);outline-offset:-1px}.sse-sum:hover,.sse-group-sum:hover{background:color-mix(in srgb,var(--hover) 42%,transparent)}.sse-row .ev,.sse-group .ev{color:var(--cyan);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.sse-group-sum .ev{color:var(--blue)}.sse-row .tm,.sse-group .tm{color:var(--faint)}.sse-peek{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.sse-size{color:var(--faint);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.sse-row[open] .sse-sum,.sse-group[open] .sse-group-sum{border-bottom:1px solid var(--line2);border-radius:3px 3px 0 0}.sse-row[open] .sse-peek,.sse-group[open] .sse-peek{color:var(--text)}.sse-group-body{padding-left:8px;border-left:1px solid var(--line2);margin:0 0 6px 10px}.sse-row.sse-child .sse-sum{grid-template-columns:60px clamp(160px,30%,220px) minmax(0,1fr) 78px;padding:5px 0}.sse-row .sse-data{display:block;margin:0;padding:8px 0 10px 90px;max-height:none;white-space:pre-wrap;word-break:break-word;overflow:visible}.sse-row.sse-child .sse-data{padding-left:72px}.sse-row:not([open])>.sse-data,.sse-group:not([open])>.sse-group-body{display:none}
.empty{color:var(--faint);text-align:center;padding:58px 16px}.msg-empty{color:var(--faint);font-style:italic;font-size:12px;padding:2px 0}.trace-json{margin-top:2px}
/* System 区已展示过的段落：留位置和角色，正文换成一行指引，不重复渲染几十 KB。 */
.msg-echo{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;color:var(--faint);font-size:12px;background:var(--soft);border-radius:var(--radius-sm);padding:7px 10px}
.msg-echo-meta{font-family:var(--mono);font-size:10.5px}
.detail-loading{display:flex;align-items:center;justify-content:center;gap:10px;color:var(--faint);padding:58px 16px;font-size:13px}
.detail-loading::before{content:"";width:14px;height:14px;border-radius:999px;border:2px solid var(--line);border-top-color:var(--blue);animation:xwxspin .8s linear infinite}
@keyframes xwxspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.detail-loading::before{animation:none;border-top-color:var(--line)}}
.json-tree{font-family:var(--mono);font-size:11.5px;color:var(--muted);line-height:1.56}.json-node{margin-left:14px}.json-node:first-child{margin-left:0}.json-node summary{cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.json-node summary:hover{color:var(--text)}.json-leaf{margin-left:14px;white-space:pre-wrap;word-break:break-word}.json-key{color:var(--blue);font-weight:700}.json-string{color:var(--green)}.json-num{color:var(--amber)}.json-bool{color:var(--violet);font-weight:700}.json-null{color:var(--faint);font-style:italic}.json-count{color:var(--faint)}
.log-field-fold{min-width:0}.json-log-field{margin-left:14px}.log-field-fold>summary{display:flex;align-items:baseline;gap:6px;cursor:pointer;list-style:none;user-select:none;min-width:0}.log-field-fold>summary::-webkit-details-marker{display:none}.log-field-fold>summary::before{content:'▶';flex:0 0 auto;font-size:8px;color:var(--faint);transition:transform .14s}.log-field-fold[open]>summary::before{transform:rotate(90deg)}.log-field-fold>summary:hover{color:var(--text)}.log-field-preview{color:var(--green)}.log-item-summary{color:var(--muted);font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.log-item-link{flex:0 0 auto;font-family:var(--mono);font-size:8.5px;font-weight:750;letter-spacing:.05em;color:var(--faint)}.log-item-message>summary .log-item-summary{font-weight:750;color:var(--text)}.log-item-message-user>summary .log-item-summary{color:var(--blue)}.log-item-message-developer>summary .log-item-summary,.log-item-message-system>summary .log-item-summary{color:var(--violet)}.log-item-message-assistant>summary .log-item-summary{color:var(--green)}.log-item-reasoning>summary .log-item-summary{color:var(--amber);font-weight:500}.log-item-tool-call>summary .log-item-summary{color:var(--cyan);font-weight:600}.log-item-tool-call>summary .log-item-link{color:var(--cyan)}.log-item-tool-result>summary .log-item-summary{color:var(--amber);font-weight:550}.log-item-tool-result>summary .log-item-link{color:var(--amber)}.log-item-tool-definition>summary .log-item-summary{color:var(--faint);font-weight:550}.log-field-content{margin:6px 0 3px 14px;padding:10px 12px;max-height:420px;overflow:auto;border-left:1px solid var(--line);background:var(--soft);font:inherit;line-height:1.55}.log-field-content:empty::before{content:'Loading…';color:var(--faint)}.log-field-pre{margin:0;color:var(--green);white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:inherit}.json-log-field>.log-field-content{margin:2px 0 0 14px;padding:0;max-height:none;overflow:visible;border:0;background:transparent}.json-log-field>.log-field-content:empty::before{display:none}.pp-log-field{align-self:start}.pp-log-field>summary::before{display:none}.pp-log-field>summary{gap:6px;color:var(--faint);font-size:11px}.pp-log-field[open]>summary .pp-tw{transform:rotate(90deg)}.pp-log-field>.log-field-content{margin:2px 0 0;padding:0 0 0 14px;max-height:none;overflow:visible;border:0;border-left:1px dashed var(--line2);background:transparent}.pp-log-field>.log-field-content:empty::before{display:none}
.overlay{position:fixed;inset:0;background:rgba(43,42,38,.28);display:none;align-items:center;justify-content:center;z-index:10;padding:30px}.overlay.on{display:flex}.modal{width:min(1040px,94vw);max-height:88vh;background:var(--panel);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden}.mh{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line2);padding:12px 16px}.mh .title{font-weight:650}.close{margin-left:auto;border:0;background:transparent;color:var(--faint);border-radius:8px;width:36px;height:36px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background .14s,color .14s}.close svg{display:block}.close:hover{background:var(--hover);color:var(--text)}.mb{overflow:auto;padding:16px 20px}
/* Diff overlay */
.diff-pick{display:flex;align-items:center;gap:8px;min-width:0}
.diff-nav{border:1px solid var(--line);background:var(--panel);color:var(--muted);border-radius:6px;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.diff-nav svg{display:block}
.diff-nav:hover{background:var(--hover);color:var(--text)}
.diff-nav:disabled{opacity:.35;cursor:default}
.diff-nav:disabled:hover{background:var(--panel);color:var(--muted)}
.diff-base-wrap{position:relative;display:inline-flex}
.diff-base{appearance:none;-webkit-appearance:none;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:6px;padding:4px 24px 4px 10px;font-size:12px;font-family:inherit;cursor:pointer}
.diff-base:hover{background:var(--hover)}
.diff-base-caret{position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--faint);font-size:9px}
.diff-cur{font-size:12px;color:var(--muted);background:var(--soft);border-radius:6px;padding:4px 10px;white-space:nowrap}
.diff-section{border:1px solid var(--line2);border-radius:var(--radius);margin-bottom:14px;background:var(--panel);overflow:hidden}
.diff-section-header{display:flex;align-items:center;gap:8px;padding:10px 14px;font-weight:650;font-size:13px;border-bottom:1px solid var(--line2);background:color-mix(in srgb,var(--panel) 88%,var(--soft));list-style:none}
summary.diff-section-header{cursor:pointer;user-select:none}
summary.diff-section-header::-webkit-details-marker{display:none}
.diff-section:not([open])>summary.diff-section-header{border-bottom:0}
.diff-section-header.static{border-bottom:0}
.diff-section-tw{display:inline-block;width:10px;flex:0 0 auto;color:var(--faint);font-size:10px;transition:transform .14s}
.diff-section[open]>summary .diff-section-tw{transform:rotate(90deg)}
.diff-section-title{display:inline-flex;align-items:center;gap:8px;min-width:0}
.diff-section-body{padding:12px 14px}
.diff-unchanged-bar{display:flex;align-items:center;gap:8px;background:var(--soft);border-radius:var(--radius-sm);padding:7px 10px;color:var(--faint);font-size:12px;margin:6px 0}
.diff-unchanged-bar strong{color:var(--text);font-family:var(--mono)}
.dub-dot{width:6px;height:6px;border-radius:50%;background:var(--faint);display:inline-block}
.diff-empty{color:var(--faint);text-align:center;padding:14px;font-size:12px}
.ds-badge{display:inline-flex;align-items:center;font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.ds-badge.add{color:var(--green)}
.ds-badge.del{color:var(--red)}
.ds-badge.change{color:var(--amber)}
.ds-badge.same{color:var(--faint)}
.diff-msg-card{border-radius:var(--radius-sm);margin:8px 0;overflow:hidden;background:var(--soft)}
.diff-msg-card.add{background:color-mix(in srgb,var(--green-bg) 45%,var(--panel))}
.diff-msg-card.del{background:color-mix(in srgb,var(--red-bg) 45%,var(--panel))}
.diff-msg-card.change{background:var(--soft)}
.diff-msg-head{display:flex;align-items:center;gap:8px;padding:7px 11px;border-bottom:1px solid var(--line-faint);font-size:11px}
.diff-msg-body{padding:10px 12px}
/* 整条增删 / 逐行修改都统一进 OLD|NEW 左右框；缺失侧渲染空态斜纹。 */
.diff-sbs{display:grid;grid-template-columns:1fr 1fr;border-radius:var(--radius-sm);overflow:hidden;background:var(--panel)}
.diff-sbs-side{min-width:0}
.diff-sbs-side+.diff-sbs-side{border-left:1px solid var(--line2)}
.diff-sbs-h{padding:5px 10px;color:var(--faint);font-weight:700;font-size:10px;letter-spacing:.06em;font-family:var(--mono)}
.diff-sbs-body{padding:8px 10px;min-width:0;overflow-wrap:anywhere}
.diff-sbs-side.add .diff-sbs-body{background:color-mix(in srgb,var(--green-bg) 30%,transparent)}
.diff-sbs-side.del .diff-sbs-body{background:color-mix(in srgb,var(--red-bg) 30%,transparent)}
.diff-sbs-side.empty{background:repeating-linear-gradient(135deg,transparent 0 6px,color-mix(in srgb,var(--line2) 50%,transparent) 6px 7px)}
.diff-sbs-side.empty .diff-sbs-body{color:var(--faint);font-family:var(--mono);font-size:11px;font-style:italic}
.diff-param-change{border-radius:var(--radius-sm);margin:7px 0;overflow:hidden;background:var(--soft)}
.diff-param-change>summary{display:flex;align-items:center;gap:8px;padding:8px 11px;cursor:pointer;list-style:none;font-size:12px}
.diff-param-change>summary::-webkit-details-marker{display:none}
.diff-param-key{font-family:var(--mono);color:var(--blue);font-weight:700;font-size:12px}
.diff-param-body{padding:10px 12px;border-top:1px solid var(--line-faint)}
.diff-tool-detail{border-radius:var(--radius-sm);margin:6px 0;overflow:hidden;background:var(--soft)}
.diff-tool-detail>summary{display:flex;align-items:center;gap:8px;padding:7px 11px;cursor:pointer;list-style:none;font-size:12px}
.diff-tool-detail>summary::-webkit-details-marker{display:none}
.diff-tool-name{font-family:var(--mono);color:var(--cyan);font-weight:700}
.diff-tool-body{padding:10px 12px;border-top:1px solid var(--line-faint)}
.diff-tool-desc{color:var(--muted);margin-bottom:8px;font-size:12px}
.diff-tool-json{font-family:var(--mono);font-size:11px;background:var(--bg);border-radius:4px;padding:8px 10px;max-height:none;overflow:visible;color:var(--muted);white-space:pre-wrap;word-break:break-word}
/* 行号列贴在各自文本列左侧：OLD 行号|OLD 文本|NEW 行号|NEW 文本。分列竖线挂在 NEW 行号上。 */
.sbs-diff{display:grid;grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr);border-radius:var(--radius-sm);overflow:hidden;font-family:var(--mono);font-size:11.5px;background:var(--panel)}
.sbs-header{padding:5px 10px;background:transparent;color:var(--faint);font-weight:700;font-size:10px;letter-spacing:.06em}
.sbs-header.old{grid-column:1/3}
.sbs-header.new{grid-column:3/5;border-left:1px solid var(--line2)}
.sbs-ln{padding:3px 6px 3px 10px;color:var(--faint);text-align:right;user-select:none;font-variant-numeric:tabular-nums}
.sbs-ln.new{border-left:1px solid var(--line2)}
.sbs-ln.del{background:color-mix(in srgb,var(--red-bg) 70%,transparent)}
.sbs-ln.add{background:color-mix(in srgb,var(--green-bg) 70%,transparent)}
.sbs-ln.empty{background:repeating-linear-gradient(135deg,transparent 0 6px,color-mix(in srgb,var(--line2) 50%,transparent) 6px 7px)}
.sbs-cell{padding:3px 10px 3px 6px;white-space:pre-wrap;word-break:break-word;line-height:1.55}
.sbs-cell.ctx{color:var(--muted)}
.sbs-cell.del{background:color-mix(in srgb,var(--red-bg) 70%,transparent);color:var(--red)}
.sbs-cell.add{background:color-mix(in srgb,var(--green-bg) 70%,transparent);color:var(--green)}
.sbs-cell.empty{background:repeating-linear-gradient(135deg,transparent 0 6px,color-mix(in srgb,var(--line2) 50%,transparent) 6px 7px)}
.sbs-fold{grid-column:1/-1;padding:5px 10px;color:var(--faint);font-size:11px;background:var(--soft);text-align:center}
.sbs-hi-del{background:color-mix(in srgb,var(--red) 26%,transparent);border-radius:2px;padding:0 1px}
.sbs-hi-add{background:color-mix(in srgb,var(--green) 26%,transparent);border-radius:2px;padding:0 1px}
.sbs-empty{color:var(--faint);text-align:center;padding:18px;font-size:12px}
/* JSON 值走结构化 diff：字段路径|OLD 值|NEW 值。插入一个字段不会让后面的字段全部标成改动。 */
.diff-kv{display:grid;grid-template-columns:minmax(120px,.75fr) minmax(0,1fr) minmax(0,1fr);border-radius:var(--radius-sm);overflow:hidden;font-family:var(--mono);font-size:11.5px;background:var(--panel)}
.diff-kv-h{padding:5px 10px;color:var(--faint);font-weight:700;font-size:10px;letter-spacing:.06em}
.diff-kv-h.old,.diff-kv-h.new{border-left:1px solid var(--line2)}
.diff-kv-path{padding:3px 10px;color:var(--blue);font-weight:700;word-break:break-all;line-height:1.55}
.diff-kv-cell{padding:3px 10px;white-space:pre-wrap;word-break:break-word;line-height:1.55;border-left:1px solid var(--line2)}
.diff-kv-cell.del{background:color-mix(in srgb,var(--red-bg) 70%,transparent);color:var(--red)}
.diff-kv-cell.add{background:color-mix(in srgb,var(--green-bg) 70%,transparent);color:var(--green)}
.diff-kv-cell.empty{background:repeating-linear-gradient(135deg,transparent 0 6px,color-mix(in srgb,var(--line2) 50%,transparent) 6px 7px);color:var(--faint);font-style:italic}
.diff-kv-long{grid-column:1/-1;padding:0 10px 8px}
.diff-kv-long>.sbs-diff{border:1px solid var(--line2)}
.diff-kv-longpath{grid-column:1/-1;padding:7px 10px 3px;color:var(--blue);font-weight:700;word-break:break-all}
.diff-kv-more{grid-column:1/-1;padding:5px 10px;color:var(--faint);font-size:11px;background:var(--soft);text-align:center}
.search-result{padding:9px 0;border-bottom:1px solid var(--line2);cursor:pointer}.search-result:hover{background:var(--hover)}.search-result:focus-visible{outline:2px solid var(--blue);outline-offset:-2px;background:var(--hover)}.search-result .where{font-family:var(--mono);font-size:11px;color:var(--faint)}mark{background:var(--amber-bg);color:var(--amber);padding:0 2px;border-radius:2px}
@media(max-width:820px){.rail{width:220px}.sse-sum,.sse-group-sum,.sse-row.sse-child .sse-sum{grid-template-columns:1fr}.sse-group-body{padding-left:0;margin-left:0;border-left:0}.sse-row .sse-data,.sse-row.sse-child .sse-data{padding-left:0;white-space:pre-wrap}.sse-size{text-align:left}.generated{display:none}}
 .crumbs{display:flex;align-items:center;gap:9px;color:var(--faint);font-size:13px;min-width:0}
 .return-control{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;min-height:30px;padding:0 7px 0 4px;border:0;border-radius:6px;background:transparent;color:var(--muted);font:inherit;cursor:pointer;white-space:nowrap;transition:background .14s ease,color .14s ease}
 .return-control:hover{background:var(--hover);color:var(--text)}
 .return-control:focus-visible{outline:2px solid var(--focus-ring);outline-offset:1px}
 .return-control svg{width:15px;height:15px;display:block;flex:0 0 auto}
 .return-divider{width:1px;height:16px;flex:0 0 auto;background:var(--line2)}
 .crumbs .seg{display:inline-flex;align-items:center;gap:8px;color:var(--faint);background:transparent;border:0;font:inherit;padding:0;cursor:default}
.crumbs .seg.link{cursor:pointer;color:var(--muted)}
.crumbs .seg.link:hover{color:var(--text)}
.crumbs .seg.current{color:var(--text);font-weight:600;max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crumbs .seg.sep{color:var(--faint);gap:0;opacity:.85}
.crumbs .seg.sep svg{display:block}
.app[data-view="dashboard"] .rail{display:none}
.dash{max-width:1200px;margin:0 auto;padding:8px 24px 32px}
.dash-hero{display:flex;align-items:flex-end;gap:40px;padding-bottom:24px;border-bottom:1px solid var(--line);margin-bottom:0;flex-wrap:wrap;row-gap:18px}
.dash-hero-main{flex:0 0 auto;cursor:pointer;border-radius:8px;margin:-8px -12px;padding:8px 12px;transition:background .12s}
.dash-hero-main:hover{background:var(--hover)}
.dash-hero-label{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:8px}
.dash-hero-num{font-family:var(--mono);font-size:64px;font-weight:600;letter-spacing:-.03em;line-height:.9;color:var(--text);font-variant-numeric:tabular-nums}
.dash-hero-num .u{font-size:24px;color:var(--faint);font-weight:500;margin-left:6px}
.dash-hero-side{flex:1;display:flex;gap:0;align-items:stretch;justify-content:flex-end;min-width:0}
.dash-hero-stat{padding:0 26px;text-align:right;border-left:1px solid var(--line2)}
.dash-hero-stat:first-child{border-left:0}
.dash-hs-label{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:700;margin-bottom:8px}
.dash-hs-val{font-family:var(--mono);font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1;color:var(--text)}
.dash-hs-val.ok{color:var(--green)}
.dash-hs-val.err{color:var(--red)}
.src-tag{display:inline-flex;align-items:center;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;font-family:var(--mono)}
.src-tag.src-copilot{color:var(--blue)}
.src-tag.src-claude-cli{color:var(--amber)}
.src-tag.src-claude-vscode{color:var(--amber)}
.src-tag.src-codex-cli{color:var(--green)}
.src-tag.src-codex-vscode{color:var(--green)}
.src-tag.src-unknown{color:var(--faint)}
.dash-matrix-wrap{margin:22px 0 0;border:1px solid var(--line2);border-radius:var(--radius);background:var(--panel);overflow-x:auto}
.dash-matrix{width:100%;border-collapse:separate;border-spacing:0}
.dash-matrix thead th{text-align:right;font-size:11px;color:var(--faint);font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:9px 12px;background:var(--bg);border-bottom:1px solid var(--line2);white-space:nowrap}
.dash-matrix thead th:first-child{text-align:left}
.dash-matrix tbody td{padding:9px 12px;border-bottom:1px solid var(--line2);font-size:12px;font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;color:var(--text);white-space:nowrap}
.dash-matrix tbody td:first-child{text-align:left;color:var(--cyan)}
.dash-matrix tbody tr:last-child td{border-bottom:0}
.dash-matrix tfoot td{padding:9px 12px;font-size:12px;font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;color:var(--text);font-weight:650;background:var(--bg);border-top:1px solid var(--line)}
.dash-matrix tfoot td:first-child{text-align:left}
.dash-matrix .cost-na{color:var(--faint);font-weight:400}
.dash-matrix-note{padding:8px 12px;font-size:11px;color:var(--faint);border-top:1px solid var(--line2);font-family:var(--sans)}
.dash-matrix-note .note-link{border:0;background:transparent;padding:0;margin-left:6px;font-size:11px;color:var(--muted);cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-family:var(--sans)}
.dash-matrix-note .note-link:hover{opacity:.8}
/* Chromium resolves sticky top against the scroll container's content box,
   so .mb's 16px top padding would leave a strip above the stuck header where
   rows keep painting. Drop the container's top padding here and put the same
   spacing on the first child, which scrolls away normally. */
#pricingBody{padding-top:0}
#pricingBody>:first-child{margin-top:16px}
.pricing-table{width:100%;border-collapse:separate;border-spacing:0}
.pricing-table th{text-align:right;font-size:11px;color:var(--faint);font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:8px 12px;border-bottom:1px solid var(--line2);white-space:nowrap;position:sticky;top:0;z-index:1;background:var(--panel)}
.pricing-table th:first-child,.pricing-table td:first-child{text-align:left}
.pricing-table td{padding:7px 12px;border-bottom:1px solid var(--line2);font-size:12px;font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.pricing-table td:first-child{color:var(--cyan)}
.pricing-table .proto{color:var(--faint);font-size:11px}
/* Source and status are the only prose columns. With 80 rows the vertical
   scrollbar takes enough width that nowrap on them overflows the 1280px
   dialog; the numeric columns stay nowrap so the digits keep aligning. */
.pricing-table td:nth-child(3),.pricing-table td:nth-child(9){white-space:normal}
/* Below ~1180px the nine columns cannot fit and the dialog scrolled sideways.
   Protocol and source are the two the reader can recover from the model id and
   the row tooltip, so they fold away first and the rates stay visible. */
@media (max-width:1180px){
  .pricing-table th:nth-child(2),.pricing-table td:nth-child(2),
  .pricing-table th:nth-child(3),.pricing-table td:nth-child(3){display:none}
}
/* Narrower still: the 1h cache-write column is a dash for everything except
   Anthropic, so it is the next cheapest to fold. */
@media (max-width:960px){
  .pricing-table th:nth-child(8),.pricing-table td:nth-child(8){display:none}
}
.pricing-note{margin-top:10px;font-size:11px;color:var(--faint);line-height:1.6;font-family:var(--sans)}
.dash-table-wrap{overflow-x:auto;border:1px solid var(--line2);border-radius:var(--radius);background:var(--panel);scrollbar-gutter:auto}
.dash-table{width:100%;min-width:0;border-collapse:separate;border-spacing:0;table-layout:fixed}
.dash-table thead th{position:relative;text-align:left;font-size:11px;color:var(--faint);font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:10px 12px;background:var(--bg);border-bottom:1px solid var(--line2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-table thead th.num{text-align:right}
.dash-table tbody td{padding:14px 12px;border-bottom:1px solid var(--line2);font-size:13.5px;color:var(--muted);vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dash-table tbody tr:last-child td{border-bottom:0}
.dash-table tbody tr{cursor:pointer;transition:background .12s}
.dash-table tbody tr:hover{background:var(--hover)}
.dash-table tbody tr:focus-visible{outline:2px solid var(--blue);outline-offset:-2px;background:var(--hover)}
.dash-table thead th.col-src,.dash-table tbody td.col-src{text-align:center}
.dash-time{font-family:var(--mono);font-size:12px;white-space:nowrap;color:var(--muted)}
.dash-table thead th:nth-child(2),.dash-table tbody td.dash-first{width:158px;max-width:158px}
.dash-first{color:var(--text);font-size:13.5px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dash-first .dash-first-meta{display:none;font-family:var(--mono);font-size:10.5px;color:var(--faint);font-weight:400;margin-top:2px;letter-spacing:0;text-transform:none}
.dash-num{font-family:var(--mono);text-align:right;font-variant-numeric:tabular-nums;color:var(--text)}
.dash-dur{color:var(--green);white-space:nowrap}
.dash-cost{font-family:var(--mono);text-align:right;font-variant-numeric:tabular-nums;color:var(--text);white-space:nowrap}
.dash-cost.cost-na{color:var(--faint)}
.dash-model{font-family:var(--mono);color:var(--cyan)}
.dash-agent{color:var(--muted)}
.dash-table thead th.col-status,.dash-table tbody td.col-status{text-align:center}
.dash-table tbody td.col-status{position:relative}
.dash-status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding-bottom:1px;font-size:10.5px;font-weight:700;letter-spacing:.04em;line-height:1}
.dash-status.live{color:var(--green)}
.dash-status.ok{color:var(--blue)}
.dash-status.err{color:var(--red)}
.dash-table thead th.col-del,.dash-table tbody td.dash-del{width:4.75rem;min-width:4.75rem;text-align:center;padding:10px 16px 10px 10px}
td.dash-del{padding:0 16px 0 10px}
.dash-table .col-spacer{width:auto;padding:0;border:0}
.dash-table thead th .col-resizer{position:absolute;top:0;right:-4px;width:8px;height:100%;cursor:col-resize;z-index:2}
.dash-table thead th .col-resizer::after{content:"";position:absolute;inset:10px 3px;border-radius:999px;background:transparent;transition:background .12s}
.dash-table thead th .col-resizer:hover::after,.dash-table-wrap.is-col-resizing .col-resizer.active::after{background:color-mix(in srgb,var(--blue) 55%,transparent)}
.dash-table-wrap.is-col-resizing,.dash-table-wrap.is-col-resizing *{cursor:col-resize;user-select:none}
.dash-table-wrap.is-col-resizing tbody tr{cursor:col-resize}
.del-btn{border:0;background:transparent;color:var(--faint);width:32px;height:32px;border-radius:var(--radius-sm);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;opacity:.42;transition:opacity .14s var(--ease),background .12s,color .12s,transform .08s}
.dash-table tbody tr:hover .del-btn,.dash-table tbody tr:focus-within .del-btn{opacity:.85}
.del-btn:hover{opacity:1;background:var(--red-bg);color:var(--red)}
.del-btn:focus-visible{outline:2px solid var(--red);outline-offset:1px;opacity:1}
.del-btn:active{transform:scale(.94)}
.del-btn svg{display:block}
.dash-table tbody tr.removing{animation:rowOut .28s var(--ease) forwards;pointer-events:none}
@keyframes rowOut{to{opacity:0;transform:translateX(-8px)}}
.modal.confirm{width:min(420px,94vw);max-height:none}
.modal.confirm .mh{border-bottom:0;padding:18px 20px 0}
.modal.confirm .mh svg{flex:0 0 auto;margin-top:1px;color:var(--red)}
.modal.confirm .body{padding:8px 20px 20px;color:var(--muted);font-size:13px;line-height:1.6}
.modal.confirm .body code{font-family:var(--mono);font-size:11.5px;background:var(--soft);padding:1px 5px;border-radius:4px;color:var(--text)}
.modal.confirm .actions{display:flex;justify-content:flex-end;gap:10px;padding:0 20px 18px}
.modal.confirm .btn{border:1px solid var(--line2);background:var(--panel);color:var(--muted);font:inherit;font-size:13px;font-weight:500;padding:0 14px;height:34px;border-radius:var(--radius-sm);cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .12s,color .12s,border-color .12s}
.modal.confirm .btn:hover{background:var(--hover);color:var(--text)}
.modal.confirm .btn:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.modal.confirm .btn.danger{background:var(--red);border-color:var(--red);color:#fff}
.modal.confirm .btn.danger:hover{background:color-mix(in srgb,var(--red) 88%,#000)}
.modal.confirm .btn.danger:focus-visible{outline:2px solid var(--red);outline-offset:1px}
.modal.wide{width:min(1280px,96vw)}
@media(max-width:820px){
  .dash-hero{gap:20px}
  .dash-hero-num{font-size:48px}
  .dash-hero-side{justify-content:flex-start}
  .dash-hero-stat{padding:0 16px}
  .dash-table .col-model,.dash-table .col-agent{display:none}
  .dash-first .dash-first-meta{display:block}
  .dash-first{max-width:100%;white-space:nowrap}
}
.dash-empty{padding:48px 16px;text-align:center;color:var(--faint)}
.rail-head{position:relative;padding:9px 8px 5px 12px;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;min-width:0}
.rail-head .rh-title{font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.rail-head .rail-collapse{position:relative;right:auto;top:auto;z-index:6;flex:0 0 auto;width:48px;height:44px;margin:-6px -8px -6px 0;border:0;border-radius:9px;background:transparent;color:color-mix(in srgb,var(--muted) 78%,var(--rail-bg));cursor:pointer;font-size:0;line-height:1;padding:0;display:inline-flex;align-items:center;justify-content:center;box-shadow:none;transition:background .14s,color .14s,transform .08s}
.rail-head .rail-collapse::before{display:none}
.rail-head .rail-collapse svg{display:block;position:relative;z-index:1}
.rail-head .rail-collapse:hover{background:color-mix(in srgb,var(--panel) 34%,var(--rail-hover));color:var(--text)}
.rail-head .rail-collapse:active{transform:translateY(1px)}
.rail-head .rail-collapse:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
/* 窄态不完全隐藏：默认数字栏，边脊/刻度/摘要脊保留为可实验状态。 */
.app[data-rail="mini"]{--rail-live-w:var(--rail-mini-w)}
.app[data-rail="spine"]{--rail-live-w:var(--rail-spine-w)}
.app[data-rail="ticks"]{--rail-live-w:var(--rail-ticks-w)}
.app[data-rail="summary"]{--rail-live-w:var(--rail-summary-w)}
.app[data-rail="mini"] .rail{width:var(--rail-mini-w)}
.app[data-rail="spine"] .rail{width:var(--rail-spine-w)}
.app[data-rail="ticks"] .rail{width:var(--rail-ticks-w)}
.app[data-rail="summary"] .rail{width:var(--rail-summary-w)}
.app[data-rail="mini"] .rail-head,.app[data-rail="spine"] .rail-head,.app[data-rail="ticks"] .rail-head,.app[data-rail="summary"] .rail-head{padding:8px 0 6px;justify-content:center;border-bottom-color:transparent}
.app[data-rail="mini"] .rail-head .rh-title,.app[data-rail="spine"] .rail-head .rh-title,.app[data-rail="ticks"] .rail-head .rh-title,.app[data-rail="summary"] .rail-head .rh-title{display:none}
.app[data-rail="mini"] .rail-head .rail-collapse,.app[data-rail="spine"] .rail-head .rail-collapse,.app[data-rail="ticks"] .rail-head .rail-collapse,.app[data-rail="summary"] .rail-head .rail-collapse{position:relative;right:auto;top:auto;width:34px;height:34px;margin:-3px 0;color:var(--faint);background:transparent;box-shadow:none}
.app[data-rail="mini"] .rail-head .rail-collapse:hover,.app[data-rail="spine"] .rail-head .rail-collapse:hover,.app[data-rail="ticks"] .rail-head .rail-collapse:hover,.app[data-rail="summary"] .rail-head .rail-collapse:hover{background:var(--rail-hover);color:var(--text)}
.app[data-rail="mini"] .progress,.app[data-rail="spine"] .progress,.app[data-rail="ticks"] .progress,.app[data-rail="summary"] .progress{display:none}
.app[data-rail="mini"] .sagroup,.app[data-rail="spine"] .sagroup,.app[data-rail="ticks"] .sagroup,.app[data-rail="summary"] .sagroup{margin:0;border:0;border-radius:0;background:transparent;overflow:visible}
.app[data-rail="mini"] .sabody,.app[data-rail="spine"] .sabody,.app[data-rail="ticks"] .sabody,.app[data-rail="summary"] .sabody{grid-template-rows:1fr;transition:none}
.app[data-rail="mini"] .sahead,.app[data-rail="spine"] .sahead,.app[data-rail="ticks"] .sahead{display:none}
.app[data-rail="mini"] .sabody,.app[data-rail="spine"] .sabody,.app[data-rail="ticks"] .sabody,.app[data-rail="summary"] .sabody{display:block;border-left:0}
.app[data-rail="mini"] .list,.app[data-rail="summary"] .list{padding:4px 0 12px}
.app[data-rail="mini"] .row,.app[data-rail="mini"] .sabody .row{margin:0;padding:0;min-height:34px;height:34px;display:flex;align-items:center;justify-content:center;border-left:0;border-radius:0;background:transparent;box-shadow:none;transform:none}
.app[data-rail="mini"] .row .r1,.app[data-rail="mini"] .row .r2{display:none}
.app[data-rail="mini"] .row::before{content:attr(data-turn);position:static;opacity:1;width:auto;transform:none;background:none;border-radius:0;display:flex;align-items:center;justify-content:center;color:var(--req-color,var(--muted));font-family:var(--mono);font-size:12px;font-weight:750;transition:color .12s}
.app[data-rail="mini"] .row:hover{background:var(--rail-hover)}
.app[data-rail="mini"] .row:hover::before{color:var(--req-color,var(--text))}
.app[data-rail="mini"] .row.on{background:var(--panel);box-shadow:none}
.app[data-rail="mini"] .row.on::before{color:var(--req-color,var(--text));font-weight:800}
.app[data-rail="spine"] .list{position:relative;padding:8px 0 12px}
.app[data-rail="spine"] .list::before{content:"";position:absolute;top:8px;bottom:12px;left:17px;width:1px;background:var(--spine-line)}
.app[data-rail="spine"] .row,.app[data-rail="spine"] .sabody .row{margin:0;min-height:24px;height:24px;padding:0;border-radius:0;display:block;background:transparent;box-shadow:none;transform:none}
.app[data-rail="spine"] .row .r1,.app[data-rail="spine"] .row .r2{display:none}
.app[data-rail="spine"] .row::before{content:"";display:block;position:absolute;left:11px;top:11px;width:13px;height:1px;border-radius:2px;background:var(--spine-mark)}
.app[data-rail="spine"] .row.is-special::before{left:9px;width:17px;background:var(--blue)}
.app[data-rail="spine"] .row.on::before{left:7px;width:22px;height:2px;background:var(--blue)}
.app[data-rail="ticks"] .list{position:relative;padding:7px 0 12px}
.app[data-rail="ticks"] .list::before{content:"";position:absolute;top:8px;bottom:12px;left:21px;width:1px;background:var(--spine-line)}
.app[data-rail="ticks"] .row,.app[data-rail="ticks"] .sabody .row{margin:0;min-height:28px;height:28px;padding:0;border-radius:0;display:block;background:transparent;box-shadow:none;transform:none}
.app[data-rail="ticks"] .row .r1,.app[data-rail="ticks"] .row .r2{display:none}
.app[data-rail="ticks"] .row::before{content:"";display:block;position:absolute;left:18px;top:11px;width:7px;height:7px;border-radius:999px;background:var(--panel);border:1px solid var(--spine-mark)}
.app[data-rail="ticks"] .row.is-special::before{border-color:var(--blue);background:var(--blue-bg)}
.app[data-rail="ticks"] .row.on::before{left:16px;top:9px;width:11px;height:11px;border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-bg)}
.app[data-rail="summary"] .list{padding:5px 6px 12px}
.app[data-rail="summary"] .sagroup{margin:6px 0;padding:3px 0;border-top:1px solid var(--rail-line2);border-bottom:1px solid var(--rail-line2)}
.app[data-rail="summary"] .sahead{display:flex;align-items:center;min-height:20px;padding:0 4px 2px;overflow:hidden;background:transparent;border-left:0}
.app[data-rail="summary"] .sahead .gname{max-width:54px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--faint);font-family:var(--mono);font-size:10px;font-weight:650}
.app[data-rail="summary"] .sahead .gkind,.app[data-rail="summary"] .sahead .gsum{display:none}
.app[data-rail="summary"] .sahead .gcont{gap:0;font-size:0}
.app[data-rail="summary"] .sahead .gcont::before{font-size:10px}
.app[data-rail="summary"] .row,.app[data-rail="summary"] .sabody .row{margin:0;min-height:28px;height:28px;padding:0 5px;display:flex;align-items:center;gap:5px;border-radius:6px;background:transparent;box-shadow:none;transform:none}
.app[data-rail="summary"] .row .r1,.app[data-rail="summary"] .row .r2{display:none}
.app[data-rail="summary"] .row::before{content:attr(data-turn);display:block;position:static;opacity:1;transform:none;background:none;border-radius:0;width:34px;flex:0 0 34px;color:var(--muted);font-family:var(--mono);font-size:11px;font-weight:750;text-align:right}
.app[data-rail="summary"] .row::after{content:"";width:14px;height:1px;border-radius:2px;background:var(--spine-mark)}
.app[data-rail="summary"] .row.is-special::after{height:2px;background:var(--blue)}
.app[data-rail="summary"] .row:hover{background:var(--rail-hover)}
.app[data-rail="summary"] .row.on{background:var(--panel);box-shadow:inset 0 0 0 1px var(--focus-line)}
</style>
</head>
<body>
<div class="top" id="topBar" data-view="dashboard">
  <button type="button" class="brand" id="brandHome" data-nav="dashboard" title="Trace" aria-label="Trace"><span>Trace</span></button>
  <nav class="crumbs" id="crumbs" aria-label="导航"></nav>
  <div class="top-actions">
    <div id="generatedAt" class="generated"></div>
    <button type="button" class="lang-toggle" id="langToggle" title="Switch language">中文</button>
  </div>
</div>
<div class="app" id="appRoot" data-view="dashboard">
  <aside class="rail" id="rail">
    <div class="rail-head" id="railHead"></div>
    <div class="progress"><span class="lbl"><span id="progressLabel">请求</span> <span class="cur" id="progressCur">0</span> / <span id="progressTotal">0</span></span><button type="button" class="fold-toggle" id="foldToggle" data-act="toggle-all-sub" hidden>收起全部 Subagents</button></div>
    <div class="list" id="traceList"></div>
  </aside>
  <div class="rail-resizer" id="railResizer" role="separator" aria-orientation="vertical" aria-label="拖动调整侧栏宽度" tabindex="0"></div>
  <main class="main">
    <div class="scroll" id="dashboard"></div>
    <div class="scroll" id="detail" hidden></div>
  </main>
</div>
<div class="overlay" id="searchOv"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="searchTitle"><div class="mh"><span class="title" id="searchTitle">Search current session</span><input id="globalSearch" aria-label="搜索当前会话" placeholder="Keyword" style="flex:1;border:1px solid var(--line);border-radius:6px;padding:6px 8px"><button class="close" id="searchClose" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg></button></div><div class="mb" id="searchBody"></div></div></div>
<div class="overlay" id="pricingOv"><div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="pricingTitle"><div class="mh"><span class="title" id="pricingTitle">Estimated Pricing (USD / 1M tokens)</span><button class="close" id="pricingClose" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg></button></div><div class="mb" id="pricingBody" tabindex="0"></div></div></div>
<div class="overlay" id="confirmDeleteOv"><div class="modal confirm" role="dialog" aria-modal="true" aria-labelledby="confirmDeleteTitle"><div class="mh"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg><div><div class="title" id="confirmDeleteTitle">Delete this session?</div></div></div><div class="body" id="confirmDeleteBody">This session’s full trace will be permanently deleted. This cannot be undone.</div><div class="actions"><button type="button" class="btn" id="confirmDeleteCancel">Cancel</button><button type="button" class="btn danger" id="confirmDeleteOk">Delete</button></div></div></div>
<script>${webviewCommonScript()}</script>
<script>
const LIVE_MODE = ${liveMode ? 'true' : 'false'};
const PRICE_RULES = ${priceRules};
let state = ${bootstrap};
let view = 'dashboard';
let selectedSessionId = state.currentSessionId || (state.sessions[0] && state.sessions[0].id) || '';
let logicalOrderCache = { key:'', ordered:[], meta:new Map() };
let uiLang = readLang();
let selectedId = traces().length ? traces()[traces().length - 1].id : undefined;
let sessionLoadState = {};
let sessionLoadErrors = {};
let detailMode = 'read';
let traceFormat = 'json';
let logFieldCache = { traceId:'', format:'', entries:[] };
let tokenMatrixOpen = false;
let liveConnected = !LIVE_MODE;
// 默认跟随当前会话的最新请求；用户开始操作详情后暂停，避免正在查看的
// 展开内容被下一条实时请求抢走。用户重新点选最新请求时恢复跟随。
let followLatest = true;
// 详情区指标条（上下文窗口/总耗时）展开明细的状态。
let metricsOpen = readMetricsOpen();
// 侧栏列表分批渲染：避免长 session 一次性 innerHTML 全部行卡顿。
const RAIL_BATCH = 80;
const SESSION_PAGE_SIZE = 160;
let railWinStart = 0;
let railWinEnd = 0;
let railWinDirty = true;  // 切会话/重算锚点时置 true，下一次 renderList 重建窗口
let railLoadingEdge = '';
let railLoadTimer = 0;
let railGroupsCache = [];
let inferredProviderTransitions = {};
let sessionTraceMeta = {};
let searchTimer = 0;
let searchReturnFocus = null;
let pricingReturnFocus = null;
let confirmDeleteReturnFocus = null;
const SEARCH_RESULT_LIMIT = 80;
const DETAIL_UI_CACHE_LIMIT = 24;
const detailUiCache = new Map();
const ROUTE_STATE_KEY = 'xwxTraceView';
let dashboardReturnContext = null;
// 侧栏子 Agent 块的折叠状态：记被折叠的 group key（agent + 起始 turn）。
let subagentCollapsed = {};
const sectionState = readSectionState();
const common = window.XwXWebview;
const el = common.byId;
const num = common.formatNumber;
const ms = common.formatDuration;
const positionSegThumbs = root => common.positionSegmentedThumbs(root, 'place');
const positionSegThumbsInstant = root => common.positionSegmentedThumbs(root, 'instant');
const toast = common.createToast({
  duration: 2400,
  create: () => {
    const node = document.createElement('div');
    node.id = 'toast';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.style.cssText = 'position:fixed;right:18px;bottom:18px;background:var(--text);color:var(--panel);padding:7px 11px;border-radius:7px;font-size:12px;z-index:var(--z-toast)';
    document.body.appendChild(node);
    return node;
  }
});
function readLang(){ try { return localStorage.getItem('xwxTraceLang') === 'en' ? 'en' : 'zh'; } catch { return 'zh'; } }
function writeLang(){ try { localStorage.setItem('xwxTraceLang', uiLang); } catch {} }
function L(zh, en){ return uiLang === 'zh' ? zh : en; }
function renderChromeText(){
  document.documentElement.lang = uiLang === 'zh' ? 'zh-CN' : 'en';
  const brandHome = el('brandHome');
  if(brandHome){
    brandHome.title = 'Trace';
    brandHome.setAttribute('aria-label', 'Trace');
    if(view === 'session') brandHome.removeAttribute('data-nav');
    else brandHome.setAttribute('data-nav', 'dashboard');
  }
  const crumbs = el('crumbs'); if(crumbs) crumbs.setAttribute('aria-label', L('导航', 'Navigation'));
  const railResizer = el('railResizer'); if(railResizer) railResizer.setAttribute('aria-label', L('拖动调整侧栏宽度', 'Drag to resize sidebar'));
  const btn = el('langToggle');
  if(btn){ btn.textContent = uiLang === 'zh' ? '中文' : 'EN'; btn.title = uiLang === 'zh' ? '当前语言：中文，点击切换到 English' : 'Current language: English. Click to switch to 中文'; btn.setAttribute('aria-label', btn.title); }
  const sTitle = el('searchTitle'); if(sTitle) sTitle.textContent = L('搜索当前会话', 'Search current session');
  const search = el('globalSearch'); if(search){ search.placeholder = L('输入关键词', 'Keyword'); search.setAttribute('aria-label', L('搜索当前会话', 'Search current session')); }
  const searchClose = el('searchClose'); if(searchClose){ searchClose.title = L('关闭', 'Close'); searchClose.setAttribute('aria-label', searchClose.title); }
  const pTitle = el('pricingTitle'); if(pTitle) pTitle.textContent = L('估算价目表（USD / 1M tokens）', 'Estimated Pricing (USD / 1M tokens)');
  const pricingClose = el('pricingClose'); if(pricingClose){ pricingClose.title = L('关闭', 'Close'); pricingClose.setAttribute('aria-label', pricingClose.title); }
  const pLabel = el('progressLabel'); if(pLabel) pLabel.textContent = L('请求', 'Request');
  const fold = el('foldToggle'); if(fold) fold.textContent = L('收起全部 Subagents','Collapse all Subagents');
  const cdTitle = el('confirmDeleteTitle'); if(cdTitle) cdTitle.textContent = L('删除该会话的全部 trace？','Delete this session’s full trace?');
  const cdBody = el('confirmDeleteBody'); if(cdBody) cdBody.textContent = L('会话的所有请求记录将被永久删除，此操作不可撤销。','This session’s full trace will be permanently deleted. This cannot be undone.');
  const cdCancel = el('confirmDeleteCancel'); if(cdCancel) cdCancel.textContent = L('取消','Cancel');
  const cdOk = el('confirmDeleteOk'); if(cdOk) cdOk.textContent = L('确认删除','Delete');
}

function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function j(v){ try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
const LOG_DEFERRED_PATHS = new Set([
  'request.body',
  'response.body',
  'response.snapshot',
  'sse.events',
  'sse.snapshot'
]);
const LOG_OPAQUE_KEYS = new Set([
  'rawBody',
  'encrypted_content',
  'signature',
  'file_data',
  'image_url',
  'b64_json',
  'base64',
  'bytes',
  'rawInput'
]);
const LOG_NESTED_CONTAINER_KEYS = new Set([
  'messages',
  'input',
  'tools',
  'contents',
  'content',
  'functions',
  'raw'
]);
const LOG_ITEM_ARRAY_KEYS = new Set(['messages','input','tools','contents','functions']);
const LOG_DEFAULT_CLOSED_KEYS = new Set(['content']);
const LOG_LONG_STRING_LIMIT = 16384;
const LOG_OPAQUE_STRING_LIMIT = 512;
function isDeferredLogMarker(v){ return !!(v && typeof v === 'object' && Number.isInteger(v.__xwxLogFieldFold) && typeof v.meta === 'string'); }
/**
 * Encode one path segment so the separators cannot be forged by the data.
 *
 * The previous form joined raw keys with '.', so {"a.b": 1} and {"a": {"b": 1}}
 * produced the identical key 'a.b' and expanding either node expanded both. Keys
 * containing dots are common - a tool's JSON Schema properties routinely hold
 * them. An empty key also collapsed onto the root's '$'.
 *
 * Percent-encoding is used rather than backslashes because this whole script is
 * emitted from a TypeScript template literal, where a lone backslash is an escape
 * and silently disappears.
 */
function logPathPart(part){
  if(typeof part === 'number') return '['+part+']';
  const encoded = String(part).split('%').join('%25').split('.').join('%2E').split('[').join('%5B');
  return encoded === '' ? '%00' : encoded;
}
function logFieldPath(path){
  return path.reduce((out,part) => {
    const encoded = logPathPart(part);
    if(encoded.charAt(0) === '[') return out+encoded;
    return out ? out+'.'+encoded : encoded;
  }, '');
}
function logFoldPath(path){
  return path.length ? logFieldPath(path) : '$';
}
/**
 * Attributes every Log fold carries. data-log-fold-default lets the redraw
 * snapshot store only the folds whose state diverges from their default, instead
 * of pinning every container in the tree.
 */
function logFoldAttrs(format,pathKey,defaultOpen){
  const isDefaultOpen = defaultOpen === true;
  return ' data-log-fold-path="'+esc(pathKey)+'" data-log-format="'+esc(format)+'"'
    + ' data-log-fold-default="'+(isDefaultOpen ? '1' : '0')+'"'
    + (logFoldOpen(format,pathKey,isDefaultOpen) ? ' open' : '');
}
function logFoldOpen(format,pathKey,defaultOpen){
  const trace = currentTrace();
  const cachedFolds = trace && detailUiCache.get(trace.id) && detailUiCache.get(trace.id).logFolds || {};
  const foldKey = String(format || 'json')+'|'+(pathKey == null ? '$' : String(pathKey));
  return Object.prototype.hasOwnProperty.call(cachedFolds,foldKey)
    ? !!cachedFolds[foldKey]
    : defaultOpen === true;
}
function logFieldMeta(value){
  if(typeof value === 'string') return num(value.length)+L(' 字符',' chars');
  if(Array.isArray(value)) return num(value.length)+L(' 项',' items');
  if(value && typeof value === 'object') return num(Object.keys(value).length)+L(' 个字段',' fields');
  return L('标量','scalar');
}
function logFieldKind(value){ return typeof value === 'string' ? 'string' : Array.isArray(value) ? 'array' : value && typeof value === 'object' ? 'object' : 'scalar'; }
function isLogItemPath(path){
  return typeof path[path.length - 1] === 'number'
    && LOG_ITEM_ARRAY_KEYS.has(String(path[path.length - 2] || ''));
}
function logNativeItemSummary(value){
  if(!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const type = String(value.type || (value.role ? 'message' : '') || '');
  const role = String(value.role || '');
  const name = String(value.name || value.function && value.function.name || value.action && value.action.type || '');
  const callId = String(value.call_id || value.tool_call_id || value.tool_use_id || (/call|tool|reasoning|compaction/.test(type) ? value.id || '' : '') || '');
  const parts = [];
  if(type) parts.push(type);
  if(role && role !== type) parts.push(role);
  if(name) parts.push(name);
  if(callId) parts.push(short(callId,36));
  return parts.join(' · ');
}
function logItemPresentation(value){
  if(!value || typeof value !== 'object' || Array.isArray(value)) return { itemClass:'', linkRole:'' };
  const type = String(value.type || (value.role ? 'message' : '') || '');
  const role = String(value.role || 'unknown').toLowerCase();
  if(type === 'message') return { itemClass:'log-item-message log-item-message-'+role, linkRole:'' };
  if(type === 'reasoning' || /compaction/.test(type)) return { itemClass:'log-item-reasoning', linkRole:'' };
  if(/(?:^|_)call$/.test(type)) return { itemClass:'log-item-tool-call', linkRole:'CALL' };
  if(/(?:_call_output|tool_result|function_response|tool_search_output)$/.test(type)) {
    return { itemClass:'log-item-tool-result', linkRole:'RESULT' };
  }
  if(['function','custom','namespace','tool_search','web_search'].includes(type)) {
    return { itemClass:'log-item-tool-definition', linkRole:'' };
  }
  return { itemClass:'', linkRole:'' };
}
function logConversationActivityStart(items){
  if(!Array.isArray(items) || !items.length) return -1;
  for(let index=items.length-1; index>=0; index--){
    const item = items[index];
    if(!item || typeof item !== 'object') continue;
    const type = String(item.type || '');
    if(item.role === 'user' || item.role === 'tool' || /(?:_call_output|tool_result|function_response)$/.test(type)) return index;
  }
  return items.length - 1;
}
function logArrayDefaultOpenStart(path, value){
  const key = String(path[path.length - 1] || '');
  return key === 'input' || key === 'messages' || key === 'contents'
    ? logConversationActivityStart(value)
    : -1;
}
function shouldDeferLogField(path, value){
  const pathKey = logFieldPath(path);
  if(LOG_DEFERRED_PATHS.has(pathKey)) return value !== undefined && value !== null;
  if(isLogItemPath(path) && value && typeof value === 'object') return true;
  const key = String(path[path.length - 1] || '');
  const parentPath = logFieldPath(path.slice(0,-1));
  const insideStructuredPayload = parentPath === 'request.body'
    || parentPath.startsWith('request.body.')
    || parentPath === 'response.body'
    || parentPath.startsWith('response.body.')
    || parentPath === 'response.snapshot'
    || parentPath.startsWith('response.snapshot.')
    || parentPath === 'sse.snapshot'
    || parentPath.startsWith('sse.snapshot.');
  if(insideStructuredPayload && LOG_NESTED_CONTAINER_KEYS.has(key) && value !== undefined && value !== null) return true;
  if(typeof value !== 'string') return false;
  if(key === 'rawBody') return true;
  if(LOG_OPAQUE_KEYS.has(key) && value.length >= LOG_OPAQUE_STRING_LIMIT) return true;
  if(/^data:[^,]*;base64,/i.test(value) && value.length >= LOG_OPAQUE_STRING_LIMIT) return true;
  return value.length >= LOG_LONG_STRING_LIMIT;
}
function deferredLogProjection(value, entries, basePath, deferSelf){
  entries = entries || [];
  basePath = basePath || [];
  const visit = (current, path, allowDefer, defaultOpen) => {
    if(allowDefer && path.length && shouldDeferLogField(path, current)){
      const index = entries.length;
      const meta = logFieldMeta(current);
      const kind = logFieldKind(current);
      const summary = isLogItemPath(path) ? logNativeItemSummary(current) : '';
      const presentation = isLogItemPath(path) ? logItemPresentation(current) : { itemClass:'', linkRole:'' };
      const pathKey = logFieldPath(path);
      entries.push({ path, pathKey, value:current, meta, kind, summary, ...presentation, defaultOpen:defaultOpen === true });
      return { __xwxLogFieldFold:index, pathKey, meta, kind, summary, ...presentation, defaultOpen:defaultOpen === true };
    }
    if(Array.isArray(current)){
      const openStart = logArrayDefaultOpenStart(path,current);
      return current.map((item,index) => visit(item,path.concat(index),true,openStart >= 0 && index >= openStart));
    }
    if(!current || typeof current !== 'object') return current;
    const projected = {};
    Object.keys(current).forEach(key => {
      const child = current[key];
      const childPath = path.concat(key);
      projected[key] = visit(child,childPath,true,false);
    });
    return projected;
  };
  return { value:visit(value,basePath,deferSelf === true,false), entries };
}
function deferredLogShape(marker){
  if(marker.kind === 'array') return '[…]';
  if(marker.kind === 'object') return '{…}';
  if(marker.kind === 'string') return '"…"';
  return '…';
}
function deferredLogFoldHtml(label, marker, extraClass, format){
  const title = format !== 'pretty' && label ? '<span class="json-key">'+esc(label)+'</span>: ' : '';
  const itemSummary = marker.summary ? '<span class="log-item-summary">'+esc(marker.summary)+'</span>' : '';
  const linkRole = marker.linkRole ? '<span class="log-item-link">'+esc(marker.linkRole)+'</span>' : '';
  const summary = format === 'pretty'
    ? '<span class="pp-tw">\u25b8</span>'+linkRole+itemSummary+'<span class="pp-meta">'+esc(deferredLogShape(marker))+' '+esc(marker.meta)+'</span>'
    : title+'<span class="log-field-preview">'+esc(deferredLogShape(marker))+'</span>'+linkRole+itemSummary+' <span class="json-count">'+esc(marker.meta)+'</span>';
  const logFormat = format || 'json';
  const pathKey = String(marker.pathKey || '$');
  const foldAttrs = logFoldAttrs(logFormat,pathKey,marker.defaultOpen);
  const itemClass = marker.itemClass ? ' '+esc(marker.itemClass) : '';
  return '<details class="log-field-fold '+esc(extraClass || '')+itemClass+'" data-log-field-index="'+marker.__xwxLogFieldFold+'" data-log-field-path="'+esc(pathKey)+'"'+foldAttrs+'><summary>'+summary+'</summary><div class="log-field-content"></div></details>';
}
function cacheDeferredLogFields(t, entries){ logFieldCache = { traceId:t && t.id || '', format:traceFormat, entries }; }
function currentDeferredLogFields(){
  const t = currentTrace();
  const traceId = t && t.id || '';
  if(logFieldCache.traceId !== traceId || logFieldCache.format !== traceFormat) {
    cacheDeferredLogFields(t, deferredLogProjection(rawTraceValue(t)).entries);
  }
  return logFieldCache.entries;
}
function hydrateDeferredLogFold(node){
  if(!node || node.dataset.logFieldLoaded === 'true') return;
  const index = Number(node.dataset.logFieldIndex);
  const entry = currentDeferredLogFields()[index];
  const content = node.querySelector('.log-field-content');
  if(!entry || !content) return;
  if(typeof entry.value === 'string'){
    const pre = document.createElement('pre');
    pre.className = 'log-field-pre';
    pre.textContent = entry.value;
    content.appendChild(pre);
  } else {
    const projected = deferredLogProjection(entry.value, logFieldCache.entries, entry.path, false).value;
    const format = node.dataset.logFormat || traceFormat;
    if(format === 'pretty') content.innerHTML = toPretty(projected,entry.path);
    else content.innerHTML = '<div class="json-tree">'+jsonTreeRows(projected,1,entry.path)+'</div>';
  }
  node.dataset.logFieldLoaded = 'true';
  content.querySelectorAll('details.log-field-fold[open]').forEach(hydrateDeferredLogFold);
}
function toPretty(v,basePath){
  // 顶层入口：用 grid 容器排同层级 key/value，递归子对象嵌入新的子 grid。
  // 同层 key 自动按 max-content 对齐；多行字符串走 .pp-multiline 占满 value 单元。
  return '<div class="pp-grid pp-root">'+ppRows(v,0,basePath || []) + '</div>';
}
function ppScalar(v){
  if(v === null) return '<i class="pp-null">null</i>';
  if(v === undefined) return '<i class="pp-null">undefined</i>';
  if(typeof v === 'string') return '<span class="pp-str">'+esc(v)+'</span>';
  if(typeof v === 'number') return '<span class="pp-num">'+esc(v)+'</span>';
  if(typeof v === 'boolean') return '<span class="pp-bool">'+esc(v)+'</span>';
  return '<span class="pp-str">'+esc(String(v))+'</span>';
}
function ppKeyCell(k){ return '<div class="pp-k">'+esc(k)+'</div>'; }
function ppNestRow(k, v, depth, path){
  // 用 details 折叠；summary 显示 {n}/[n]，body 是子 grid。
  // grid 让 key cell 在左列，details 跨整个 value cell。
  const isArr = Array.isArray(v);
  const count = isArr ? v.length : Object.keys(v).length;
  const meta = isArr ? '['+count+']' : '{'+count+'}';
  const pathKey = logFoldPath(path || []);
  const foldAttrs = logFoldAttrs('pretty',pathKey,depth < 2 && !LOG_DEFAULT_CLOSED_KEYS.has(String(k)));
  return ppKeyCell(k)
    + '<details class="pp-nest"'+foldAttrs+'>'
    +   '<summary class="pp-sum"><span class="pp-tw">\u25b8</span><span class="pp-meta">'+meta+'</span></summary>'
    +   '<div class="pp-grid">'+ppRows(v,depth+1,path || [])+'</div>'
    + '</details>';
}
function ppRows(v, depth, path){
  // v 必须是对象或数组；返回若干 grid 子项（每项就是 key cell + value cell 两个 grid children）。
  let out = '';
  path = path || [];
  const isArr = Array.isArray(v);
  if(!isArr && (v === null || typeof v !== 'object')){
    // 顶层是标量：单独一行占整 grid（极少见，兜底）
    return '<div class="pp-k">(value)</div><div class="pp-v">'+ppScalar(v)+'</div>';
  }
  const keys = isArr ? v.map((_,i)=>String(i)) : Object.keys(v);
  if(!keys.length){
    return '<div class="pp-empty-row">'+(isArr ? '[]' : '{}')+'</div>';
  }
  for(const k of keys){
    const child = isArr ? v[Number(k)] : v[k];
    const label = isArr ? '#'+k : k;
    const childPath = path.concat(isArr ? Number(k) : k);
    if(isDeferredLogMarker(child)){
      out += ppKeyCell(label) + deferredLogFoldHtml('', child, 'pp-log-field', 'pretty');
      continue;
    }
    if(child !== null && typeof child === 'object'){
      out += ppNestRow(label,child,depth,childPath);
      continue;
    }
    if(typeof child === 'string' && (child.indexOf('\\n') >= 0 || child.length > 140)){
      // 长 / 多行字符串：value cell 放 .pp-multiline，占满 1fr 列，绝不会被挤压
      out += ppKeyCell(label) + '<div class="pp-v"><pre class="pp-multiline">'+esc(child)+'</pre></div>';
      continue;
    }
    out += ppKeyCell(label) + '<div class="pp-v">'+ppScalar(child)+'</div>';
  }
  return out;
}
function bytes(v){
  if(typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let value = v, unit = 0;
  while(value >= 1024 && unit < units.length - 1){ value /= 1024; unit++; }
  const digits = unit === 0 ? 0 : (value < 10 ? 1 : 0);
  return value.toFixed(digits) + ' ' + units[unit];
}
function short(s,n){ s=String(s == null ? '' : s).replace(/\\s+/g,' ').trim(); return s.length>(n||140)?s.slice(0,(n||140))+'…':s; }
function rawTraces(){ const map = state.sessionTraces || {}; if(map[selectedSessionId]) return map[selectedSessionId]; return selectedSessionId === state.currentSessionId ? (state.traces || []) : []; }
function traces(){ return logicalTraceView(rawTraces()).ordered; }
function logicalInfo(t){ return logicalTraceView(rawTraces()).meta.get(t && t.id) || fallbackTraceInfo(t); }
function traceLabel(t){ const info = logicalInfo(t); return info.label || fallbackTraceInfo(t).label; }
function traceRailLabel(t){ const info = logicalInfo(t); return info.railLabel || traceLabel(t); }
function requestLabel(value){ return L('请求 ','Request ') + (value || '?'); }
function stableTraceOrdinal(t, fallback){
  const logicalTurn = Number(t && t.logicalTurn);
  if(Number.isInteger(logicalTurn) && logicalTurn > 0) return logicalTurn;
  const turn = Number(t && t.turn);
  return Number.isInteger(turn) && turn > 0 ? turn : fallback;
}
function compareTraceDisplayOrder(a, b){
  const aTurn = stableTraceOrdinal(a, Number.MAX_SAFE_INTEGER);
  const bTurn = stableTraceOrdinal(b, Number.MAX_SAFE_INTEGER);
  if(aTurn !== bTurn) return aTurn - bTurn;
  return compareTraceStart(a, b);
}
function fallbackTraceInfo(t){
  const label = requestLabel(t && t.turn);
  return { kind:'raw', label, railLabel:label, sortRank:Number.MAX_SAFE_INTEGER, parentId: undefined };
}
function logicalTraceView(list){
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  const key = uiLang + '|' + arr.map(t => [t.id,t.logicalTurn,t.turn,t.startedAt,t.completedAt,t.auxiliary,t.subagent,t.subagentInfo&&t.subagentInfo.invocationId,t.subagentInfo&&t.subagentInfo.parentInvocationId,t.subagentInfo&&t.subagentInfo.depth,t.subagentInfo&&t.subagentInfo.agentType,t.subagentInfo&&t.subagentInfo.agentId].join('|')).join('~');
  if(logicalOrderCache.key === key) return logicalOrderCache;

  const byStart = arr.slice().sort(compareTraceStart);
  const mains = byStart.filter(isMainTrace);
  const meta = new Map();
  for(let i = 0; i < mains.length; i++){
    const ordinal = i + 1;
    const label = requestLabel(ordinal);
    meta.set(mains[i].id, {
      kind:'main',
      label,
      railLabel:String(ordinal),
      mainOrdinal:ordinal,
      sortRank:ordinal * 100000,
      parentId:mains[i].id,
      axisKey:'main',
      groupLabel:label
    });
  }

  const auxCounts = {};
  for(const t of byStart){
    if(!t || !t.id || isMainTrace(t) || t.subagent) continue;
    const parent = findParentMain(t, mains, 'aux');
    const parentInfo = parent ? meta.get(parent.id) : undefined;
    const parentLabel = parentInfo ? parentInfo.label : L('待定请求','Pending request');
    const parentOrdinal = parentInfo ? parentInfo.mainOrdinal : mains.length + 1;
    const aux = auxName(t);
    const countKey = (parent ? parent.id : 'orphan') + '|' + aux;
    const n = (auxCounts[countKey] || 0) + 1;
    auxCounts[countKey] = n;
    const label = parentLabel + '.' + aux + (n > 1 ? '.' + n : '');
    meta.set(t.id, {
      kind:'aux',
      label,
      railLabel:auxRailLabel(aux, n),
      mainOrdinal:parentOrdinal,
      parentId:parent && parent.id,
      auxName:aux,
      sortRank:parentOrdinal * 100000 + auxRank(aux) * 100 + n,
      axisKey:(parent ? parent.id : 'orphan') + '|aux|' + aux,
      groupLabel:parentLabel
    });
  }

  const subGroupCount = {};
  const subReqCount = {};
  const lastSub = {};
  const lastSegmentByInvocation = {};
  for(const t of byStart){
    if(!t || !t.id) continue;
    // 严格时间序：任何非子 Agent 请求（含 count_tokens / title 这类 auxiliary 探测）都关闭当前
    // 所有开着的子 Agent 段。否则它之后归入同一段的请求会被渲染进前面那张卡，而它自己留在卡
    // 下方，看起来像顺序颠倒。代价是探测频繁时卡片会切得更碎——这是刻意取舍。
    if(!t.subagent || t.auxiliary){
      for(const key in lastSub) delete lastSub[key];
      continue;
    }
    const parent = findParentMain(t, mains, 'subagent');
    const parentInfo = parent ? meta.get(parent.id) : undefined;
    const parentLabel = parentInfo ? parentInfo.label : L('待定请求','Pending request');
    const parentOrdinal = parentInfo ? parentInfo.mainOrdinal : mains.length + 1;
    const parentKey = parent ? parent.id : 'orphan';
    const agent = subagentName(t);
    const start = traceStartMs(t);
    const structured = t.subagentInfo && typeof t.subagentInfo === 'object' ? t.subagentInfo : {};
    const invocationId = typeof structured.invocationId === 'string' ? structured.invocationId : '';
    const parentInvocationId = typeof structured.parentInvocationId === 'string' ? structured.parentInvocationId : '';
    const depth = Number.isInteger(structured.depth) && structured.depth > 0 ? structured.depth : 1;
    const agentType = typeof structured.agentType === 'string' ? structured.agentType : '';
    const agentId = traceAgentId(t, structured);
    const contextKey = parentInvocationId ? 'agent:'+parentInvocationId : 'main:'+parentKey;
    // 归组优先用 agentId（agent 自己的 header 身份，每条请求都有），退而用 invocationId（父侧那次
    // 调用，只有 prompt hash 盖章成功才有），最后才退到名字。只按后两者归组，同一个子 agent 会因为
    // 「有些请求盖上了章、有些没盖上」被切成好几张卡（实测一个子 agent 被切成 3 张）。
    const identity = agentId ? 'agent:'+agentId : (invocationId ? 'id:'+invocationId : 'name:'+agent);
    const parentGroupKey = parentInvocationId ? lastSegmentByInvocation[parentInvocationId] : undefined;
    let groupNo, groupKey;
    const last = lastSub[contextKey];
    if(last && last.identity === identity && start - last.lastStart <= 2 * 60 * 1000){
      groupNo = last.groupNo;
      groupKey = last.groupKey;
    } else {
      groupNo = (subGroupCount[contextKey] || 0) + 1;
      subGroupCount[contextKey] = groupNo;
      groupKey = parentKey+'|sub|'+contextKey+'|'+groupNo;
    }
    const reqKey = groupKey;
    const reqNo = (subReqCount[reqKey] || 0) + 1;
    subReqCount[reqKey] = reqNo;
    lastSub[contextKey] = { identity, groupNo, groupKey, lastStart:start };
    if(invocationId) lastSegmentByInvocation[invocationId] = groupKey;
    meta.set(t.id, {
      kind:'subagent',
      label:requestLabel(t.turn),
      railLabel:String(t.turn || '?'),
      mainOrdinal:parentOrdinal,
      parentId:parent && parent.id,
      subGroupKey:groupKey,
      subParentGroupKey:parentGroupKey,
      subGroupNo:groupNo,
      subRequestNo:reqNo,
      subInvocationId:invocationId,
      subAgentId:agentId,
      subIdentity:identity,
      subParentInvocationId:parentInvocationId,
      subDepth:depth,
      subAgentType:agentType,
      sortRank:parentOrdinal * 100000 + 50000 + groupNo * 1000 + reqNo,
      axisKey:groupKey,
      groupLabel:parentLabel
    });
  }

  const ordered = arr.slice().sort(compareTraceDisplayOrder);
  // 逻辑归位只负责归组与折叠关系；跨物理 Session 时优先使用 API 附加的 logicalTurn。
  // 单一 Session 仍使用落盘 turn。两者都与分页窗口无关，补载早期页不会让现有气泡整体跳号。
  for(let i = 0; i < ordered.length; i++){
    const t = ordered[i];
    const info = meta.get(t.id) || fallbackTraceInfo(t);
    const ordinal = stableTraceOrdinal(t, i + 1);
    info.displayOrdinal = ordinal;
    info.label = requestLabel(ordinal);
    info.railLabel = String(ordinal);
    meta.set(t.id, info);
  }
  logicalOrderCache = { key, ordered, meta };
  return logicalOrderCache;
}
function compareTraceStart(a,b){
  const d = traceStartMs(a) - traceStartMs(b);
  if(d) return d;
  return ((a && a.turn) || 0) - ((b && b.turn) || 0);
}
function isMainTrace(t){ return !!(t && !t.auxiliary && !t.subagent); }
function traceStartMs(t){ const n = Date.parse(t && t.startedAt || ''); return Number.isFinite(n) ? n : 0; }
function traceEndMs(t){
  const n = Date.parse(t && t.completedAt || '');
  if(Number.isFinite(n)) return n;
  const s = traceStartMs(t);
  return s + (typeof (t && t.durationMs) === 'number' ? t.durationMs : 0);
}
function findParentMain(t, mains, kind){
  if(!mains.length) return undefined;
  const s = traceStartMs(t);
  let enclosing, enclosingStart = -Infinity;
  for(const m of mains){
    const ms0 = traceStartMs(m), me0 = traceEndMs(m);
    if(s >= ms0 - 250 && s <= me0 + 1000 && ms0 > enclosingStart){
      enclosing = m; enclosingStart = ms0;
    }
  }
  if(enclosing) return enclosing;
  let prev, prevStart = -Infinity;
  let next, nextStart = Infinity;
  for(const m of mains){
    const ms0 = traceStartMs(m);
    if(ms0 <= s && ms0 > prevStart){ prev = m; prevStart = ms0; }
    if(ms0 > s && ms0 < nextStart){ next = m; nextStart = ms0; }
  }
  if(kind === 'aux' && t && t.auxiliary === 'title' && next && nextStart - s <= 10 * 60 * 1000) return next;
  if(prev) return prev;
  if(next && nextStart - s <= 10 * 60 * 1000) return next;
  return next || prev;
}
function auxName(t){
  if(t && t.auxiliary === 'title') return 'title';
  if(t && t.auxiliary === 'count') return 'count';
  if(t && t.auxiliary === 'policy') return 'policy';
  if(t && t.auxiliary === 'patch') return 'patch';
  if(t && t.auxiliary === 'memory') return 'memory';
  if(t && t.auxiliary === 'utility') return 'utility';
  return 'aux';
}
function auxRank(name){
  if(name === 'title') return 10;
  if(name === 'count') return 20;
  if(name === 'policy') return 30;
  if(name === 'patch') return 40;
  if(name === 'memory') return 45;
  if(name === 'utility') return 46;
  return 49;
}
function auxRailLabel(name, n){
  const head = name === 'policy' ? 'pol' : name === 'count' ? 'cnt' : name === 'title' ? 'ttl' : name === 'memory' ? 'mem' : name === 'utility' ? 'util' : name.slice(0,3);
  return head + (n > 1 ? n : '');
}
function subagentName(t){ return (typeof (t && t.subagent) === 'string' && t.subagent !== '1') ? t.subagent : 'Subagent'; }
function currentTraceMeta(){ return sessionTraceMeta && sessionTraceMeta[selectedSessionId]; }
function currentTraceOffset(){ const meta = currentTraceMeta(); return meta && typeof meta.offset === 'number' ? meta.offset : 0; }
function currentTraceTotal(fallback){ const meta = currentTraceMeta(); return meta && typeof meta.total === 'number' ? meta.total : fallback; }
function isSessionLoading(sid){ return !!(sid && sessionLoadState[sid] === 'loading'); }
function currentTrace(){ const list = traces(); return list.find(t => t.id === selectedId) || list[list.length - 1]; }
function currentIndex(){ return traces().findIndex(t => t.id === selectedId); }
function currentSession(){ return state.sessions.find(s => s.id === selectedSessionId) || state.sessions[0]; }
function readSectionState(){ try { return JSON.parse(localStorage.getItem('xwxTraceSections') || '{}') || {}; } catch { return {}; } }
function writeSectionState(){ try { localStorage.setItem('xwxTraceSections', JSON.stringify(sectionState)); } catch {} }
// 指标条折叠态：首次（读到 null）默认展开，让用户看见里面有 token/耗时明细；之后尊重用户选择。
function readMetricsOpen(){ try { const v = localStorage.getItem('xwxTraceMetricsOpen'); return v === null ? true : v === '1'; } catch { return true; } }
function writeMetricsOpen(){ try { localStorage.setItem('xwxTraceMetricsOpen', metricsOpen ? '1' : '0'); } catch {} }
const DASH_COL_ORDER = ['started','first','source','model','duration','requests','tokens','cost','status','actions'];
const DASH_COL_DEFAULTS = { started:202, first:158, source:80, model:252, duration:88, requests:60, tokens:96, cost:82, status:56, actions:76 };
const DASH_COL_MIN = { started:120, first:140, source:72, model:96, duration:56, requests:52, tokens:64, cost:64, status:52, actions:76 };
const DASH_COL_MAX = 720;
const DASH_COL_STORAGE_KEY = 'xwxTraceDashColsV2';
let dashColWidths = readDashColWidths();
let dashColDidResize = false;
function clampDashColWidth(id, n){ return Math.max(DASH_COL_MIN[id] || 52, Math.min(DASH_COL_MAX, Math.round(Number(n) || 0))); }
function readDashColWidths(){
  const next = Object.assign({}, DASH_COL_DEFAULTS);
  try {
    const raw = JSON.parse(localStorage.getItem(DASH_COL_STORAGE_KEY) || '{}') || {};
    for(const id of DASH_COL_ORDER){
      if(raw[id] != null) next[id] = clampDashColWidth(id, raw[id]);
    }
  } catch {}
  return next;
}
function writeDashColWidths(){ try { localStorage.setItem(DASH_COL_STORAGE_KEY, JSON.stringify(dashColWidths)); } catch {} }
function visibleDashColIds(table){
  return DASH_COL_ORDER.filter(id => {
    const cell = table && table.querySelector('th[data-col="'+id+'"]');
    if(!cell) return true;
    return window.getComputedStyle(cell).display !== 'none';
  });
}
function dashTableMinWidth(table){
  return visibleDashColIds(table).reduce((sum, id) => sum + dashColWidths[id], 0);
}
function dashHead(id, label, cls){
  return '<th data-col="'+id+'"'+(cls ? ' class="'+cls+'"' : '')+'>'+label+'<span class="col-resizer" data-col-resize="'+id+'" role="separator" aria-orientation="vertical" title="'+esc(L('拖动调整列宽','Drag to resize column'))+'"></span></th>';
}
function applyDashColumnWidths(root){
  const table = (root || el('dashboard') || document).querySelector('.dash-table');
  if(!table) return;
  const wrap = table.closest('.dash-table-wrap');
  const wrapW = wrap ? wrap.clientWidth : 0;
  // If layout hasn't settled yet (wrapW === 0), defer to next frame — but only
  // while the table is actually rendered. A hidden dashboard (detail view open)
  // stays at 0 forever, and retrying it would spin a frame loop until the user
  // navigates back.
  if(wrapW === 0){
    if(!wrap || !wrap.isConnected || !wrap.offsetParent) return;
    requestAnimationFrame(function(){ applyDashColumnWidths(root); });
    return;
  }
  const ids = visibleDashColIds(table);
  const colSum = ids.reduce((s, id) => s + (dashColWidths[id] || 0), 0);
  // Absorb slack into 'first'; set an explicit px width on the table itself so
  // col-spacer (width:auto) can never claim leftover space.
  const slack = Math.max(0, wrapW - colSum);
  function resolveColW(id){ return id === 'first' ? (dashColWidths[id] || 0) + slack : dashColWidths[id]; }
  table.style.minWidth = colSum + 'px';
  table.style.width = Math.max(colSum, wrapW) + 'px';
  table.querySelectorAll('col[data-col]').forEach(col => {
    const id = col.dataset.col;
    const w = resolveColW(id);
    if(w) col.style.width = w + 'px';
  });
  table.querySelectorAll('th[data-col], td[data-col]').forEach(cell => {
    const id = cell.dataset.col;
    const w = resolveColW(id);
    if(!w) return;
    cell.style.width = w + 'px';
    cell.style.maxWidth = w + 'px';
  });
}
let dashWrapObserver;
let dashWrapObserved;
function bindDashWrapResize(root){
  const wrap = ((root || el('dashboard')) || document).querySelector('.dash-table-wrap');
  // renderDashboard() replaces the whole subtree, so a dataset flag on the wrap
  // dies with it and every redraw would leak another observer plus the detached
  // table it still references. Keep one observer and re-point it instead.
  if(typeof ResizeObserver === 'undefined') return;
  if(wrap && wrap === dashWrapObserved) return;
  if(dashWrapObserver) dashWrapObserver.disconnect();
  dashWrapObserved = wrap || undefined;
  if(!wrap) return;
  if(!dashWrapObserver)
    dashWrapObserver = new ResizeObserver(function(entries){
      // A hidden dashboard reports 0×0; recomputing then would only re-enter the
      // deferral path above.
      for(const entry of entries) if(!entry.contentRect.width) return;
      applyDashColumnWidths(el('dashboard'));
    });
  dashWrapObserver.observe(wrap);
}
function bindDashColumnResize(root){
  const table = (root || el('dashboard') || document).querySelector('.dash-table');
  if(!table || table.dataset.colResizeBound) return;
  table.dataset.colResizeBound = '1';
  table.addEventListener('pointerdown', function(ev){
    const handle = ev.target.closest('[data-col-resize]');
    if(!handle) return;
    ev.preventDefault();
    ev.stopPropagation();
    const id = handle.dataset.colResize;
    const startX = ev.clientX;
    const startW = dashColWidths[id];
    const wrap = table.closest('.dash-table-wrap');
    dashColDidResize = false;
    handle.classList.add('active');
    if(wrap) wrap.classList.add('is-col-resizing');
    try { handle.setPointerCapture(ev.pointerId); } catch(_e){}
    function move(mv){
      const next = clampDashColWidth(id, startW + (mv.clientX - startX));
      if(next !== dashColWidths[id]) dashColDidResize = true;
      dashColWidths[id] = next;
      applyDashColumnWidths(el('dashboard'));
    }
    function up(){
      handle.classList.remove('active');
      if(wrap) wrap.classList.remove('is-col-resizing');
      writeDashColWidths();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  table.addEventListener('dblclick', function(ev){
    const handle = ev.target.closest('[data-col-resize]');
    if(!handle) return;
    ev.preventDefault();
    ev.stopPropagation();
    const id = handle.dataset.colResize;
    dashColWidths[id] = DASH_COL_DEFAULTS[id];
    applyDashColumnWidths(el('dashboard'));
    writeDashColWidths();
  });
}
// renderDetail 会整块替换 #detail。重绘前记录同一条 trace 中所有原生 details、
// 工具声明和局部格式选择，重绘后按稳定签名恢复，避免自动刷新把用户正在看的内容折叠。
function detailFoldEntries(root){
  const seen = {};
  return Array.from(root.querySelectorAll('details:not([data-log-fold-path])')).map(node => {
    let base = '';
    if(node.dataset.sse !== undefined) base = 'sse:'+node.dataset.sse;
    else if(node.dataset.sseGroup !== undefined) base = 'sse-group:'+node.dataset.sseGroup;
    else {
      const summary = node.querySelector(':scope > summary');
      const label = summary ? String(summary.textContent || '').replace(/\\s+/g,' ').trim() : '';
      const viewNode = node.closest('.view-single,.view-cmp,.view-raw');
      const viewKey = viewNode ? Array.from(viewNode.classList).join('.') : 'detail';
      base = viewKey+'|'+Array.from(node.classList).join('.')+'|'+label;
    }
    const ordinal = seen[base] || 0;
    seen[base] = ordinal + 1;
    return [base+'#'+ordinal, !!node.open];
  });
}
function captureDetailUiState(root, traceId){
  if(!root || !traceId || root.dataset.traceId !== traceId) return null;
  return {
    folds: Object.fromEntries(detailFoldEntries(root)),
    // Only folds whose state diverges from their default. Snapshotting every
    // container pinned the depth<2 and latest-activity heuristics permanently and
    // grew the per-trace cache to thousands of entries on a large Log tree.
    logFolds: Object.fromEntries(Array.from(root.querySelectorAll('details[data-log-fold-path]'))
      .filter(node => !!node.open !== (node.dataset.logFoldDefault === '1'))
      .map(node => [
        String(node.dataset.logFormat || 'json')+'|'+String(node.dataset.logFoldPath == null ? '$' : node.dataset.logFoldPath),
        !!node.open
      ])),
    tools: Array.from(root.querySelectorAll('.tool-block[data-tool]')).map(node => [node.dataset.tool, node.classList.contains('open')]),
    blocks: Array.from(root.querySelectorAll('.content-block[data-bfmt]')).map((node,index) => [String(index), node.dataset.bfmt]),
    systems: Array.from(root.querySelectorAll('.sys-wrap[data-sysfmt]')).map((node,index) => [String(index), node.dataset.sysfmt]),
    scrollTop: root.scrollTop
  };
}
function rememberDetailUiState(traceId, snapshot){
  if(!traceId || !snapshot) return;
  const previous = detailUiCache.get(traceId) || {};
  const merged = Object.assign({},previous,snapshot,{
    // raw 视图一次只渲染当前格式；合并而不是覆盖，才能在 JSON/PRETTY
    // 往返时保留各自的树节点状态。
    folds: Object.assign({},previous.folds || {},snapshot.folds || {}),
    logFolds: Object.assign({},previous.logFolds || {},snapshot.logFolds || {})
  });
  detailUiCache.delete(traceId);
  detailUiCache.set(traceId,merged);
  while(detailUiCache.size > DETAIL_UI_CACHE_LIMIT){
    const oldest = detailUiCache.keys().next().value;
    detailUiCache.delete(oldest);
  }
}
function restoreDetailUiState(root, traceId, snapshot){
  root.dataset.traceId = traceId;
  if(!snapshot) return;
  const folds = snapshot.folds || {};
  const foldNodes = Array.from(root.querySelectorAll('details:not([data-log-fold-path])'));
  const foldEntries = detailFoldEntries(root);
  foldNodes.forEach((node,index) => {
    const key = foldEntries[index] && foldEntries[index][0];
    if(key && Object.prototype.hasOwnProperty.call(folds,key)) node.open = !!folds[key];
  });
  const tools = Object.fromEntries(snapshot.tools || []);
  root.querySelectorAll('.tool-block[data-tool]').forEach(node => {
    if(!Object.prototype.hasOwnProperty.call(tools,node.dataset.tool)) return;
    const open = !!tools[node.dataset.tool];
    node.classList.toggle('open',open);
    const head = node.querySelector(':scope > .tool-head');
    const cw = node.querySelector(':scope > .cw');
    if(head) head.setAttribute('aria-expanded',open?'true':'false');
    if(cw) cw.setAttribute('aria-hidden',open?'false':'true');
  });
  const restoreFormats = (selector, entries, dataKey, buttonSelector, paneSelector) => {
    const values = Object.fromEntries(entries || []);
    root.querySelectorAll(selector).forEach((node,index) => {
      const next = values[String(index)];
      if(!next) return;
      node.dataset[dataKey] = next;
      node.querySelectorAll(buttonSelector).forEach(button => button.classList.toggle('active',button.dataset[dataKey] === next));
      node.querySelectorAll(paneSelector).forEach(pane => pane.style.display = pane.dataset[dataKey+'Pane'] === next ? '' : 'none');
    });
  };
  restoreFormats('.content-block[data-bfmt]',snapshot.blocks,'bfmt','[data-bfmt]','[data-bfmt-pane]');
  restoreFormats('.sys-wrap[data-sysfmt]',snapshot.systems,'sysfmt','[data-sysfmt]','[data-sysfmt-pane]');
  root.scrollTop = snapshot.scrollTop || 0;
}
// 折叠/展开高度动画：用元素真实 scrollHeight 做 max-height 过渡，避免固定上限造成的“空过渡”停顿。
function animateCollapse(cw, open){
  if(!cw) return;
  if(cw._xwxCollapseTimer){ clearTimeout(cw._xwxCollapseTimer); cw._xwxCollapseTimer = 0; }
  const height = cw.scrollHeight;
  cw.style.overflow = 'hidden';
  let done;
  const clearDone = () => {
    if(done) cw.removeEventListener('transitionend', done);
    if(cw._xwxCollapseTimer){ clearTimeout(cw._xwxCollapseTimer); cw._xwxCollapseTimer = 0; }
  };
  if(open){
    cw.style.maxHeight = '0px';
    void cw.offsetHeight;
    const finish = () => { clearDone(); cw.style.maxHeight = 'none'; cw.style.overflow = 'visible'; };
    done = (ev) => { if(ev.propertyName !== 'max-height') return; finish(); };
    cw.addEventListener('transitionend', done);
    requestAnimationFrame(() => { cw.style.maxHeight = height + 'px'; });
    cw._xwxCollapseTimer = setTimeout(finish, 320);
  } else {
    // 先把当前高度从 none / 固定上限锁定为真实像素，强制重排，再下一帧收到 0，确保过渡可见且贴合内容。
    const finish = () => { clearDone(); cw.style.maxHeight = '0px'; cw.style.overflow = 'hidden'; };
    done = (ev) => { if(ev.propertyName !== 'max-height') return; finish(); };
    cw.addEventListener('transitionend', done);
    cw.style.maxHeight = height + 'px';
    void cw.offsetHeight;
    requestAnimationFrame(() => { cw.style.maxHeight = '0px'; });
    cw._xwxCollapseTimer = setTimeout(finish, 320);
  }
}
// Historical traces may lack canonical V2 buckets. Recover them from raw usage
// only when the protocol shape is explicit; otherwise keep the field unknown.
function usageOf(t){
  const u = t && t.usage || {};
  if(u.inputUncachedTokens !== undefined && u.inputTotalTokens !== undefined) return u;
  const evidence = t && t.usageEvidence && t.usageEvidence.upstream;
  const raw = evidence && evidence.raw || rawUsageOf(t);
  if(!raw) return u;
  const declaredProtocol = evidence && evidence.protocol
    || (t && t.protocol)
    || (t && t.request && t.request.apiType === 'responses' ? 'openai-responses'
      : t && t.request && t.request.apiType === 'chat-completions' ? 'openai-chat-completions'
        : t && t.request && t.request.apiType === 'messages' ? 'anthropic-messages' : 'unknown');
  const details = raw && (raw.input_tokens_details || raw.prompt_tokens_details || raw.input_token_details);
  const cacheCreation = raw.cache_creation && typeof raw.cache_creation === 'object' ? raw.cache_creation : {};
  const providerInput = firstNum(raw.input_tokens, raw.prompt_tokens, raw.input, raw.prompt);
  const output = firstNum(raw.output_tokens, raw.completion_tokens, raw.output, raw.completion);
  const explicitTotal = firstNum(raw.total_tokens, raw.total);
  const detailRead = details && firstNum(details.cached_tokens, details.cache_read_tokens, details.cache_read_input_tokens);
  const detailWrite = details && firstNum(details.cache_creation_tokens, details.cache_creation_input_tokens, details.cache_write_tokens);
  const topRead = firstNum(raw.cache_read_input_tokens, raw.cache_read_tokens);
  const topWrite = firstNum(raw.cache_creation_input_tokens, raw.cache_creation_tokens);
  const write5m = firstNum(cacheCreation.ephemeral_5m_input_tokens, details && details.cache_write_5m_tokens);
  const write1h = firstNum(cacheCreation.ephemeral_1h_input_tokens, details && details.cache_write_1h_tokens);
  // Traces recorded before apiType/usageEvidence existed declare nothing, so the
  // shape of the raw usage is the last discriminator: top-level cache counts are
  // Anthropic Messages (independent buckets), *_tokens_details is OpenAI (subset).
  // Without this fallback a historical Claude turn falls back to 'unknown' and
  // its additive buckets get treated as if input already contained them.
  const shapeProtocol = topRead !== undefined || topWrite !== undefined || write5m !== undefined || write1h !== undefined
    ? 'anthropic-messages'
    : 'unknown';
  // Old bridged traces kept only the client-facing Responses usage. When both
  // details and an Anthropic compatibility field exist, details describe the
  // actual shape of input_tokens and the top-level field is a duplicate.
  const protocol = !evidence && details
    ? (t && t.request && t.request.apiType === 'chat-completions' ? 'openai-chat-completions' : 'openai-responses')
    : declaredProtocol !== 'unknown' ? declaredProtocol : shapeProtocol;
  const openai = protocol === 'openai-responses' || protocol === 'openai-chat-completions';
  const anthropic = protocol === 'anthropic-messages';
  const cacheRead = openai ? detailRead : anthropic ? topRead : undefined;
  const cacheWrite = openai ? detailWrite : anthropic ? firstNum(topWrite, (write5m || 0)+(write1h || 0)) : undefined;
  // A cache bucket the upstream never reported adds no tokens, so token math
  // treats it as 0; the missing list still records it so billing stays
  // unavailable.
  const inputUncached = anthropic
    ? providerInput
    : openai && providerInput !== undefined
      ? Math.max(0,providerInput-(cacheRead || 0)-(cacheWrite || 0))
      : undefined;
  const inputTotal = openai
    ? providerInput
    : anthropic && providerInput !== undefined
      ? providerInput+(cacheRead || 0)+(cacheWrite || 0)
      : undefined;
  const total = explicitTotal !== undefined ? explicitTotal
    : inputTotal !== undefined && output !== undefined ? inputTotal+output : undefined;
  const missing = [];
  if(inputUncached === undefined) missing.push('input');
  if(cacheRead === undefined) missing.push('cacheRead');
  if(cacheWrite === undefined) missing.push('cacheWrite');
  if(output === undefined) missing.push('output');
  if(total === undefined) missing.push('total');
  return Object.assign({},u,{
    inputTokens: providerInput,
    inputUncachedTokens: inputUncached,
    inputTotalTokens: inputTotal,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    cacheCreation5mTokens: write5m,
    cacheCreation1hTokens: write1h,
    inputIncludesCache: openai ? true : anthropic ? false : undefined,
    incompleteFields: missing.length ? missing : undefined
  });
}
function rawUsageOf(t){
  const paths = [t && t.response && t.response.snapshot, t && t.sse && t.sse.snapshot];
  for(const snap of paths){
    const raw = snap && snap.raw && snap.raw.usage;
    if(raw && typeof raw === 'object') return raw;
  }
  const body = t && t.response && t.response.body;
  if(body && typeof body === 'object' && body.usage && typeof body.usage === 'object') return body.usage;
  return undefined;
}
function firstNum(...vals){ for(const v of vals) if(typeof v === 'number' && isFinite(v)) return v; return undefined; }
// ⚠️ Token 口径镜像：权威定义在 normalizeUsage.ts 的 contextWindowTokens / billableTotalTokens，
// 这里是客户端（注入脚本）镜像，公式必须与之逐字一致；改一处务必同步另一处。
// 上下文窗口占用 = 输入 + 缓存读 + 缓存写（不含输出），与 Copilot context window 一致。
// inputIncludesCache 为真时（OpenAI 系）缓存已经算在 inputTokens 里，再加一遍就翻倍。
function contextWindowTokens(u){ u=u||{}; if(u.inputIncludesCache) return u.inputTokens || 0; return (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0); }
// 计费总量 = API total 优先；缺失时 上下文窗口占用 + 输出 兜底。
function billableTotalTokens(u){ u=u||{}; if(typeof u.totalTokens === 'number') return u.totalTokens; return contextWindowTokens(u) + (u.outputTokens || 0); }
function totalTokens(t){ return billableTotalTokens(usageOf(t)); }
function traceSearchParts(t){
  const req = t && t.request || {};
  const res = t && t.response || {};
  return [
    ['prompt', promptSnapshot(t)],
    ['request', j(req.body)],
    ['response', j(responseSnapshot(t) || res.body)],
    ['sse', j(t && t.sse && t.sse.events)],
    ['upstream', j(t && t.upstream)],
    ['request headers', j(req.headers)],
    ['response headers', j(res.headers)],
    ['client', j({
      source: t && t.source,
      client: t && t.client,
      clientIdentity: t && t.clientIdentity,
      protocol: t && t.protocol,
      captureMode: t && t.captureMode,
      routedBy: t && t.routedBy,
      clientConversationKey: t && t.clientConversationKey
    })],
    ['endpoint', [
      req.method,
      req.apiType,
      req.path,
      req.url,
      req.model,
      res.statusCode,
      res.statusMessage,
      t && t.error
    ].filter(Boolean).join(' ')]
  ];
}
function traceText(t){ return traceSearchParts(t).map(pair => pair[1]).join('\\n').toLowerCase(); }
function bodyOf(t){ return (t && t.request && t.request.body && typeof t.request.body === 'object') ? t.request.body : {}; }
function generatedLabel(value){ if(!value) return ''; const d=new Date(value); return Number.isNaN(d.getTime()) ? value : d.toLocaleString(); }
function renderConnectionStatus(){
  const liveTag = state.active
    ? (liveConnected ? ' · <span class="live-on">LIVE</span>' : ' · <span class="live-off">'+L('重连中','Reconnecting')+'</span>')
    : (state.sessions && state.sessions.length ? ' · <span class="live-off">'+L('离线','Offline')+'</span>' : '');
  el('generatedAt').innerHTML = (state.generatedAt ? L('生成 ', 'Generated ') + esc(generatedLabel(state.generatedAt)) : '') + liveTag;
}
function render(){
  renderChromeText();
  // 全局顶部条（无论 dashboard / session 视图）
  renderConnectionStatus();

  renderCrumbs();
  el('topBar').setAttribute('data-view', view);
  el('appRoot').setAttribute('data-view', view);
  el('appRoot').setAttribute('data-detmode', detailMode);
  if(view === 'dashboard'){
    el('dashboard').hidden = false;
    el('detail').hidden = true;
    renderDashboard();
  } else {
    el('dashboard').hidden = true;
    el('detail').hidden = false;
    renderRailHead();
    renderList();
    renderDetail();
  }
}
function renderCrumbs(){
  const node = el('crumbs');
  if(view === 'dashboard'){
    node.innerHTML = '';
    return;
  }
  const sess = currentSession();
  const logicalSession = logicalConversationForSession(sess && sess.id);
  const title = logicalSession ? sessionTitle(logicalSession) : (sess ? sessionTitle(sess) : '会话');
  // 分隔符用 lucide ChevronRight 图标（m9 18 6-6-6-6），不用文字 › —— 文字符号天生偏小偏飘。
  const returnLabel = L('返回总览', 'Back to overview');
  node.innerHTML =
    '<button type="button" class="return-control" data-nav="dashboard" aria-label="'+esc(returnLabel)+'" title="'+esc(returnLabel)+'">'+
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>'+
      '<span>'+esc(L('总览', 'Overview'))+'</span>'+
    '</button>'+
    '<span class="return-divider" aria-hidden="true"></span>'+
    '<span class="seg current" title="'+esc(title)+'">'+esc(title)+'</span>';
}
function renderRailHead(){
  const sess = currentSession();
  const logicalSession = logicalConversationForSession(sess && sess.id);
  const title = logicalSession ? sessionTitle(logicalSession) : (sess ? sessionTitle(sess) : '会话');
  const compact = isCompactRail();
  // 折叠图标复用 XwX Deck 主窗口的 lucide PanelLeft（方框+竖线，无箭头），
  // 两种状态同一图标，仅 aria/title 文案随折叠态变化。
  const collapseIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path></svg>';
  const collapseLabel = compact ? L('展开侧栏','Expand rail') : L('收起为数字栏','Collapse to numbers');
  el('railHead').innerHTML = '<span class="rh-title" title="'+esc(title)+'">'+esc(title)+'</span><button type="button" class="rail-collapse" data-act="toggle-rail" title="'+collapseLabel+'" aria-label="'+collapseLabel+'">'+collapseIcon+'</button>';
}
function railMode(){ return el('appRoot').getAttribute('data-rail') || 'full'; }
function isCompactRail(){ return railMode() !== 'full'; }
function setRailMode(mode){
  const root = el('appRoot');
  if(!mode || mode === 'full') root.removeAttribute('data-rail');
  else root.setAttribute('data-rail', mode);
  renderRailHead();
}
// 标题优先级：客户端生成的 title（Codex title 请求响应）> 首条 user prompt > 开始时间。
function sessionTitle(sess){
  if(!sess) return '会话';
  if(typeof sess.title === 'string' && sess.title.trim()) return short(sess.title.trim(), 56);
  const first = sessionFirstPrompt(sess);
  return first ? short(first, 56) : new Date(sess.startedAt).toLocaleString();
}
function sessionFirstPrompt(sess){
  if(!sess) return '';
  if(typeof sess.firstPrompt === 'string' && sess.firstPrompt.trim()){
    const stored = sess.firstPrompt.trim();
    return (sess.source === 'claude-cli' || sess.source === 'claude-vscode')
      ? stripLeadingNoiseTags(stored).trim()
      : stored;
  }
  // 向后兼容：旧 session 没存 firstPrompt，扣到实时 trace 里去抽。
  const list = (state.sessionTraces && state.sessionTraces[sess.id]) || [];
  for(const t of list){
    const text = firstUserPrompt(t);
    if(text) return text;
  }
  return '';
}
function isInternalMaintenancePrompt(value){
  const text = String(value || '').trim();
  return /^##\\s*Memory Writing Agent:\\s*Phase\\s+[12]\\b/i.test(text)
    || (text.indexOf('Analyze this rollout and produce JSON with ') === 0
      && text.indexOf('raw_memory') >= 0
      && text.indexOf('rollout_summary') >= 0
      && text.indexOf('rollout_slug') >= 0);
}
/**
 * 合并两组分桶（镜像后端 traceStore.mergeUsageBands）：同一 (档位, 时段, 短输出) 视为一桶。
 * 聚合用量时必须一起带上，否则分档模型的费用会因为缺分桶而永远显示 —。
 */
function mergeUsageBands(left, right){
  if(!left || !left.length) return (right && right.length) ? right.slice() : undefined;
  if(!right || !right.length) return left.slice();
  const merged = left.slice();
  for(const band of right){
    const index = merged.findIndex(item => (
      item.tier === band.tier && item.offPeak === band.offPeak && !!item.shortOutput === !!band.shortOutput
    ));
    if(index < 0){ merged.push(band); continue; }
    const current = merged[index];
    const next = {
      tier: band.tier,
      offPeak: band.offPeak,
      input: current.input + band.input,
      output: current.output + band.output,
      cacheRead: current.cacheRead + band.cacheRead,
      cacheCreation: current.cacheCreation + band.cacheCreation
    };
    if(band.shortOutput) next.shortOutput = true;
    if(current.cacheCreation5m !== undefined || band.cacheCreation5m !== undefined) next.cacheCreation5m = (current.cacheCreation5m || 0)+(band.cacheCreation5m || 0);
    if(current.cacheCreation1h !== undefined || band.cacheCreation1h !== undefined) next.cacheCreation1h = (current.cacheCreation1h || 0)+(band.cacheCreation1h || 0);
    merged[index] = next;
  }
  return merged;
}
function mergeModelUsage(target, source){
  const out = target || {};
  if(!source || typeof source !== 'object') return out;
  for(const model in source){
    const u = source[model]; if(!u) continue;
    const agg = out[model] || (out[model] = { version:2, input:0, output:0, cacheRead:0, cacheCreation:0, total:0, apiType:u.apiType, incompleteFields:[] });
    if(u.version !== 2) agg.incompleteFields.push('input');
    agg.input += u.input || 0; agg.output += u.output || 0;
    agg.cacheRead += u.cacheRead || 0; agg.cacheCreation += u.cacheCreation || 0;
    if(u.cacheCreation5m !== undefined || agg.cacheCreation5m !== undefined) agg.cacheCreation5m = (agg.cacheCreation5m || 0)+(u.cacheCreation5m || 0);
    if(u.cacheCreation1h !== undefined || agg.cacheCreation1h !== undefined) agg.cacheCreation1h = (agg.cacheCreation1h || 0)+(u.cacheCreation1h || 0);
    agg.total += u.total || 0;
    if(u.incompleteFields) agg.incompleteFields.push(...u.incompleteFields);
    agg.incompleteFields = Array.from(new Set(agg.incompleteFields));
    if(!agg.apiType && u.apiType) agg.apiType = u.apiType;
    agg.bands = mergeUsageBands(agg.bands, u.bands);
    if(!agg.servedModel && u.servedModel) agg.servedModel = u.servedModel;
  }
  return out;
}
function mergeAuxiliaryCounts(target, source){
  const out = target || {};
  if(!source || typeof source !== 'object') return out;
  for(const kind in source) out[kind] = (out[kind] || 0) + (Number(source[kind]) || 0);
  return out;
}
function logicalConversationSessions(rawSessions){
  const groups = new Map();
  for(const session of rawSessions || []){
    if(!session) continue;
    const source = sessionSource(session);
    const key = session.clientConversationKey
      ? source+'|'+session.clientConversationKey
      : source+'|session:'+session.id;
    const list = groups.get(key) || [];
    list.push(session);
    groups.set(key,list);
  }
  const out = [];
  for(const [logicalKey, fragments0] of groups){
    const fragments = fragments0.slice().sort((a,b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
    const activityAt = s => {
      const updated = s && s.updatedAt || '';
      const live = s && s.liveAt || '';
      return live > updated ? live : updated;
    };
    const requestEndAt = s => {
      if(s && s.lastRequestAt) return s.lastRequestAt;
      const startMs = Date.parse(s && s.startedAt || '');
      if(Number.isFinite(startMs) && typeof (s && s.durationMs) === 'number' && Number.isFinite(s.durationMs)){
        return new Date(startMs + Math.max(0, s.durationMs)).toISOString();
      }
      return s && (s.updatedAt || s.startedAt) || '';
    };
    // Hidden provider-transition/utility fragments belong to an existing
    // native Conversation, but a group with no visible owner must remain off
    // the user-facing dashboard.
    if(!fragments.some(s => s.hidden !== true)) continue;
    const representative = fragments.slice().sort((a,b) => activityAt(b).localeCompare(activityAt(a)))[0];
    const visiblePromptOwner = fragments.find(s => !isInternalMaintenancePrompt(s.firstPrompt));
    const visibleTitleOwner = fragments.find(s => s.title && !isInternalMaintenancePrompt(s.title));
    const lastMainOwner = fragments.slice()
      .sort((a,b) => activityAt(b).localeCompare(activityAt(a)))
      .find(s => typeof s.lastTurnError === 'boolean');
    const startedAt = fragments.reduce((v,s) => !v || s.startedAt < v ? s.startedAt : v, '');
    const lastRequestAt = fragments.reduce((v,s) => {
      const at = requestEndAt(s);
      return !v || at > v ? at : v;
    }, '');
    const updatedAt = fragments.reduce((v,s) => !v || (s.updatedAt || s.startedAt) > v ? (s.updatedAt || s.startedAt) : v, '');
    const liveAt = fragments.reduce((v,s) => !v || (s.liveAt || '') > v ? (s.liveAt || '') : v, '');
    const usageByModel = {};
    const auxiliaryCounts = {};
    let traceCount=0,totalTokens=0,errorCount=0,internalFragments=0;
    for(const s of fragments){
      traceCount += s.traceCount || 0; totalTokens += s.totalTokens || 0; errorCount += s.errorCount || 0;
      if(isInternalMaintenancePrompt(s.firstPrompt)) internalFragments += 1;
      mergeModelUsage(usageByModel,s.usageByModel);
      mergeAuxiliaryCounts(auxiliaryCounts,s.auxiliaryCounts);
    }
    const startedAtMs = Date.parse(startedAt || '');
    const lastRequestAtMs = Date.parse(lastRequestAt || '');
    const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(lastRequestAtMs)
      ? Math.max(0, lastRequestAtMs - startedAtMs)
      : undefined;
    out.push(Object.assign({}, representative, {
      startedAt, updatedAt, lastRequestAt, liveAt: liveAt || undefined,
      traceCount, totalTokens, errorCount,
      // Logical Conversation 也按最早请求到最晚请求计算，不使用当前时间。
      durationMs,
      firstPrompt: visiblePromptOwner ? visiblePromptOwner.firstPrompt : representative.firstPrompt,
      title: visibleTitleOwner ? visibleTitleOwner.title : undefined,
      firstModel: (visiblePromptOwner && visiblePromptOwner.firstModel) || representative.firstModel,
      firstClient: (visiblePromptOwner && visiblePromptOwner.firstClient) || representative.firstClient,
      lastTurnError: lastMainOwner ? lastMainOwner.lastTurnError : representative.lastTurnError,
      usageByModel,
      auxiliaryCounts,
      logicalConversationKey: logicalKey,
      fragmentIds: fragments.map(s => s.id),
      fragmentCount: fragments.length,
      internalFragmentCount: internalFragments,
      internalOnly: !visiblePromptOwner && fragments.every(s => isInternalMaintenancePrompt(s.firstPrompt))
    }));
  }
  return out.sort((a,b) => (b.liveAt || b.updatedAt || b.startedAt || '').localeCompare(a.liveAt || a.updatedAt || a.startedAt || ''));
}
function logicalConversationForSession(sessionId){
  const raw = (state.sessions || []).find(s => s.id === sessionId);
  if(!raw) return undefined;
  if(!raw.clientConversationKey) return raw;
  return logicalConversationSessions(state.sessions || []).find(s =>
    Array.isArray(s.fragmentIds) && s.fragmentIds.indexOf(sessionId) >= 0
  ) || raw;
}
function deleteTargetFragmentCount(rawSessions, sessionId){
  const target = (rawSessions || []).find(s => s && s.id === sessionId);
  if(!target) return 1;
  // Mirror TraceStore.deleteSession exactly. Dashboard grouping intentionally
  // excludes hidden maintenance buckets, but deletion includes every physical
  // fragment owned by the same native conversation.
  if(!target.clientConversationKey || !target.source) return 1;
  return Math.max(1, (rawSessions || []).filter(s => s
    && s.source === target.source
    && s.clientConversationKey === target.clientConversationKey).length);
}
// 多条 user 消息时跳过纯系统注入 wrapper（环境信息 / system-reminder / codex 自带的元数据等）
// 找第一条真实用户文本。跟后端 sessionBoundary.extractFingerprint 同语义，
// 也跟 claude-tap 的 _input_user_text 行为对齐。
function firstUserPrompt(t){
  if(t && t.auxiliary) return '';
  const body = bodyOf(t);
  const list = Array.isArray(body.messages) ? body.messages : (Array.isArray(body.input) ? body.input : []);
  for(const item of list){
    if(!item || typeof item !== 'object' || item.role !== 'user') continue;
    const parts = contentToParts(item.content);
    if(parts.length === 0) continue;
    const tagged = extractUserPromptFromParts(parts);
    if(tagged) return tagged;
    if(isNoiseOnlyParts(parts)) continue; // 整条只是 wrapper，跳到下一条 user
    const stripped = parts.map(p => stripNoiseTags(p)).join('\\n').trim();
    if(stripped) return stripped;
  }
  return '';
}
// Copilot 在 first user 消息里前置注入 <environment_info>/<workspace_info>/<userMemory>/... 大段上下文，
// 真正的用户输入裹在 <userRequest> 里；会话压缩后会裹在 <conversation-summary> 里。这里专门抽出来。
function extractUserPromptFromParts(parts){
  if(!Array.isArray(parts) || parts.length === 0) return '';
  const tags = ['userRequest','user_query','user_message','user_input','user_prompt','user_instructions','question'];
  for(let i = parts.length - 1; i >= 0; i--){
    const part = parts[i];
    if(typeof part !== 'string' || !part) continue;
    for(const tag of tags){
      const opens = (part.match(new RegExp('<' + tag + '\\\\b', 'gi')) || []).length;
      const closes = (part.match(new RegExp('<\\\\/' + tag + '\\\\s*>', 'gi')) || []).length;
      if(opens === 0 || opens !== closes) continue;
      const inner = takeLastBalancedPair(part, tag);
      if(inner) return inner;
    }
  }
  for(let i = parts.length - 1; i >= 0; i--){
    const part = parts[i];
    if(typeof part !== 'string' || !part) continue;
    for(const tag of tags){
      const inner = takeLastBalancedPair(part, tag);
      if(inner) return inner;
    }
  }
  return '';
}
function takeLastBalancedPair(part, tag){
  const openFullRe = new RegExp('<' + tag + '\\\\b[^>]*>', 'gi');
  let lastOpen = null; let m;
  while((m = openFullRe.exec(part))) lastOpen = m;
  if(!lastOpen) return '';
  const tailCloseRe = new RegExp('<\\\\/' + tag + '\\\\s*>', 'gi');
  tailCloseRe.lastIndex = lastOpen.index + lastOpen[0].length;
  const closeMatch = tailCloseRe.exec(part);
  if(!closeMatch) return '';
  return part.slice(lastOpen.index + lastOpen[0].length, closeMatch.index).trim();
}
function extractUserPrompt(text){
  if(typeof text !== 'string' || !text) return '';
  const tagged = extractUserPromptFromParts([text]);
  if(tagged) return tagged;
  return takeLastBalancedPair(text, 'conversation-summary') || '';
}
function isNoiseOnlyParts(parts){
  if(!Array.isArray(parts) || parts.length === 0) return true;
  if(extractUserPromptFromParts(parts)) return false;
  return parts.map(p => stripNoiseTags(p)).join('').trim().length === 0;
}
// 只用作 noise 整体性判定：剥光所有已知 wrapper 后是否为空。
function isNoiseOnly(text){
  if(typeof text !== 'string' || !text.trim()) return true;
  return isNoiseOnlyParts([text]);
}
function stripNoiseTags(text){
  if(typeof text !== 'string' || !text) return '';
  if(isLocalCommandCaveatPart(text)) return '';
  // 后端规则在生成 HTML 时直接注入，避免维护两份标签表再次漂移。
  const tags = ${promptNoiseTags};
  let out = text;
  for(const tag of tags){
    const re = new RegExp('<' + tag + '\\\\b[^>]*>[\\\\s\\\\S]*?<\\\\/' + tag + '>', 'gi');
    out = out.replace(re, '');
  }
  out = out.replace(/^\\s*#\\s+AGENTS\\.md instructions for [^\\r\\n]*(?:\\r?\\n[ \\t]*){2,}/i, '');
  return out.trim();
}
function normalizePromptNoiseText(text){
  return String(text || '').replace(/\\s+/g, ' ').trim();
}
function localCommandCaveatMatch(text, wholePart){
  const tag = ${localCommandCaveatTag};
  const suffix = wholePart ? '\\\\s*$' : '';
  const re = new RegExp('^\\\\s*<' + tag + '\\\\b[^>]*>([\\\\s\\\\S]*?)<\\\\/' + tag + '\\\\s*>' + suffix, 'i');
  const match = re.exec(String(text || ''));
  if(!match) return null;
  return normalizePromptNoiseText(match[1]) === normalizePromptNoiseText(${localCommandCaveatText}) ? match : null;
}
function isLocalCommandCaveatPart(text){
  return !!localCommandCaveatMatch(text, true);
}
function stripLeadingNoiseTags(text){
  let out = stripNoiseTags(text);
  const match = localCommandCaveatMatch(out, false);
  if(match) out = stripNoiseTags(out.slice(match[0].length));
  return out;
}
function contentToParts(c){
  if(typeof c === 'string') return c ? [c] : [];
  if(!Array.isArray(c)) return [];
  const parts = [];
  for(const b of c){
    if(typeof b === 'string'){ if(b) parts.push(b); continue; }
    if(b && typeof b === 'object'){
      if(typeof b.text === 'string' && b.text) parts.push(b.text);
      else if(typeof b.input_text === 'string' && b.input_text) parts.push(b.input_text);
      else if(typeof b.output_text === 'string' && b.output_text) parts.push(b.output_text);
    }
  }
  return parts;
}
function contentToText(c){
  return contentToParts(c).join('\\n');
}
/** 价格规则匹配：镜像后端 pricing.findModelPrice（tokens 全子串命中，首条生效）。 */
function findModelPrice(model){
  const id = String(model || '').toLowerCase();
  if(!id) return undefined;
  return PRICE_RULES.find(r => {
    if(r.match === 'exact'){
      const exactId = String(r.modelId || r.tokens[0] || '').toLowerCase();
      return exactId && (id === exactId || id.endsWith('/'+exactId));
    }
    return r.tokens.every(t => id.indexOf(String(t).toLowerCase()) >= 0);
  });
}
/**
 * 镜像后端 pricing.findModelPriceForUsage：一次请求可能带两个模型名（客户端请求的、
 * 上游回报的）。请求名优先——用量就是按它归集的、公开价目表也收录它——没有价时
 * 再用回报名兜底。
 */
function findModelPriceForUsage(model, servedModel){
  return findModelPrice(model)
    || (servedModel && servedModel !== model ? findModelPrice(servedModel) : undefined);
}
// 镜像后端 pricing.estimateCostUsd：按实际 usage 形状分流，而不是按模型供应商猜缓存口径。
function estimateCostUsd(u, price){
  const M = 1000000;
  // Version 1 rows only carry a mutually exclusive input bucket when the capture
  // was Anthropic Messages; a version 1 Responses row stored provider-native
  // total input and can no longer be split.
  const exclusiveInput = u.version === 2
    || (u.apiType ? u.apiType === 'messages' : price.protocol === 'anthropic');
  if(!exclusiveInput) return undefined;
  const policy = price.cacheWrite != null
    ? 'listed'
    : (price.cacheWritePolicy || ((price.providerId === 'openai' || price.providerId === 'deepseek' || price.providerId === 'xai') ? 'input' : (price.providerId === 'google' ? 'storage' : 'unknown')));
  // An absent field is not automatically unknown. Anthropic itemises both cache
  // fields on every response, so a missing one means we lost data; every
  // verified third party either has no separate cache-write charge or omits the
  // field when nothing was cached, making absence a definite zero.
  const anthropicPricing = price.protocol === 'anthropic' || price.providerId === 'anthropic';
  if(u.incompleteFields && u.incompleteFields.some(function(field){
    if(field === 'total') return false;
    if(field === 'input' || field === 'output') return true;
    return anthropicPricing;
  })) return undefined;
  // Token-hour cache storage cannot be derived from token counts.
  if(price.cacheStoragePerHour != null && u.cacheCreation > 0) return undefined;
  const banded = (price.tiers && price.tiers.length) || (price.peak && price.peak.peakWindowsUtc && price.peak.peakWindowsUtc.length);
  function rateFor(tier, offPeak, shortOutput){
    const band = price.tiers && price.tiers[tier];
    const scale = offPeak && price.peak ? price.peak.offPeakMultiplier : 1;
    const pick = v => (v == null ? undefined : v*scale);
    // Volcengine discounts the output rate for short replies inside a band; the
    // band records which side of that condition the request fell on.
    const baseOutput = shortOutput && band && band.shortOutput
      ? band.shortOutput.output
      : (band && band.output != null ? band.output : price.output);
    return {
      input: ((band && band.input != null ? band.input : price.input))*scale,
      output: baseOutput*scale,
      cacheRead: pick(band && band.cacheRead != null ? band.cacheRead : price.cacheRead),
      cacheWrite: pick(band && band.cacheWrite != null ? band.cacheWrite : price.cacheWrite)
    };
  }
  function charge(c, rates){
    if(c.cacheRead > 0 && rates.cacheRead == null) return undefined;
    const write5m = Math.min(c.cacheCreation, c.cacheCreation5m || 0);
    const after5m = Math.max(0, c.cacheCreation - write5m);
    const write1h = Math.min(after5m, c.cacheCreation1h || 0);
    const writeOther = Math.max(0, c.cacheCreation - write5m - write1h);
    const hasTtlBreakdown = c.cacheCreation5m !== undefined || c.cacheCreation1h !== undefined;
    if(price.protocol === 'anthropic' && c.cacheCreation > 0 && !hasTtlBreakdown) return undefined;
    const writePrice = rates.cacheWrite != null ? rates.cacheWrite : (policy === 'input' ? rates.input : (policy === 'free' ? 0 : undefined));
    const write1hPrice = price.cacheWrite1h != null ? price.cacheWrite1h : (price.protocol === 'anthropic' ? rates.input*2 : undefined);
    if((write5m > 0 || writeOther > 0) && writePrice == null) return undefined;
    if(write1h > 0 && write1hPrice == null) return undefined;
    return (c.input*rates.input + c.cacheRead*(rates.cacheRead || 0) + write5m*(writePrice || 0) + write1h*(write1hPrice || 0) + writeOther*(writePrice || 0) + c.output*rates.output)/M;
  }
  if(banded){
    // Length- and time-tiered rates are chosen per request. Without the per-band
    // split recorded at capture time there is no honest single rate for a total.
    if(!u.bands || !u.bands.length) return undefined;
    // Bands that do not add up to their usage would bill only the part they
    // cover and present the shortfall as a total; that happens whenever an
    // aggregate mixes banded usage with usage captured before banding existed.
    let bi = 0, bo = 0, br = 0, bc = 0;
    for(const band of u.bands){ bi += band.input; bo += band.output; br += band.cacheRead; bc += band.cacheCreation; }
    if(bi !== u.input || bo !== u.output || br !== u.cacheRead || bc !== u.cacheCreation) return undefined;
    let sum = 0;
    for(const band of u.bands){
      const part = charge(band, rateFor(band.tier, band.offPeak, band.shortOutput));
      if(part === undefined) return undefined;
      sum += part;
    }
    return sum;
  }
  return charge(u, { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite });
}
function fmtCost(v){
  if(v >= 100) return '$'+v.toFixed(0);
  if(v >= 1) return '$'+v.toFixed(2);
  return '$'+v.toFixed(4);
}
function sessionCostInfo(sess){
  const m = sess && sess.usageByModel;
  if(!m || typeof m !== 'object') return { cost: undefined, priced: 0, unpriced: 0 };
  let cost = 0, priced = 0, unpriced = 0;
  for(const model in m){
    const u = m[model];
    if(!u) continue;
    const price = findModelPriceForUsage(model, u.servedModel);
    if(!price){ unpriced += 1; continue; }
    const estimated = estimateCostUsd(u, price);
    if(estimated === undefined){ unpriced += 1; continue; }
    cost += estimated;
    priced += 1;
  }
  return { cost: priced ? cost : undefined, priced, unpriced };
}
function sessionCostTitle(info){
  if(!info || info.cost === undefined) return L('无模型费用数据或未匹配价格规则', 'No model usage or pricing rule matched');
  if(info.unpriced) return L('估算费用；另有 '+info.unpriced+' 个模型价格不完整，未计入', 'Estimated cost; '+info.unpriced+' incompletely priced models excluded');
  return L('估算费用', 'Estimated cost');
}
/** 会话总耗时：最早请求 startedAt 到最晚请求 startedAt；旧会话再回退累计字段。 */
function sessionDurationMs(sess){
  if(!sess) return 0;
  const start = Date.parse(sess.startedAt || '');
  const lastRequest = Date.parse(sess.lastRequestAt || '');
  if(Number.isFinite(start) && Number.isFinite(lastRequest)) return Math.max(0, lastRequest - start);
  if(typeof sess.durationMs === 'number' && Number.isFinite(sess.durationMs)) return sess.durationMs;
  const end = Date.parse(sess.updatedAt || '');
  if(!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}
/** 会话总耗时的可读展示：小于 1 分钟用秒，1 分钟内用秒，超过 1 分钟用 m/s，超过 1 小时用 h/m。 */
function sessionDurationText(ms){
  const n = Number(ms) || 0;
  if(n <= 0) return '—';
  if(n < 1000) return n + 'ms';
  const totalSec = Math.round(n / 1000);
  if(totalSec < 60) return totalSec + 's';
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if(totalMin < 60) return sec > 0 ? totalMin + 'm ' + sec + 's' : totalMin + 'm';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
}
/** 命中规则的一句话摘要，用作费用单元格 tooltip。 */
function priceRuleSummary(price){
  if(!price) return L('未匹配到价格规则', 'No pricing rule matched');
  const source = price.source === 'models.dev'
    ? ['models.dev', price.providerId, price.modelId].filter(Boolean).join(' / ')
    : (price.source || 'static');
  const ruleLabel = price.match === 'exact'
    ? (price.modelId || price.tokens[0] || '')
    : L('兜底规则：同时包含 ','Fallback rule: contains ')+price.tokens.join(' + ');
  const parts = [L('规则 ','Rule ')+ '「'+ruleLabel+'」', L('来源 ','source ')+source, L('输入 $','input $')+price.input+'/M', L('输出 $','output $')+price.output+'/M'];
  parts.push(price.cacheRead != null ? L('缓存读 $','cache read $')+price.cacheRead+'/M' : L('缓存读未公布','cache read unpublished'));
  if(price.cacheWrite != null){
    parts.push(L('缓存写 5m/默认 $','cache write 5m/default $')+price.cacheWrite+'/M');
  }else{
    const policy = price.cacheWritePolicy || ((price.providerId === 'openai' || price.providerId === 'deepseek' || price.providerId === 'xai') ? 'input' : (price.providerId === 'google' ? 'storage' : 'unknown'));
    parts.push(policy === 'input'
      ? L('缓存写按普通输入价','cache write uses normal input price')
      : policy === 'free'
        ? L('缓存写免费','cache write is free')
        : policy === 'storage'
          ? L('缓存写另计存储费，当前无法完整估算','cache storage is billed separately and cannot be fully estimated')
          : L('缓存写价格未核验','cache write price unverified'));
  }
  if(price.protocol === 'anthropic') parts.push(L('缓存写 1h $','Cache write 1h $')+(price.cacheWrite1h != null ? price.cacheWrite1h : price.input*2)+'/M');
  if(price.cacheStoragePerHour != null) parts.push(L('缓存存储 $','Cache storage $')+price.cacheStoragePerHour+L('/M·token·小时','/M-token-hour'));
  if(price.cacheWritePolicySource === 'official') parts.push(L('缓存语义来自官方','Cache semantics from vendor'));
  if(price.protocol === 'anthropic' && price.cacheWrite1h == null) parts.push(L('1h 档按官方 2× 输入价推导','1h tier derived as 2x input per vendor rule'));
  // One band per line. Packed onto one line this ran past ten clauses and became
  // unreadable in a native tooltip.
  if(price.tiers && price.tiers.length > 1){
    parts.push('');
    parts.push(L('按输入长度分档（档位同时作用于输出）：','Input-length bands (the band also applies to output):'));
    for(let i = 0; i < price.tiers.length; i += 1){
      const t = price.tiers[i];
      const next = price.tiers[i+1];
      const from = t.fromInputTokens ? Math.round(t.fromInputTokens/1000)+'K' : '0';
      const to = next ? Math.round(next.fromInputTokens/1000)+'K' : '∞';
      const cache = t.cacheRead != null ? L('，缓存读 $','，cache read $')+t.cacheRead : '';
      parts.push('  '+from+'–'+to+L(' token：输入 $',' tokens: input $')+t.input+L('，输出 $','，output $')+t.output+cache);
      if(t.shortOutput){
        parts.push('    '+L('输出 ≤'+t.shortOutput.atMostTokens+' token 时输出价 $'+t.shortOutput.output,
          'output $'+t.shortOutput.output+' when the reply is at most '+t.shortOutput.atMostTokens+' tokens'));
      }
    }
  }
  // Peak and off-peak on their own lines, on the reader's clock.
  if(price.peak && price.peak.peakWindowsUtc && price.peak.peakWindowsUtc.length){
    parts.push('');
    parts.push(L('分时段计费（本地时间）：','Time-of-day billing (local time):'));
    parts.push('  '+L('忙时 ','Peak ')+localPeakWindows(price)+L('：按上方价格','：rates above'));
    parts.push('  '+L('闲时（其余时段）：×','Off-peak (all other hours): x')+price.peak.offPeakMultiplier);
    parts.push('  '+L('厂商按 UTC 公布：','Published in UTC: ')+price.peak.peakWindowsUtc.map(w => w[0]+':00-'+w[1]+':00').join('、'));
  }
  // String.fromCharCode(10) rather than an escape: this script is emitted from a
  // TypeScript template literal, which consumes the escape before the JS ever
  // sees it and leaves the string literal broken across a real newline.
  return parts.filter(part => part != null).join(String.fromCharCode(10));
}
function priceSourceSummary(price){
  if(!price) return L('未核验','Unverified');
  // The model id is already column 1, so echoing it here only pushed the table
  // into horizontal overflow. Keep the catalogue and the provider.
  const base = price.source === 'models.dev'
    ? ['models.dev', price.providerId].filter(Boolean).join('/')
    : price.source === 'official'
      ? L('厂商官方','Vendor')
      : (price.source || 'static');
  const additions = [];
  // How much corroboration the rate has. A lone uncross-checked catalogue row is
  // where the known errors live - a retired qwen-vl-ocr snapshot at 16.7x the
  // real rate, a DeepSeek cache-read rate off by 10x - so it must not look as
  // settled as a vendor-published figure.
  if(price.priceSource === 'official') additions.push(L('牌价','list'));
  else if(price.priceSource === 'consensus') additions.push(L('交叉','checked'));
  else if(price.priceSource === 'single') additions.push(L('单源','single'));
  // Deliberately not repeated here: the official cache semantics and the derived
  // 1h tier are both already legible in the cache-write cells, and with 80 rows
  // the extra words pushed the 1280px table back into horizontal overflow. They
  // stay in the row tooltip.
  return additions.length ? base+' · '+additions.join(' · ') : base;
}
/** Band count and thresholds, for the rate cells and the row tooltip. */
function priceTierNote(price){
  if(!price || !price.tiers || price.tiers.length < 2) return '';
  const steps = price.tiers.slice(1).map(t => Math.round(t.fromInputTokens/1000)+'K').join(' / ');
  return L('按输入长度分 '+price.tiers.length+' 档，跳档点 '+steps,
    price.tiers.length+' input-length bands at '+steps);
}
/**
 * Vendors publish peak windows in UTC. A reader deciding whether a request is
 * cheap right now needs them on their own clock, so shift by the local offset and
 * say which clock is being shown.
 */
function localPeakWindows(price){
  if(!price || !price.peak || !price.peak.peakWindowsUtc || !price.peak.peakWindowsUtc.length) return '';
  const shift = -new Date().getTimezoneOffset()/60;
  const wrap = h => ((h % 24) + 24) % 24;
  const pad = h => (h < 10 ? '0' : '')+h+':00';
  return price.peak.peakWindowsUtc
    .map(w => pad(wrap(w[0]+shift))+'–'+pad(wrap(w[1]+shift)))
    .join('、');
}
function pricePeakNote(price){
  if(!price || !price.peak || !price.peak.peakWindowsUtc || !price.peak.peakWindowsUtc.length) return '';
  const utc = price.peak.peakWindowsUtc.map(w => w[0]+':00-'+w[1]+':00').join(', ');
  return L('忙时 本地 '+localPeakWindows(price)+'（UTC '+utc+'），其余时段 ×'+price.peak.offPeakMultiplier,
    'peak local '+localPeakWindows(price)+' (UTC '+utc+'), otherwise x'+price.peak.offPeakMultiplier);
}
/**
 * A tiered model's displayed rate is only its first band, so it must not read as
 * a flat rate - flattening these ladders is the same 2x-6x under-report the
 * public catalogues make.
 */
function rateCell(price, field){
  if(!price || price[field] == null) return '—';
  // Embeddings are a single forward pass with no output tokens; their rate cards
  // leave the column blank rather than printing a zero, and $0 would read as
  // "output is free" instead of "there is no output side".
  if(field === 'output' && price[field] === 0) return L('不适用','N/A');
  const banded = price.tiers && price.tiers.length > 1
    && price.tiers.some(t => t[field] != null && t[field] !== price[field]);
  return '$'+price[field]+(banded ? L(' 起',' +') : '');
}
function cacheWriteDisplay(price){
  if(!price) return '—';
  if(price.cacheWrite != null) return '$'+price.cacheWrite;
  const policy = price.cacheWritePolicy || ((price.providerId === 'openai' || price.providerId === 'deepseek' || price.providerId === 'xai') ? 'input' : (price.providerId === 'google' ? 'storage' : 'unknown'));
  if(policy === 'input') return L('按输入价','Input rate');
  // "$0" invites the reader to assume a cache exists and is free. The policy only
  // states that the vendor does not bill the write.
  if(policy === 'free') return L('未收费','Not charged');
  if(policy === 'storage') return L('另计存储','Storage');
  return '—';
}
function pricingStatus(price){
  if(!price) return L('缺少基础价格','Base price missing');
  const notes = [];
  if(price.tiers && price.tiers.length > 1) notes.push(L('分档','Banded'));
  if((price.tiers || []).some(t => t && t.shortOutput)) notes.push(L('短输出优惠','Short-reply discount'));
  if(price.peak && price.peak.peakWindowsUtc && price.peak.peakWindowsUtc.length){
    notes.push(L('分时段 闲时 ×'+price.peak.offPeakMultiplier, 'time-of-day, off-peak x'+price.peak.offPeakMultiplier));
  }
  const write = cacheWriteDisplay(price);
  const missing = [];
  if(price.cacheRead == null) missing.push(L('缓存读','cache read'));
  // A published storage fee already explains the cache-write bucket, so also
  // calling it unverified is both redundant and contradictory.
  if(write === '—' && price.cacheStoragePerHour == null) missing.push(L('缓存写','cache write'));
  if(price.cacheStoragePerHour != null){
    notes.push(L('另计存储 $'+Number(price.cacheStoragePerHour.toPrecision(2))+'/M·h',
      'storage $'+Number(price.cacheStoragePerHour.toPrecision(2))+'/M-h'));
  }else if(write === L('另计存储','Storage')){
    notes.push(L('缓存存储费未纳入','Cache storage excluded'));
  }
  if(missing.length) notes.push(L('未核验：','Unverified: ')+missing.join(' / '));
  else if(!notes.length) notes.push(L('已核验','Verified'));
  return notes.join('；');
}
function currentPricingModelIds(){
  const ids = new Set(Array.isArray(state.pricingModelIds) ? state.pricingModelIds : []);
  for(const s of state.sessions || []) for(const id in (s && s.usageByModel || {})) ids.add(id);
  for(const t of state.traces || []){
    const snap = (t.sse && t.sse.snapshot) || (t.response && t.response.snapshot);
    const id = (snap && snap.model) || (t.request && t.request.model);
    if(id) ids.add(id);
  }
  return Array.from(ids).filter(Boolean).sort((a,b)=>a.localeCompare(b));
}
function openPricing(){
  pricingReturnFocus = document.activeElement;
  let rows = '';
  const ids = currentPricingModelIds();
  for(const id of ids){
    const r = findModelPrice(id);
    const oneHour = r && r.protocol === 'anthropic' ? (r.cacheWrite1h != null ? r.cacheWrite1h : r.input*2) : undefined;
    rows += '<tr title="'+esc(priceRuleSummary(r))+'"><td>'+esc(id)+'</td><td class="proto">'+esc(r ? r.protocol : '—')+'</td><td>'+esc(priceSourceSummary(r))+'</td><td>'+esc(rateCell(r,'input'))+'</td><td>'+esc(rateCell(r,'output'))+'</td><td>'+esc(rateCell(r,'cacheRead'))+'</td><td>'+esc(cacheWriteDisplay(r))+'</td><td>'+(oneHour != null ? '$'+oneHour : '—')+'</td><td>'+esc(pricingStatus(r))+'</td></tr>';
  }
  el('pricingBody').innerHTML =
    (ids.length
      ? '<table class="pricing-table"><thead><tr><th>'+L('模型 ID','Model ID')+'</th><th>'+L('协议','Protocol')+'</th><th>'+L('来源','Source')+'</th><th>'+L('输入','Input')+'</th><th>'+L('输出','Output')+'</th><th>'+L('缓存读','Cache Read')+'</th><th>'+L('缓存写 5m/默认','Cache Write 5m/default')+'</th><th>'+L('缓存写 1h','Cache Write 1h')+'</th><th>'+L('状态','Status')+'</th></tr></thead><tbody>'+rows+'</tbody></table>'
      : '<div class="dash-matrix-note">'+L('当前没有可见或已使用的模型，价目表不会展示全局兜底规则。','No visible or used models. Global fallback rules are intentionally hidden.')+'</div>')+
    '<div class="pricing-note">'+L('· 这里只列出当前服务可见或 Trace 已使用的精确模型 ID；静态子串兜底规则不作为模型展示。<br>· 取价优先级：厂商官方牌价 &gt; 多源交叉一致 &gt; 单源。来源列会标出该行属于哪一档 —— 「单源未交叉」表示只有一个目录收录、未被第二个源确认，可信度最低。<br>· 海外模型优先采用厂商官方页，并用 Azure / AWS 的公开价目表交叉核对；国内模型优先采用厂商官方定价页。转售平台的报价只用于补齐官方未公布的缓存字段，且必须先与已知牌价对齐验证，其自身的折扣档与区域加价一律不采用。<br>· 标「起」的费率只是第一档。按输入长度分档的模型（阿里、火山、以及 OpenAI/Anthropic/Gemini 的长上下文加价），档位由单次请求的输入长度决定并同时作用于输出，费用按每次请求落入的档位分别累计，不会拍平成最低档。<br>· 标「分时段」的模型（如 DeepSeek）忙时闲时价格不同，按请求发生的时间分别累计。<br>· — 表示该字段未从可信来源核验，不会静默按输入价猜算。官方明确不单列写入费时显示「按输入价」；按存储时长计费的缓存显示「另计存储」，这部分无法从 Token 数推导，因此不计入费用。<br>· Anthropic 分开显示 5 分钟与 1 小时写入价。费用按实际捕获的 usage 口径计算；任何已使用但缺价的桶都会使该模型费用显示 —，并从合计中排除。<br>· 鼠标悬停任意一行可看到完整规则：命中的规则名、来源、各档费率、忙闲时段与缓存存储费。<br>· 兼容服务 实际结算价可能不同。','· Only exact model IDs visible from the current service or observed in Trace are listed. Static substring fallbacks are never presented as models.<br>· Rate priority: vendor list price &gt; agreement across independent catalogues &gt; single source. The source column says which applies; "single source" means one catalogue listed it and nothing confirmed it.<br>· Non-Chinese models prefer the vendor page cross-checked against the public Azure and AWS rate cards; Chinese models prefer the vendor pricing page. Resale platforms are read only to fill cache fields the vendor does not publish, only after their base rates match a known list price, and never for their own discount tiers or regional premiums.<br>· A rate marked "+" is only the first band. For length-banded models (Alibaba, Volcengine, and the long-context premiums OpenAI/Anthropic/Gemini charge) the band is chosen by the prompt length of each request and applies to output too, so cost accumulates per band instead of being flattened to the cheapest one.<br>· Models marked "Time-of-day" (DeepSeek) bill differently inside and outside peak hours, accumulated by request time.<br>· — means the field is not verified from a trusted source and is never silently guessed from input price. Providers that explicitly do not itemize cache writes show "Input rate"; duration-based cache storage shows "Storage" and is excluded because it cannot be derived from token counts.<br>· Anthropic 5-minute and 1-hour writes are shown separately. Cost follows captured usage semantics; any used bucket with an unknown price makes that model cost unavailable and excludes it from the total.<br>· Hover any row for the full rule: matched rule, source, per-band rates, peak windows and cache storage fee.<br>· Internal 兼容服务 billing may differ.')+'</div>';
  el('pricingOv').classList.add('on');
  el('pricingClose').focus();
}
function closePricing(){ el('pricingOv').classList.remove('on'); if(pricingReturnFocus && typeof pricingReturnFocus.focus === 'function') pricingReturnFocus.focus(); pricingReturnFocus = null; }
function renderTokenMatrix(sessions){
  // 聚合受当前 source 过滤器影响（调用方传进来的已是过滤后的 sessions）。
  // 复用 mergeModelUsage：这里曾抄过一份聚合逻辑，结果分桶和缓存写 TTL 两处口径
  // 各自漂移——把 cacheCreation5m/1h 预置成 0 会让「没有 TTL 拆分」看起来像「拆分是 0」，
  // 于是 1 小时写入被按 5 分钟价计。
  let byModel = {};
  let legacySessions = 0;
  for(const s of sessions){
    const m = s.usageByModel;
    if(!m || typeof m !== 'object'){
      if((s.totalTokens || 0) > 0) legacySessions += 1;
      continue;
    }
    byModel = mergeModelUsage(byModel, m);
  }
  const models = Object.keys(byModel).sort((a,b) => byModel[b].total - byModel[a].total);
  if(!models.length){
    return '<div class="dash-matrix-wrap"><div class="dash-matrix-note">'+L('还没有带模型划分的会话数据（历史会话不回填，新请求开始累计）。','No per-model usage yet. Older sessions are not backfilled; new requests will accumulate here.')+'</div></div>';
  }
  const sum = { input:0, output:0, cacheRead:0, cacheCreation:0, total:0, cost:0 };
  let unpriced = 0, priced = 0;
  let rows = '';
  // 缺一项不等于丢了数据。星号只留给「本该有、却没拿到」的字段：输入/输出，
  // 以及 Anthropic 的缓存桶（它每次都逐项返回，缺了就是真丢了）。其余服务要么
  // 不单列缓存写、要么没写入时干脆不给这个字段，那种缺失我们本来就按 0 计费——
  // 既然照 0 收，就不该再挂一个「无法可靠推导」的警告让用户以为账不准。
  const absenceLosesData = (name, price) => {
    if(name === 'input' || name === 'output' || name === 'total') return true;
    return !!price && (price.protocol === 'anthropic' || price.providerId === 'anthropic');
  };
  const sumLost = new Set();
  for(const model of models){
    const u = byModel[model];
    const price = findModelPriceForUsage(model, u.servedModel);
    const cost = price ? estimateCostUsd(u, price) : undefined;
    if(cost === undefined) unpriced += 1; else { sum.cost += cost; priced += 1; }
    sum.input += u.input; sum.output += u.output; sum.cacheRead += u.cacheRead; sum.cacheCreation += u.cacheCreation; sum.total += u.total;
    for(const name of (u.incompleteFields || [])) if(absenceLosesData(name, price)) sumLost.add(name);
    const field = (name,value) => {
      if(!(u.incompleteFields || []).includes(name)) return num(value);
      return absenceLosesData(name, price)
        ? '<span title="'+esc(L('云端未返回且无法可靠推导','Not returned by the service and cannot be derived reliably'))+'">—*</span>'
        : '<span title="'+esc(L('该服务不单独返回这一项，费用按未产生计算','The service does not report this bucket separately; cost treats it as none'))+'">—</span>';
    };
    // 上游回报的名字和请求名不同时要说出来，否则用户会以为我们认错了模型。
    const nameCell = u.servedModel
      ? '<span title="'+esc(L('上游回报的模型名：'+u.servedModel,'Reported by the service as '+u.servedModel))+'">'+esc(model)+' <span class="model-served">*</span></span>'
      : esc(model);
    rows += '<tr><td>'+nameCell+'</td><td>'+field('input',u.input)+'</td><td>'+field('cacheRead',u.cacheRead)+'</td><td>'+field('cacheWrite',u.cacheCreation)+'</td><td>'+field('output',u.output)+'</td><td>'+field('total',u.total)+'</td><td'+(cost === undefined ? ' class="cost-na"' : '')+' title="'+esc(priceRuleSummary(price))+'">'+(cost === undefined ? '—' : fmtCost(cost))+'</td></tr>';
  }
  // 合计只在真丢了数据时打星；某个模型不报的桶按 0 计入，合计仍然给得出来。
  const sumField = (name,value) => sumLost.has(name)
    ? '<span title="'+esc(L('部分会话缺少该字段或仍是旧口径','Some sessions lack this field or still use legacy semantics'))+'">—*</span>'
    : num(value);
  const notes = [];
  notes.push(L('费用按已核验公开牌价估算；缺少实际用到的缓存字段价格或存在按时长计费的存储费时显示 —，不再静默猜价。','Cost uses verified public prices. Missing prices for used cache buckets or duration-based storage charges show — instead of a silent guess.'));
  if(unpriced) notes.push(L(unpriced+' 个模型费用不完整，未计入合计。', unpriced+' models have incomplete pricing and are excluded from the total.'));
  if(legacySessions) notes.push(L(legacySessions+' 个旧会话无模型划分数据，未计入矩阵（但计入上方 Total Tokens）。', legacySessions+' legacy sessions have no per-model usage and are excluded from the matrix.'));
  return '<div class="dash-matrix-wrap"><table class="dash-matrix">'+
    '<thead><tr><th>'+L('模型','Model')+'</th><th>'+L('未缓存输入','Uncached Input')+'</th><th>'+L('缓存读','Cache Read')+'</th><th>'+L('缓存写','Cache Write')+'</th><th>'+L('输出','Output')+'</th><th>'+L('总 Token','Total Tokens')+'</th><th>'+L('估算费用','Est. Cost')+'</th></tr></thead>'+
    '<tbody>'+rows+'</tbody>'+
    '<tfoot><tr><td>总计</td><td>'+sumField('input',sum.input)+'</td><td>'+sumField('cacheRead',sum.cacheRead)+'</td><td>'+sumField('cacheWrite',sum.cacheCreation)+'</td><td>'+sumField('output',sum.output)+'</td><td>'+sumField('total',sum.total)+'</td><td>'+(priced ? fmtCost(sum.cost)+(unpriced ? '*' : '') : '—')+'</td></tr></tfoot>'+
    '</table><div class="dash-matrix-note">'+esc(notes.join(' '))+'<button class="note-link" data-open-pricing>'+L('查看完整价目表','Pricing table')+'</button></div></div>';
}
function renderDashboard(){
  const allLogicalSessions = logicalConversationSessions(state.sessions || []);
  const allSessions = allLogicalSessions.filter(s => !s.internalOnly);
  const activeSource = state.dashSourceFilter || 'all';
  const sessions = activeSource === 'all' ? allSessions : allSessions.filter(s => sourceFamily(sessionSource(s)) === activeSource);
  // 聚合统计：全部来自 session summary 的累加字段，不再扫 sessionTraces，避免随历史增长拖慢。
  let totalTraces = 0, totalTok = 0, totalErr = 0, totalCost = 0;
  for(const s of sessions){
    totalTraces += s.traceCount || 0;
    totalTok += s.totalTokens || 0;
    totalErr += s.errorCount || 0;
    const costInfo = sessionCostInfo(s);
    if(costInfo.cost !== undefined) totalCost += costInfo.cost;
  }
  const errorPct = totalTraces ? (totalErr * 100) / totalTraces : 0;
  const errorRate = totalTraces ? errorPct.toFixed(1) + '%' : '0.0%';
  const filters = [
    { id:'all', label:L('全部','All') },
    { id:'claude-cli', label:'Claude' },
    { id:'codex-cli', label:'ChatGPT' }
  ].map(f => '<button class="dash-filter'+(f.id===activeSource?' active':'')+'" data-sfilter="'+esc(f.id)+'">'+esc(f.label)+'</button>').join('');
  const hero = common.tokenCostPresentation({
    showCost: tokenMatrixOpen,
    tokens: totalTok,
    costUsd: totalCost,
    language: uiLang,
    compact: true
  });
  const heroValue = hero.unit === '$'
    ? '$' + hero.value
    : hero.value + (hero.unit ? '<span class="u">' + esc(hero.unit) + '</span>' : '');
  let html = '<div class="dash">'+
    '<div class="dash-hero">'+
      '<div class="dash-hero-main" data-toggle-matrix role="button" tabindex="0" aria-expanded="'+(tokenMatrixOpen?'true':'false')+'" aria-label="'+esc(hero.toggleHint)+'" title="'+esc(hero.toggleHint)+'">'+
        '<div class="dash-hero-label">'+esc(hero.label)+'</div>'+
        '<div class="dash-hero-num">'+heroValue+'</div>'+
      '</div>'+
      '<div class="dash-hero-side">'+
        '<div class="dash-hero-stat"><div class="dash-hs-label">'+L('会话','Sessions')+'</div><div class="dash-hs-val">'+num(sessions.length)+'</div></div>'+
        '<div class="dash-hero-stat"><div class="dash-hs-label">'+L('请求','Requests')+'</div><div class="dash-hs-val">'+num(totalTraces)+'</div></div>'+
        '<div class="dash-hero-stat"><div class="dash-hs-label">'+L('错误率','Error Rate')+'</div><div class="dash-hs-val '+(errorPct<5?'ok':'err')+'">'+esc(errorRate)+'</div></div>'+
      '</div>'+
    '</div>'+
    (tokenMatrixOpen ? renderTokenMatrix(sessions) : '')+
    '<div class="dash-filters"><span class="seg-thumb"></span>'+filters+'</div>';
  if(!sessions.length){
    const emptyCopy = allSessions.length
      ? L('当前筛选下没有会话。','No sessions match this filter.')+' <button class="note-link" data-sfilter="all">'+L('查看全部','Show all')+'</button>'
      : state.active
        ? L('捕获已开启，正在等待 Claude 或 ChatGPT 的第一个请求。','Capture is on and waiting for the first Claude or ChatGPT request.')
        : L('尚未记录会话。请在 XwX Deck 中开始捕获，然后发起一次 Claude 或 ChatGPT 请求。','No sessions recorded yet. Start capture in XwX Deck, then send a Claude or ChatGPT request.');
    html += '<div class="dash-empty">'+emptyCopy+'</div></div>';
    el('dashboard').innerHTML = html;
    positionSegThumbs(el('dashboard'));
    return;
  }
  html += '<div class="dash-table-wrap"><table class="dash-table"><colgroup>'+
    DASH_COL_ORDER.map(id => '<col data-col="'+id+'"'+(id==='model'?' class="col-model"':id==='source'?' class="col-src"':'')+'>').join('')+
    '<col class="col-spacer"></colgroup><thead><tr>'+
    dashHead('started', L('开始时间','Started'))+
    dashHead('first', L('首条消息','First Message'))+
    dashHead('source', L('来源','Source'), 'col-src')+
    dashHead('model', L('模型','Model'), 'col-model')+
    dashHead('duration', L('耗时','Duration'), 'num')+
    dashHead('requests', L('请求','Requests'), 'num')+
    dashHead('tokens', 'Tokens', 'num')+
    dashHead('cost', 'Cost', 'num')+
    dashHead('status', L('状态','Status'), 'col-status')+
    dashHead('actions', L('操作','Actions'), 'col-del')+
    '<th class="col-spacer" aria-hidden="true"></th>'+
  '</tr></thead><tbody>';
  for(const s of sessions){
    const tok = s.totalTokens || 0;
    const costInfo = sessionCostInfo(s);
    const first = sessionFirstPrompt(s);
    // 展示标题：客户端生成的 title 优先，firstPrompt 兜底；tooltip 始终给完整 firstPrompt。
    const display = (typeof s.title === 'string' && s.title.trim()) ? s.title.trim() : first;
    const model = s.firstModel || sessionFirstModelFromCache(s) || '—';
    const src = sessionSource(s);
    const lastTs = Math.max(
      (s.updatedAt && Date.parse(s.updatedAt)) || 0,
      (s.liveAt && Date.parse(s.liveAt)) || 0
    );
    const isLive = state.active && lastTs && (Date.now() - lastTs) < 30000;
    // ERR 仅在「最后一次主回合失败」时才挂：中途 5xx 但后续主回合恢复 → OK，不再标红。
    // aux/subagent trace 不影响 lastTurnError —— 它们失败不阻止用户继续对话。
    const hasError = s.lastTurnError === true;
    const statusClass = isLive ? 'live' : (hasError ? 'err' : 'ok');
    const statusLabel = isLive ? 'LIVE' : (hasError ? 'ERR' : 'OK');
    const durMs = sessionDurationMs(s);
    html += '<tr data-sid="'+esc(s.id)+'" tabindex="0" aria-label="'+esc(L('打开会话：','Open session: ')+(display || L('无 user message','no user message')))+'">'+
      '<td class="dash-time" data-col="started">'+esc(new Date(s.startedAt).toLocaleString())+'</td>'+
      '<td class="dash-first" data-col="first" title="'+esc(first || display)+'">'+esc(short(display || L('(无 user message)','(no user message)'), 80))+
        '<div class="dash-first-meta">'+esc(model)+' · '+esc(sourceLabel(src))+'</div>'+
      '</td>'+
      '<td class="col-src" data-col="source"><span class="src-tag src-'+esc(src)+'">'+esc(sourceLabel(src))+'</span></td>'+
      '<td class="dash-model col-model" data-col="model">'+esc(model)+'</td>'+
      '<td class="dash-num dash-dur" data-col="duration">'+sessionDurationText(durMs)+'</td>'+
      '<td class="dash-num" data-col="requests">'+num(s.traceCount || 0)+'</td>'+
      '<td class="dash-num" data-col="tokens">'+num(tok)+'</td>'+
      '<td class="dash-cost'+(costInfo.cost === undefined ? ' cost-na' : '')+'" data-col="cost" title="'+esc(sessionCostTitle(costInfo))+'">'+(costInfo.cost === undefined ? '—' : fmtCost(costInfo.cost))+'</td>'+
      '<td class="col-status" data-col="status"><span class="dash-status '+statusClass+'">'+statusLabel+'</span></td>'+
     '<td class="dash-del" data-col="actions"><button type="button" class="del-btn" data-act="delete" data-sid="'+esc(s.id)+'" aria-label="'+esc(L('删除该会话','Delete session'))+'" title="'+esc(L('删除','Delete'))+'"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button></td>'+
     '<td class="col-spacer" aria-hidden="true"></td>'+
    '</tr>';
  }
  html += '</tbody></table></div></div>';
  el('dashboard').innerHTML = html;
  applyDashColumnWidths(el('dashboard'));
  bindDashColumnResize(el('dashboard'));
  bindDashWrapResize(el('dashboard'));
  positionSegThumbs(el('dashboard'));
}

/** 取代表 source：优先 session summary 累加字段，缺时回退到已缓存的 trace 列表。 */
function sessionSource(sess){
  if(sess && sess.source) return sess.source;
  const list = (state.sessionTraces && state.sessionTraces[sess.id]) || [];
  for(const t of list){
    if(t && t.source) return t.source;
  }
  return 'copilot';
}

/** session.firstModel 兜底：仅旧 index.json 没字段时回到内存中已加载的 trace 列表里翻。 */
function sessionFirstModelFromCache(sess){
  const list = (state.sessionTraces && state.sessionTraces[sess.id]) || [];
  if(list.length && list[0].request && list[0].request.model) return list[0].request.model;
  return '';
}

function sourceLabel(src){
  if(src === 'claude-cli') return 'Claude';
  if(src === 'claude-vscode') return 'Claude';
  if(src === 'codex-cli') return 'ChatGPT';
  if(src === 'codex-vscode') return 'ChatGPT';
  if(src === 'unknown') return 'Unknown';
  return 'Copilot';
}
function sourceFamily(src){
  if(src === 'claude-vscode') return 'claude-cli';
  if(src === 'codex-vscode') return 'codex-cli';
  return src;
}
function routeHref(sid){
  const base = window.location.pathname + window.location.search;
  return sid ? base + '#session=' + encodeURIComponent(sid) : base;
}
function routeSessionId(){
  const hash = window.location.hash || '';
  if(!hash.startsWith('#')) return '';
  const params = new URLSearchParams(hash.slice(1));
  return params.get('session') || '';
}
function captureDashboardContext(focusSessionId){
  const dashboard = el('dashboard');
  const active = document.activeElement;
  const activeRow = active && active.closest ? active.closest('tr[data-sid]') : null;
  return {
    sourceFilter: state.dashSourceFilter || 'all',
    scrollTop: dashboard ? dashboard.scrollTop : 0,
    tokenMatrixOpen,
    focusSessionId: focusSessionId || (activeRow ? activeRow.dataset.sid : '')
  };
}
function restoreDashboardContext(context){
  if(!context) return;
  state.dashSourceFilter = context.sourceFilter || 'all';
  tokenMatrixOpen = context.tokenMatrixOpen === true;
  const restore = () => {
    const dashboard = el('dashboard');
    if(!dashboard) return;
    dashboard.scrollTop = Math.max(0, Number(context.scrollTop) || 0);
    if(!context.focusSessionId) return;
    const rows = Array.from(dashboard.querySelectorAll('tr[data-sid]'));
    const row = rows.find(node => node.dataset.sid === context.focusSessionId);
    if(row && typeof row.focus === 'function') row.focus({ preventScroll: true });
  };
  if(typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
  else setTimeout(restore, 0);
}
function writeSessionRoute(sid, context){
  const returnContext = context || captureDashboardContext(sid);
  history.replaceState({ [ROUTE_STATE_KEY]: 'dashboard', context: returnContext }, '', routeHref());
  history.pushState(
    { [ROUTE_STATE_KEY]: 'session', sessionId: sid, returnContext },
    '',
    routeHref(sid)
  );
}
function replaceSessionRouteContext(){
  const current = history.state;
  if(!current || current[ROUTE_STATE_KEY] !== 'session') return;
  history.replaceState({ ...current, requestId: selectedId || undefined }, '', window.location.href);
}
function navigateToDashboard(){
  if(view !== 'session'){
    gotoDashboard({ context: dashboardReturnContext });
    return;
  }
  const current = history.state;
  if(current && current[ROUTE_STATE_KEY] === 'session'){
    history.back();
    return;
  }
  gotoDashboard({ context: dashboardReturnContext });
}
function handleTracePopState(){
  const sid = routeSessionId();
  const current = history.state || {};
  if(sid){
    const context = current.returnContext || dashboardReturnContext;
    dashboardReturnContext = context || dashboardReturnContext;
    gotoSession(sid, {
      history: 'none',
      context,
      requestId: current.requestId
    });
    return;
  }
  const context = current.context || dashboardReturnContext;
  dashboardReturnContext = context || dashboardReturnContext;
  gotoDashboard({ context });
}
function gotoSession(sid, options){
  if(!sid) return;
  const opts = options || {};
  const requestedId = typeof opts.requestId === 'string' && opts.requestId ? opts.requestId : '';
  const restoringHistory = !!requestedId;
  const returnContext = opts.context || (view === 'dashboard' ? captureDashboardContext(sid) : dashboardReturnContext);
  if(view === 'dashboard') dashboardReturnContext = returnContext;
  selectedSessionId = sid;
  selectedId = undefined;
  followLatest = true;
  view = 'session';
  if(opts.history !== 'none') writeSessionRoute(sid, returnContext);
  railWinDirty = true;  // 切会话时重建分批渲染窗口
  // 切到 session 视图先按当前缓存渲染一帧（dashboard 启动时除当前 session 外其它都是空）。
  // 注意：dashboard 期间 SSE 只把"新到的" trace 增量塞进 bucket（mergeTrace），
  // 历史 trace 不在其中——所以缓存桶往往是残缺的（只含最近几条，turn 从大数起跳）。
  // 因此 LIVE 模式下：缓存命中只用于"先渲染一帧"占位，仍必须异步拉一次全量覆盖，
  // 否则列表行数 / 进度条分母与文件实际 trace 数对不上。
  // A normal dashboard/session open is a fresh navigation: do not let a
  // partially loaded middle page from an earlier visit decide the initial
  // selection or pagination bounds. Browser back/forward is different: it has
  // an explicit requestId and may restore the user's previous inspection point.
  if(LIVE_MODE && !restoringHistory){
    if(state.sessionTraces) delete state.sessionTraces[sid];
    if(sessionTraceMeta) delete sessionTraceMeta[sid];
  }
  const cached = (!LIVE_MODE || restoringHistory)
    ? ((state.sessionTraces && state.sessionTraces[sid]) || (sid === state.currentSessionId ? state.traces : undefined))
    : undefined;
  if(cached && cached.length){
    state.sessionTraces = state.sessionTraces || {};
    state.sessionTraces[sid] = cached;
    selectedId = requestedId && cached.some(t => t.id === requestedId)
      ? requestedId
      : cached[cached.length - 1].id;
    replaceSessionRouteContext();
    if(opts.render !== false) render();
    revealRailSelection(false);
    if(LIVE_MODE) void loadSessionTraces(sid, {
      replace: false,
      requestId: requestedId,
      selectLatest: false
    });
    return;
  }
  if(LIVE_MODE) sessionLoadState[sid] = 'loading';
  if(opts.render !== false) render();
  void loadSessionTraces(sid, { replace: true, selectLatest: true });
}
function gotoDashboard(options){
  const opts = options || {};
  const context = opts.context || dashboardReturnContext;
  if(context) restoreDashboardContext(context);
  view = 'dashboard';
  render();
  if(context) restoreDashboardContext(context);
}

function sessionPageUrl(sid, offset, limit){
  const params = new URLSearchParams();
  if(typeof offset === 'number') params.set('offset', String(offset));
  params.set('limit', String(limit || SESSION_PAGE_SIZE));
  return 'api/session/' + encodeURIComponent(sid) + '?' + params.toString();
}
async function fetchSessionPage(sid, offset, limit){
  const res = await fetch(sessionPageUrl(sid, offset, limit), { cache:'no-store' });
  if(!res.ok) throw new Error(L('读取会话失败（HTTP '+res.status+'）','Could not load session (HTTP '+res.status+')'));
  const data = await res.json();
  if(!data || !Array.isArray(data.traces)) throw new Error(L('会话数据格式无效','Session data is invalid'));
  return data;
}
function mergeSessionPage(sid, page){
  state.sessionTraces = state.sessionTraces || {};
  const prev = state.sessionTraces[sid] || [];
  const incoming = Array.isArray(page && page.traces) ? page.traces : [];
  const beforeFirst = prev.reduce((first, trace) => !first || compareTraceDisplayOrder(trace, first) < 0 ? trace : first, undefined);
  const byId = new Map(prev.map(t => [t.id, t]));
  let addedBefore = 0;
  for(const t of incoming){
    if(!t || !t.id) continue;
    if(!byId.has(t.id)){
      if(beforeFirst && compareTraceDisplayOrder(t, beforeFirst) < 0) addedBefore++;
      byId.set(t.id, t);
    } else {
      byId.set(t.id, t);
    }
  }
  const list = Array.from(byId.values()).sort(compareTraceDisplayOrder);
  state.sessionTraces[sid] = list;
  const offsets = [typeof page.offset === 'number' ? page.offset : 0];
  const prevMeta = sessionTraceMeta[sid];
  if(prevMeta && typeof prevMeta.offset === 'number') offsets.push(prevMeta.offset);
  const offset = Math.max(0, Math.min.apply(Math, offsets));
  const total = Math.max(
    typeof page.total === 'number' ? page.total : 0,
    prevMeta && typeof prevMeta.total === 'number' ? prevMeta.total : 0,
    offset + list.length
  );
  sessionTraceMeta[sid] = {
    offset,
    limit: typeof page.limit === 'number' ? page.limit : SESSION_PAGE_SIZE,
    total,
    hasMoreBefore: offset > 0,
    hasMoreAfter: offset + list.length < total
  };
  // total is the logical Conversation total. state.sessions still contains
  // physical Session summaries, which the dashboard groups and sums itself.
  // Writing the logical total into one physical fragment double-counts all
  // sibling fragments after the user returns from detail to the dashboard.
  return { list, addedBefore };
}
function replaceSessionPage(sid, page){
  state.sessionTraces = state.sessionTraces || {};
  const list = (Array.isArray(page && page.traces) ? page.traces : [])
    .filter(t => t && t.id)
    .sort(compareTraceDisplayOrder);
  state.sessionTraces[sid] = list;
  const offset = Math.max(0, typeof page.offset === 'number' ? page.offset : 0);
  const total = Math.max(
    typeof page.total === 'number' ? page.total : 0,
    offset + list.length
  );
  sessionTraceMeta[sid] = {
    offset,
    limit: typeof page.limit === 'number' ? page.limit : SESSION_PAGE_SIZE,
    total,
    hasMoreBefore: offset > 0,
    hasMoreAfter: offset + list.length < total
  };
  return { list, addedBefore: 0 };
}
function revealRailSelection(preferLatest){
  const reveal = () => {
    if(view !== 'session') return;
    const list = el('traceList');
    if(!list) return;
    const selected = list.querySelector('.row.on');
    if(selected && typeof selected.scrollIntoView === 'function'){
      selected.scrollIntoView({ block: preferLatest ? 'end' : 'nearest' });
    } else if(preferLatest){
      list.scrollTop = list.scrollHeight;
    }
  };
  if(typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
  else setTimeout(reveal, 0);
}
/** 懒加载单个 session 的尾页 trace；只在 live 模式下走 HTTP（静态 HTML 没有 server）。 */
async function loadSessionTraces(sid, options){
  if(!sid || !LIVE_MODE) return;
  const opts = options || {};
  sessionLoadState[sid] = 'loading';
  delete sessionLoadErrors[sid];
  try {
    const data = await fetchSessionPage(sid, undefined, SESSION_PAGE_SIZE);
    if(!data) return;
    const merged = opts.replace === false
      ? mergeSessionPage(sid, data)
      : replaceSessionPage(sid, data);
    const list = merged.list;
    delete sessionLoadState[sid];
    // 仍停在该 session 视图时再 render；用户已切走则不抢屏。
    if(view === 'session' && selectedSessionId === sid){
      const requestedId = typeof opts.requestId === 'string' ? opts.requestId : '';
      if(requestedId && list.some(t => t.id === requestedId)) selectedId = requestedId;
      else if((opts.selectLatest !== false || !selectedId) && list.length) selectedId = list[list.length - 1].id;
      replaceSessionRouteContext();
      render();
      revealRailSelection(opts.selectLatest !== false);
    }
  } catch (err) {
    sessionLoadErrors[sid] = err && err.message ? err.message : L('读取会话失败','Could not load session');
  }
  finally {
    if(sessionLoadState[sid] === 'loading') delete sessionLoadState[sid];
    if(view === 'session' && selectedSessionId === sid && !currentTrace()) render();
  }
}
async function loadAdjacentSessionPage(edge){
  if(!LIVE_MODE || !selectedSessionId) return false;
  const sid = selectedSessionId;
  const meta = sessionTraceMeta[sid];
  const loaded = (state.sessionTraces && state.sessionTraces[sid]) || [];
  if(!meta || !loaded.length) return false;
  let offset;
  let limit = Math.max(1, Math.min(SESSION_PAGE_SIZE, meta.limit || SESSION_PAGE_SIZE));
  if(edge === 'top'){
    if(!meta.hasMoreBefore) return false;
    offset = Math.max(0, meta.offset - limit);
    limit = Math.max(1, meta.offset - offset);
  } else {
    if(!meta.hasMoreAfter) return false;
    offset = meta.offset + loaded.length;
  }
  sessionLoadState[sid] = 'loading';
  try {
    const page = await fetchSessionPage(sid, offset, limit);
    if(!page) return false;
    const rail = el('traceList');
    const beforeHeight = rail ? rail.scrollHeight : 0;
    const beforeScrollTop = rail ? rail.scrollTop : 0;
    const beforeStart = railWinStart;
    const beforeEnd = railWinEnd;
    const merged = mergeSessionPage(sid, page);
    if(edge === 'top' && merged.addedBefore > 0){
      // 这里已经走到内存窗口的顶端，新页应直接进入 DOM。
      // 旧实现同时右移 start/end，实际上又把新页藏在“上面还有”占位行后，需要用户再滚一次。
      railWinStart = beforeStart;
      railWinEnd = beforeEnd + merged.addedBefore;
      railWinDirty = false;
    }
    railLoadingEdge = '';
    if(sessionLoadState[sid] === 'loading') delete sessionLoadState[sid];
    if(view === 'session' && selectedSessionId === sid){
      render();
      if(edge === 'top' && merged.addedBefore > 0){
        const nextRail = el('traceList');
        if(nextRail) nextRail.scrollTop = beforeScrollTop + Math.max(0, nextRail.scrollHeight - beforeHeight);
      }
      return true;
    }
  } catch (err) {
    toast(err && err.message ? err.message : L('加载更多请求失败','Could not load more requests'));
  }
  finally {
    if(sessionLoadState[sid] === 'loading') delete sessionLoadState[sid];
    railLoadingEdge = '';
  }
  return false;
}
let _confirmDeleteResolver = null;
function confirmDeleteSession(sid){
  const ov = el('confirmDeleteOv');
  if(!ov) return Promise.resolve(false);
  const fragments = deleteTargetFragmentCount(state.sessions || [], sid);
  const title = el('confirmDeleteTitle');
  const body = el('confirmDeleteBody');
  if(title) title.textContent = L('删除这段对话的全部 Trace？','Delete all traces for this conversation?');
  if(body) body.textContent = fragments > 1
    ? L('将永久删除这段对话的 '+fragments+' 个存储片段及全部请求记录，此操作不可撤销。',
        'This permanently deletes all requests across '+fragments+' stored fragments. This cannot be undone.')
    : L('将永久删除这段对话的全部请求记录，此操作不可撤销。',
        'This conversation’s full trace will be permanently deleted. This cannot be undone.');
  confirmDeleteReturnFocus = document.activeElement;
  ov.classList.add('on');
  el('confirmDeleteCancel').focus();
  return new Promise(function(resolve){
    _confirmDeleteResolver = resolve;
  });
}
function closeConfirmDelete(result){
  const ov = el('confirmDeleteOv');
  if(ov) ov.classList.remove('on');
  if(_confirmDeleteResolver){ _confirmDeleteResolver(result); _confirmDeleteResolver = null; }
  if(confirmDeleteReturnFocus && confirmDeleteReturnFocus.isConnected && typeof confirmDeleteReturnFocus.focus === 'function') confirmDeleteReturnFocus.focus();
  confirmDeleteReturnFocus = null;
}
function trapModalTab(overlayId, ev){
  const ov = el(overlayId);
  if(!ov) return;
  const stops = Array.from(ov.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'))
    .filter(node => node.getClientRects().length > 0);
  if(!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const active = document.activeElement;
  const activeIndex = stops.indexOf(active);
  if(ev.shiftKey && activeIndex <= 0){
    ev.preventDefault();
    last.focus();
  } else if(!ev.shiftKey && (activeIndex < 0 || active === last)){
    ev.preventDefault();
    first.focus();
  }
}

async function deleteSession(sid){
  if(!sid) return;
  if(!await confirmDeleteSession(sid)) return;
  try {
    const res = await fetch('api/session/' + encodeURIComponent(sid), { method:'DELETE' });
    if(!res.ok) throw new Error(L('删除失败（HTTP '+res.status+'）','Delete failed (HTTP '+res.status+')'));
  } catch (err) {
    toast(err && err.message ? err.message : L('删除会话失败','Could not delete session'));
    return;
  }
  if(sessionTraceMeta) delete sessionTraceMeta[sid];
  if(LIVE_MODE) await refreshState(); else {
    state.sessions = (state.sessions || []).filter(s => s.id !== sid);
    if(state.sessionTraces) delete state.sessionTraces[sid];
    if(sessionTraceMeta) delete sessionTraceMeta[sid];
    render();
  }
}
function renderList(){
  const all = traces();
  inferProviderTransitions(all);
  const idx = Math.max(0, currentIndex());
  const offset = currentTraceOffset();
  const total = currentTraceTotal(all.length);
  // 进度行分子/分母必须同口径：都用本会话的局部位序（含分页 offset），所以分子永不超过分母。
  // 曾用落盘的全局 turn 号当分子、本会话条数当分母，导致「请求 18 / 7」这种分子大于分母的显示。
  // 注意：列表行标签仍显示全局 turn 号（刻意保留），两者是不同口径，不要再把它们拼进同一个分数。
  el('progressCur').textContent = selectedId ? String(offset + idx + 1) : '0';
  el('progressTotal').textContent = String(total);
  // 连续同名子 Agent 归并成可折叠块；其余按主回合渲染。
  const groups = buildRailGroups(all);
  const hasSub = groups.some(g => g.kind === 'sagroup');
  el('foldToggle').hidden = !hasSub;
  railGroupsCache = groups;
  // 分批渲染：长列表一次性 innerHTML 全部行会卡。用以"锚点"为中心的滑动窗口，
  // 上下各留占位行，向两个方向滚动加载。锚点 = 选中行所在 group（默认进会话时
  // 选中最新回合 → 锚在末尾，只渲染底部一批，向上滚动再加载更早的）。
  const anchor = railAnchorIndex(groups);
  if(railWinDirty || anchor < railWinStart || anchor >= railWinEnd){
    railWinStart = Math.max(0, anchor - RAIL_BATCH);
    railWinEnd = Math.min(groups.length, anchor + RAIL_BATCH);
    railWinDirty = false;
  } else {
    // 窗口仍包含锚点：clamp 到当前 groups 长度（SSE 新增 / 删除后）。
    railWinStart = Math.max(0, Math.min(railWinStart, groups.length));
    railWinEnd = Math.min(groups.length, Math.max(railWinEnd, anchor + 1));
  }
  renderRailSlice();
  if(hasSub) syncFoldAllLabel();
}
// 选中行所在 group 下标；无选中时锚定末尾（最新回合）。
function railAnchorIndex(groups){
  if(selectedId){
    const i = groups.findIndex(g => g.kind === 'sagroup'
      ? railGroupContainsTrace(g, selectedId)
      : g.trace.id === selectedId);
    if(i >= 0) return i;
  }
  return Math.max(0, groups.length - 1);
}
function railGroupTraceCount(group){
  if(!group || group.kind !== 'sagroup') return 1;
  return (group.entries || []).reduce((sum, entry) => sum + (entry.kind === 'sagroup' ? railGroupTraceCount(entry) : 1), 0);
}
function railGroupContainsTrace(group, traceId){
  if(!group || group.kind !== 'sagroup') return false;
  return (group.entries || []).some(entry => entry.kind === 'sagroup'
    ? railGroupContainsTrace(entry, traceId)
    : entry.trace && entry.trace.id === traceId);
}
function railSubagentGroups(groups){
  const out = [];
  const visit = group => {
    if(!group || group.kind !== 'sagroup') return;
    out.push(group);
    (group.entries || []).forEach(entry => { if(entry.kind === 'sagroup') visit(entry); });
  };
  (groups || []).forEach(visit);
  return out;
}
function railGroupsTraceCount(groups, start, end){
  return groups.slice(start, end).reduce((sum, group) => sum + railGroupTraceCount(group), 0);
}
// 渲染 [railWinStart, railWinEnd) 范围内的 group；两端按需放占位行触发加载。
function renderRailSlice(){
  const groups = railGroupsCache;
  if(!groups.length){
    el('traceList').innerHTML = '<div class="empty">'+L('没有匹配的请求','No matching requests')+'</div>';
    return;
  }
  const meta = currentTraceMeta();
  const beforePage = meta && meta.hasMoreBefore ? Math.max(0, meta.offset || 0) : 0;
  const afterPage = meta && meta.hasMoreAfter ? Math.max(0, (meta.total || 0) - ((meta.offset || 0) + traces().length)) : 0;
  const beforeWindow = railGroupsTraceCount(groups, 0, railWinStart);
  const afterWindow = railGroupsTraceCount(groups, railWinEnd, groups.length);
  const shown = groups.slice(railWinStart, railWinEnd);
  let html = '';
  if(beforeWindow > 0 || beforePage > 0){
    const loading = railLoadingEdge === 'top';
    const count = beforeWindow + beforePage;
    html += '<div class="rail-more'+(loading?' loading':'')+'" id="railMoreTop" data-rail-load="top">'+(loading ? L('正在加载更早的请求…','Loading earlier requests…') : L('上面还有 '+count+' 条，向上滚动或点击加载',count+' more above — scroll up or click'))+'</div>';
  }
  html += shown.map(g => g.kind === 'sagroup' ? railGroupHtml(g) : railRowHtml(g.trace, false)).join('');
  if(afterWindow > 0 || afterPage > 0){
    const loading = railLoadingEdge === 'bottom';
    const count = afterWindow + afterPage;
    html += '<div class="rail-more'+(loading?' loading':'')+'" id="railMoreBottom" data-rail-load="bottom">'+(loading ? L('正在加载后续请求…','Loading later requests…') : L('下面还有 '+count+' 条，向下滚动或点击加载',count+' more below — scroll down or click'))+'</div>';
  }
  el('traceList').innerHTML = html;
}
function canLoadRailRows(edge){
  const groups = railGroupsCache || [];
  const meta = currentTraceMeta();
  if(edge === 'top') return railWinStart > 0 || !!(meta && meta.hasMoreBefore);
  return edge === 'bottom' && (railWinEnd < groups.length || !!(meta && meta.hasMoreAfter));
}
function scheduleRailLoad(edge){
  if(!canLoadRailRows(edge)) return false;
  if(railLoadTimer || railLoadingEdge) return true;
  railLoadingEdge = edge;
  renderRailSlice();
  if(railGroupsCache.some(g => g.kind === 'sagroup')) syncFoldAllLabel();
  if((edge === 'top' && railWinStart <= 0) || (edge === 'bottom' && railWinEnd >= railGroupsCache.length)){
    void loadAdjacentSessionPage(edge);
    return true;
  }
  railLoadTimer = setTimeout(() => {
    railLoadTimer = 0;
    railLoadingEdge = '';
    loadRailRows(edge);
  }, 80);
  return true;
}
function loadRailRows(edge){
  const list = el('traceList');
  if(!list) return false;
  if(edge === 'top' && railWinStart > 0){
    const prevH = list.scrollHeight;
    railWinStart = Math.max(0, railWinStart - RAIL_BATCH);
    renderRailSlice();
    if(railGroupsCache.some(g => g.kind === 'sagroup')) syncFoldAllLabel();
    list.scrollTop += list.scrollHeight - prevH;  // 补偿新插入高度，视觉不跳
    return true;
  }
  if(edge === 'bottom' && railWinEnd < railGroupsCache.length){
    railWinEnd = Math.min(railGroupsCache.length, railWinEnd + RAIL_BATCH);
    renderRailSlice();
    if(railGroupsCache.some(g => g.kind === 'sagroup')) syncFoldAllLabel();
    return true;
  }
  renderRailSlice();
  return false;
}
function maybeLoadMoreRows(){
  if(view !== 'session') return;
  const list = el('traceList');
  if(!list) return;
  const groups = railGroupsCache;
  // 接近底部：向下扩一批。
  if(railWinEnd < groups.length && list.scrollTop + list.clientHeight >= list.scrollHeight - list.clientHeight){
    scheduleRailLoad('bottom');
    return;
  }
  // 接近顶部：向上扩一批（保持滚动锚点，避免跳动）。
  if(railWinStart > 0 && list.scrollTop <= list.clientHeight){
    scheduleRailLoad('top');
  }
}
function maybeLoadMoreRowsFromWheel(ev){
  if(view !== 'session' || railLoadTimer) return;
  const list = el('traceList');
  if(!list) return;
  const atTop = list.scrollTop <= 1;
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
  if(ev.deltaY < 0 && atTop && canLoadRailRows('top')){
    ev.preventDefault();
    scheduleRailLoad('top');
    return;
  }
  if(ev.deltaY > 0 && atBottom && canLoadRailRows('bottom')){
    ev.preventDefault();
    scheduleRailLoad('bottom');
  }
}
// 子 Agent 的代表色（Explore=violet / Plan=blue / 其它=cyan）。
function subagentColor(name){
  const n = String(name || '').toLowerCase();
  if(n.indexOf('explore') >= 0) return ['var(--violet)','var(--violet-bg)'];
  if(n.indexOf('plan') >= 0) return ['var(--blue)','var(--blue-bg)'];
  return ['var(--cyan)','var(--cyan-bg)'];
}
// 子 Agent 短 id：同名并行子 Agent 的唯一区分标记，两边都从 invocationId 派生
//（Claude = Task 的 tool_use id，Codex = thread id），所以口径一致、与客户端无关。
function shortAgentId(id){
  const s = String(id || '').replace(/[^A-Za-z0-9]/g, '');
  return s.length > 6 ? s.slice(-6) : s;
}
// 子 Agent 自己的 header 身份。优先用落盘的 subagentInfo.agentId，缺失时直接从请求头读——
// 早于该字段的历史 trace 只有 header，不回读的话老会话里一个子 agent 仍会被切成好几张卡。
function traceAgentId(t, structured){
  if(structured && typeof structured.agentId === 'string' && structured.agentId) return structured.agentId;
  const headers = t && t.request && t.request.headers;
  if(!headers || typeof headers !== 'object') return '';
  for(const key in headers){
    if(key.toLowerCase() !== 'x-claude-code-agent-id') continue;
    const raw = headers[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if(typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
// 占位名：客户端没给真名时的兜底文案（clientSignatures 的 SUBAGENT_LITERAL_PHRASES 一类）。
// 真名一到就该顶掉它们。
function isPlaceholderAgentName(name){
  const n = String(name || '').trim().toLowerCase();
  return !n || n === 'subagent' || n === 'sub agent' || n === 'agentsdk' || n === '子 agent' || n === '子agent';
}
function railGroupKey(g){
  // 只认 entries：早先另有一个 items 数组与之双写，但它不含嵌套子组，
  // 任何新写的遍历器挑错数组就会静默少算。
  const firstEntry = g && (g.entries || []).find(entry => entry.kind === 'main');
  const first = firstEntry && firstEntry.trace;
  return String(g && g.groupKey || first && first.id || (g && g.agent || 'sub') + '#' + stableTraceOrdinal(first, '?'));
}
// 侧栏卡片是树形 DOM，但请求本身是一条严格时间线。并发子 Agent 会在不同树枝之间
// 交错；若离开 A 分枝进入 B 后仍保留 A 为“打开”，下一条 A 的请求会被追加回页面前面
// 的旧卡片，从而出现“请求 1108 在请求 1107 前面”。这里只保留新请求与上一请求共享的
// 祖先前缀，其余分枝立即结段；之后恢复的分枝由 ensureGroup 创建带“续”的新卡片。
function railGroupLineage(groupKey, groupMeta){
  const lineage = [];
  const seen = {};
  let key = groupKey;
  while(key && !seen[key]){
    seen[key] = true;
    lineage.unshift(key);
    const meta = groupMeta[key];
    key = meta && meta.parentKey;
  }
  return lineage;
}
function syncRailOpenBranch(groupKey, groupMeta, byKey, activePath){
  const desired = railGroupLineage(groupKey, groupMeta);
  const current = Array.isArray(activePath) ? activePath : [];
  let shared = 0;
  while(shared < current.length && shared < desired.length && current[shared] === desired[shared]) shared++;
  for(let i = shared; i < current.length; i++) delete byKey[current[i]];
  return desired;
}
// 侧栏分组：严格按 list（回合顺序）产出，主回合 / auxiliary 探测会关闭所有开着的卡片。
// 被关闭后又恢复活动的子 Agent，会为其缺失的祖先链各补一张"续接卡"（标 续 / cont.），
// 这样顺序与层级都成立——代价是祖先卡名会重复出现，这是刻意取舍。
// groupMeta 永不清空，正是为了在卡片关闭后仍能重建祖先链。
function buildRailGroups(list){
  const out = [];
  const byKey = {};
  const groupMeta = {};
  // agent 身份 → 该 agent 的最佳已知名字/类型/短 id，跨所有段共享（见下方 identity 注释）。
  const identityMeta = {};
  const contSeq = {};
  let activeGroupPath = [];
  // 取得 key 对应的"当前开着的"卡片；不存在则新建，并递归补齐缺失的祖先。
  const ensureGroup = key => {
    if(byKey[key]) return byKey[key];
    const meta = groupMeta[key];
    const seq = (contSeq[key] = (contSeq[key] || 0) + 1);
    const group = {
      kind:'sagroup',
      agent: meta ? meta.agent : 'Subagent',
      agentType: meta ? meta.agentType : '',
      shortId: meta ? meta.shortId : '',
      // 续接卡必须有独立 key：否则 data-sagroup 重复，折叠一张会连带另一张。
      groupKey: seq > 1 ? key + '#c' + seq : key,
      continuation: seq > 1 || undefined,
      entries: []
    };
    byKey[key] = group;
    const parentKey = meta && meta.parentKey;
    if(parentKey && groupMeta[parentKey]) ensureGroup(parentKey).entries.push(group);
    else out.push(group);
    return group;
  };
  for(const t of list){
    // 子 Agent（非辅助请求）参与归并；title/count 这类辅助回合不并入子 Agent 块。
    if(t.subagent && !t.auxiliary){
      const agent = subagentName(t);
      const info = logicalInfo(t);
      const groupKey = info.subGroupKey || agent;
      // 同一个子 Agent 的请求会被主回合 / aux 探测切成多段（每段一张续接卡），而名字、类型、
      // 短 id 只有 prompt hash 盖章成功的那一条请求带得全。按 agent 身份（而非按段）共享一份
      // 元数据，后面每一段才不会退回裸 "Subagent" 且没有徽标。
      const identity = info.subIdentity || groupKey;
      const shared = identityMeta[identity] || (identityMeta[identity] = { agent:'', agentType:'', shortId:'' });
      if(isPlaceholderAgentName(shared.agent) && !isPlaceholderAgentName(agent)) shared.agent = agent;
      if(!shared.agentType && info.subAgentType) shared.agentType = info.subAgentType;
      if(!shared.shortId) shared.shortId = shortAgentId(info.subInvocationId) || shortAgentId(info.subAgentId);
      if(!groupMeta[groupKey]){
        groupMeta[groupKey] = {
          identity,
          agent: shared.agent || agent,
          agentType: shared.agentType,
          shortId: shared.shortId,
          parentKey: info.subParentGroupKey
        };
      } else {
        const meta = groupMeta[groupKey];
        if(isPlaceholderAgentName(meta.agent) && !isPlaceholderAgentName(shared.agent)) meta.agent = shared.agent;
        if(!meta.agentType && shared.agentType) meta.agentType = shared.agentType;
        if(!meta.shortId) meta.shortId = shared.shortId;
      }
      activeGroupPath = syncRailOpenBranch(groupKey, groupMeta, byKey, activeGroupPath);
      ensureGroup(groupKey).entries.push({ kind:'main', trace:t });
    } else {
      // 严格时间序：直接进入 out 的条目（主回合 / auxiliary 探测）会关闭所有开着的卡片。
      // 只断"段"不够——父卡若还开在 byKey 里，后续子 Agent 请求会被塞回位置更靠前的父卡内部，
      // 而这条 aux 行排在父卡之后，看起来就是顺序颠倒。
      // 代价：父卡此后没有新请求时，恢复活动的嵌套子 Agent 会以顶层卡片出现（失去缩进层级）。
      for(const key in byKey) delete byKey[key];
      activeGroupPath = [];
      out.push({ kind:'main', trace:t });
    }
  }
  // 收尾统一名字：卡片是在遍历中即时创建的，若某个 agent 的真名出现在它的第二段之后，
  // 早先建好的那几张卡当时只拿到占位名。这里按 agent 身份把最终结论回刷一遍，
  // 使结果与请求到达顺序无关；顺便把同一 agent 的第 2 段起全部标成续接卡——统一名字之后，
  // 6 张同名卡不标「续」会看起来像 6 个不同的同名 Agent。
  const ordered = [];
  collectRailGroupsInOrder(out, ordered);
  const seenIdentity = {};
  for(const group of ordered){
    const baseKey = String(group.groupKey || '').replace(/#c\\d+$/, '');
    const meta = groupMeta[baseKey];
    const shared = meta && identityMeta[meta.identity];
    if(shared){
      if(isPlaceholderAgentName(group.agent) && !isPlaceholderAgentName(shared.agent)) group.agent = shared.agent;
      if(!group.agentType && shared.agentType) group.agentType = shared.agentType;
      if(!group.shortId && shared.shortId) group.shortId = shared.shortId;
    }
    const identity = meta && meta.identity;
    if(identity){
      if(seenIdentity[identity]) group.continuation = true;
      seenIdentity[identity] = true;
    }
  }
  return out;
}
// 按渲染顺序（深度优先）收集所有子 Agent 卡片。
function collectRailGroupsInOrder(entries, out){
  for(const entry of entries || []){
    if(!entry || entry.kind !== 'sagroup') continue;
    out.push(entry);
    collectRailGroupsInOrder(entry.entries, out);
  }
}
function railRowHtml(t, sub){
  const bad = traceIsError(t);
  const notImpl = isCountNotImplemented(t);
  const started = t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : '';
  const mark = specialRailLabel(t);
  const special = mark ? ' is-special' : '';
  const label = traceLabel(t);
  const railLabel = traceRailLabel(t);
  const title = [label, started].filter(Boolean).join(' / ');
  // 选中态左色条/底色用的强调色：子 Agent → violet，特殊回合 → 其类型色，普通 → 蓝。
  const reqColor = (sub ? 'var(--violet)' : '') || railRequestColor(t) || 'var(--blue)';
  const styleAttr = ' style="--req-color:'+reqColor+'"';
  const markHtml = mark ? '<span class="mark">'+esc(mark)+'</span>' : '';
  const statusCell = bad
    ? '<span class="err">'+esc(t.response && t.response.statusCode || 'ERR')+'</span>'
    : (notImpl ? '<span class="notimpl">unsupported</span>' : '');
  return '<div class="row'+special+(t.id===selectedId?' on':'')+'"'+styleAttr+' role="button" tabindex="0" aria-pressed="'+(t.id===selectedId?'true':'false')+'" data-id="'+esc(t.id)+'" data-turn="'+esc(railLabel)+'" title="'+esc(title)+'">'+
    '<div class="r1"><span class="turn">'+esc(label)+'</span>'+markHtml+'<span class="model">'+esc(t.request && t.request.model || 'unknown')+'</span></div>'+
    '<div class="r2 '+(bad?'bad':'')+'">'+statusCell+'<span class="tok">'+num(totalTokens(t))+' tok</span><span class="dur">'+ms(t.durationMs)+'</span><span class="time">'+esc(started)+'</span></div></div>';
}
function specialRailLabel(t){
  const semantic = semanticRailLabel(t);
  const transition = displayProviderTransition(t) ? L('切换供应商','Change provider') : '';
  return [semantic, transition].filter(Boolean).join(' · ');
}
function displayProviderTransition(t){
  return t && (t.providerTransition || inferredProviderTransitions[t.id]);
}
function codexTraceProviderKind(t){
  if(!t || (t.source !== 'codex-cli' && t.source !== 'codex-vscode')) return '';
  if(t.provider && t.provider.connectionId) return 'provider:' + t.provider.connectionId;
  const explicit = t.providerTransition;
  if(explicit && typeof explicit.target === 'string') return explicit.target;
  const raw = String(t.upstream && (t.upstream.baseUrl || t.upstream.url) || '');
  const match = /^https?:\\/\\/([^\\/:?#]+)/i.exec(raw);
  if(!match) return '';
  const host = match[1].toLowerCase();
  return host === 'chatgpt.com' || host === 'api.openai.com' ? 'official' : 'compatible';
}
function providerTransitionDisplayConsumer(t){
  return !!(t && !t.auxiliary && !t.subagent && !isCompactTrace(t));
}
function inferProviderTransitions(list){
  const inferred = {};
  let lastMainProvider = '';
  for(const t of list || []){
    const provider = codexTraceProviderKind(t);
    if(!provider) continue;
    const explicit = t.providerTransition;
    if(!lastMainProvider && explicit && typeof explicit.source === 'string'){
      lastMainProvider = explicit.source;
    }
    if(!explicit && lastMainProvider && provider !== lastMainProvider && t.id){
      inferred[t.id] = { source:lastMainProvider, target:provider };
    }
    if(providerTransitionDisplayConsumer(t)) lastMainProvider = provider;
  }
  inferredProviderTransitions = inferred;
}
function semanticRailLabel(t){
  if(isCompactTrace(t)) return L('上下文压缩','compact');
  if(t && t.auxiliary === 'title') return L('标题生成','title');
  if(t && t.auxiliary === 'count') return L('Token 预算','count_tokens');
  if(t && t.auxiliary === 'policy') return L('策略检查','policy');
  if(t && t.auxiliary === 'memory') return L('记忆维护','memory');
  if(t && t.auxiliary === 'utility') return L('内部辅助','utility');
  return '';
}
function railRequestColor(t){
  if(traceIsError(t)) return 'var(--red)';
  if(isCompactTrace(t)) return 'var(--amber)';
  if(t && (t.auxiliary === 'title' || t.auxiliary === 'count' || t.auxiliary === 'policy' || t.auxiliary === 'memory' || t.auxiliary === 'utility')) return 'var(--cyan)';
  if(displayProviderTransition(t)) return 'var(--violet)';
  return '';
}
function railGroupTokenCount(group){
  return (group.entries || []).reduce((sum, entry) => sum + (entry.kind === 'sagroup'
    ? railGroupTokenCount(entry)
    : totalTokens(entry.trace)), 0);
}
function railGroupEntriesHtml(group, depth){
  return (group.entries || []).map(entry => entry.kind === 'sagroup'
    ? railGroupHtml(entry, (Number(depth) || 0) + 1)
    : railRowHtml(entry.trace, true)).join('');
}
// depth：0 = 顶层卡片，≥1 = 嵌套。底色按 depth 奇偶交替，故任意深度都保持相邻层可区分。
function railGroupHtml(g, depth){
  const d = Number(depth) || 0;
  const key = railGroupKey(g);
  const open = !subagentCollapsed[key];
  const tok = railGroupTokenCount(g);
  const count = railGroupTraceCount(g);
  // token 总量走共享 common.compactNumber：与仪表盘同一套进位与大小写，且不必在模板字符串里
  // 手写正则（自写的 /\.0$/ 会塌成 /.0$/ 并吃掉真实数字）。
  const tokText = (t => t.value + t.unit)(common.compactNumber(tok));
  const sum = '<span>'+L(count+' 条',count+' req')+'</span><span class="gtok">'+tokText+' tok</span>';
  // 历史 trace 里 agentType 槽位可能仍是旧版写进去的 thread 短 id，那就会和 gid 徽标显示成
  // 同一串两遍（实测「Subagent 2d66a0 2d66a0」），也会让 subagentColor 拿到一串 hex 而永远
  // 匹配不到 explore / plan。等于短 id 就当它不是真的 agent 类型。
  const kindText = g.agentType && g.agentType !== g.shortId ? g.agentType : '';
  const cc = subagentColor(kindText || g.agent);
  const kind = kindText && kindText.toLowerCase() !== String(g.agent || '').toLowerCase()
    ? '<span class="gkind">'+esc(kindText)+'</span>'
    : '';
  // 续接卡：被主回合 / aux 行打断后恢复活动的同一 Agent。必须标出来，否则看起来是两个同名 Agent。
  const cont = g.continuation
    ? '<span class="gcont" title="'+L('续接的子 Agent 分段','Continued sub-agent segment')+'">'+L('续接','cont.')+'</span>'
    : '';
  // 短 id 对 Claude / Codex 一视同仁：并行派发的同名子 Agent 只能靠它区分。
  const gid = g.shortId ? '<span class="gid" title="'+L('子 Agent 调用 id 后 6 位','last 6 of the sub-agent invocation id')+'">'+esc(g.shortId)+'</span>' : '';
  return '<div class="sagroup'+(d?' nested':'')+' tier'+(d % 2)+(open?' open':'')+'" data-sagroup="'+esc(key)+'" style="--cc:'+cc[0]+';--cc-bg:'+cc[1]+'">'+
    '<div class="sahead" data-toggle-sub role="button" tabindex="0" aria-expanded="'+(open?'true':'false')+'"><span class="gname">'+esc(g.agent)+'</span>'+cont+gid+kind+'<span class="gsum">'+sum+'</span></div>'+
    '<div class="sabody"><div class="sabody-inner">'+railGroupEntriesHtml(g, d)+'</div></div></div>';
}
function syncFoldAllLabel(){
  const btn = el('foldToggle');
  if(!btn) return;
  const groups = railSubagentGroups(railGroupsCache);
  const anyOpen = groups.some(g => !subagentCollapsed[railGroupKey(g)]);
  btn.textContent = anyOpen ? L('收起全部 Subagents','Collapse all Subagents') : L('展开全部 Subagents','Expand all Subagents');
}
// 一键收起/展开全部子 Agent：任一展开则全部收起，否则全部展开。
function toggleAllSubagents(){
  const groups = railSubagentGroups(railGroupsCache);
  const anyOpen = groups.some(g => !subagentCollapsed[railGroupKey(g)]);
  groups.forEach(g => { const key = railGroupKey(g); if(anyOpen) subagentCollapsed[key] = true; else delete subagentCollapsed[key]; });
  renderList();
}
function isCompactTrace(t){ return !!(t && t.compact && t.routedBy !== 'compactResume'); }
// count_tokens 404 = 网关没实现 Anthropic 的 count_tokens 端点（兼容服务 等兼容网关常见缺口）。
// 不是请求失败：Claude Code 容忍它并回退到自己的估算。前端据此把它当「上游未实现」展示，
// 不进 errorCount、不弹红色「请求异常」横幅。与后端 traceStore.traceHasError 保持一致。
function isCountNotImplemented(t){ return !!(t && t.auxiliary === 'count' && t.response && t.response.statusCode === 404); }
function traceIsError(t){
  if(!t) return false;
  if(isCountNotImplemented(t)) return false;
  return !!(t.error || (t.response && t.response.statusCode && t.response.statusCode >= 400));
}
function renderDetail(){
  const detailRoot = el('detail');
  const renderedTraceId = detailRoot.dataset.traceId;
  if(renderedTraceId) rememberDetailUiState(renderedTraceId,captureDetailUiState(detailRoot,renderedTraceId));
  const t = currentTrace();
  if(!t && isSessionLoading(selectedSessionId)){ detailRoot.innerHTML = '<div class="detail-loading">'+L('正在加载会话请求…','Loading session requests…')+'</div>'; delete detailRoot.dataset.traceId; return; }
  if(!t && sessionLoadErrors[selectedSessionId]){ detailRoot.innerHTML = '<div class="error-banner"><div>⚠</div><div><b>'+L('会话加载失败','Session could not be loaded')+'</b>'+esc(sessionLoadErrors[selectedSessionId])+'</div><button class="retry" type="button" data-retry-session="'+esc(selectedSessionId)+'">'+L('重试','Retry')+'</button></div>'; delete detailRoot.dataset.traceId; return; }
  if(!t){ detailRoot.innerHTML = '<div class="empty">'+L('还没有捕获到 Trace 请求。','No Trace requests captured yet.')+'</div>'; delete detailRoot.dataset.traceId; return; }
  const detailUi = detailUiCache.get(t.id) || null;
  const usage = usageOf(t);
  const notImpl = isCountNotImplemented(t);
  const error = !notImpl && (t.error || ((t.response && t.response.statusCode >= 400) ? (t.response.statusMessage || 'HTTP error') : ''));
  let html = renderHead(t, usage) + renderMetrics(t, usage)
    + (error ? '<div class="error-banner"><div>⚠</div><div><b>Request failed</b>'+esc(error)+'</div></div>' : '')
    + (notImpl ? '<div class="notimpl-banner"><div>ℹ</div><div><b>上游未实现 count_tokens</b>网关返回 404，这是 token 预算预探测。Claude Code 会回退到内部估算，不影响对话。</div></div>' : '');
  // 视图切换条 + 操作。
  const modeseg = '<div class="modeseg"><span class="seg-thumb"></span>'+
    '<button class="'+(detailMode==='read'?'active':'')+'" data-mode="read">'+L('阅读','Read')+'</button>'+
    '<button class="'+(detailMode==='compare'?'active':'')+'" data-mode="compare">'+L('对比','Compare')+'</button>'+
    '<button class="'+(detailMode==='raw'?'active':'')+'" data-mode="raw">'+L('日志','Log')+'</button>'+
  '</div>';
  const acts = '<div class="acts">'+
    '<button id="searchOpen" class="search-btn" title="'+L('查找','Find')+'"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg><span class="search-ph">'+L('查找','Find')+'</span></button>'+
  '</div>';
  html += '<div class="bar">'+modeseg+'<div class="cmp-controls" id="diffPick"></div>'+acts+'</div>';
  // 阅读视图
  html += '<div class="view-single">'+renderReadView(t)+'</div>';
  // 对比视图（主区双栏，复用 structuralDiff/renderStructuralDiff，容器从 modal 改成主区）
  html += '<div class="view-cmp"><div id="diffBody"></div></div>';
  // 原始视图（JSON/PRETTY/cURL）
  html += '<div class="view-raw">'+renderRawView(t)+'</div>';
  detailRoot.innerHTML = html;
  if(detailMode === 'compare') renderDiff();
  restoreDetailUiState(detailRoot,t.id,detailUi);
  detailRoot.querySelectorAll('details.log-field-fold[open]').forEach(hydrateDeferredLogFold);
  positionSegThumbs(detailRoot);
}
function renderReadView(t){
  const msgs = getMessages(t);
  return section('tools',L('工具','Tools'),renderTools(t),true,toolsBadge(t))
    + section('system','System',renderSystem(t),true,(systemSegments(t).length)+' '+L('段','segments'))
    + section('messages',L('Messages','Messages'),renderMessages(msgs),true,msgs.length+' '+L('条','messages'))
    + section('response',L('Response','Response'),renderResponse(t),true,responseBadge(t))
    + section('sse',L('SSE Events','SSE Events'),renderSse(t),false,((t.sse && t.sse.events || []).length)+' '+L('条','events'));
}
// 对比视图只比较不属于 Messages/System/Tools 的请求字段；阅读视图不展示这些原始参数。
const PARAM_DIFF_SKIP = ['messages','system','tools','input','instructions','contents','systemInstruction','functions'];
function renderRawView(t){
  const rawTrace = rawTraceValue(t);
  const fmtBar = '<div class="fmt-bar" role="tablist"><span class="seg-thumb"></span>'+
    [['json','JSON'],['pretty','PRETTY'],['curl','cURL']].map(f => '<button class="fmt-btn '+(traceFormat===f[0]?'active':'')+'" data-fmt="'+f[0]+'">'+f[1]+'</button>').join('')+
  '</div>';
  if(traceFormat === 'curl') return fmtBar + '<pre class="trace-curl">'+esc(traceToCurl(t))+'</pre>';
  const projected = deferredLogProjection(rawTrace);
  cacheDeferredLogFields(t, projected.entries);
  let body = '';
  if(traceFormat === 'json') body = '<div class="json-tree trace-json">'+jsonTree(projected.value)+'</div>';
  else if(traceFormat === 'pretty') body = '<div class="trace-pretty">'+toPretty(projected.value)+'</div>';
  return fmtBar + body;
}
// 旧 trace 曾把 XwX 派生的请求体分析数据写在 context。原始视图统一归入
// xwxContext，既避免与上游 API 字段混淆，也不要求重写用户已有的 JSONL。
function rawTraceValue(t){
  if(!t || !t.context || t.xwxContext) return t;
  const value = Object.assign({}, t, { xwxContext: t.context });
  delete value.context;
  return value;
}
// head 请求摘要行只显示客户端来源、方法与最终上游端点。
// 本地代理入口是实现细节；原始 URL 仍逐字保留在日志中。
function renderHead(t, usage){
  const src = (t.request && t.request) ? (t.source || 'copilot') : (t.source || 'copilot');
  const method = (t.request && t.request.method) || 'POST';
  const requestPath = requestEndpoint(t);
  const upstreamPath = forwardedEndpoint(t);
  const endpoint = '<b class="blue">'+esc(upstreamPath || requestPath)+'</b>';
  let h = '<div class="head" id="head">';
  h += '<span class="src-tag src-'+esc(src)+'">'+esc(sourceLabel(src))+'</span>';
  h += '<span class="seg"><span class="k">'+esc(method)+'</span>'+endpoint+'</span>';
  h += '</div>';
  return h;
}
// head 下方指标条：收起态显两个大数（总 Token / 总耗时），整行可点展开；
// 展开态左右两栏明细（左 token 4 项 / 右 耗时 3 项 + 瀑布）。
function renderMetrics(t, usage){
  usage = usage || {};
  const totalTokensValue = typeof usage.totalTokens === 'number' ? usage.totalTokens : billableTotalTokens(usage);
  const total = typeof t.durationMs === 'number' ? t.durationMs : 0;
  const open = metricsOpen ? ' open' : '';
  const head = '<div class="metrics'+open+'" data-toggle-metrics role="button" tabindex="0" aria-expanded="'+(metricsOpen?'true':'false')+'">'+
    '<span class="tw">▶</span>'+
    '<div class="mcol"><span class="mk">'+L('总 Token','Total Tokens')+'</span><b class="mhero">'+num(totalTokensValue)+'</b></div>'+
    '<div class="mcol"><span class="mk">'+L('总耗时','Total Time')+'</span><b class="mhero">'+ms(total)+'</b></div>'+
  '</div>';
  const tkm = (k,v,tip) => '<span class="m"'+(tip?' title="'+esc(tip)+'"':'')+'>'+esc(k)+' <b>'+(typeof v === 'number' ? num(v) : '—')+'</b></span>';
  // 两个协议的「输入」不是一回事，光看数字会以为该相加：OpenAI 的 input_tokens 已含缓存，
  // Anthropic 的 input_tokens 只是未命中缓存的部分。把口径写进 tooltip，免得被误读成对不上账。
  const cacheTip = L('与未缓存输入互不重叠','Disjoint from uncached input');
  const inputTip = L('排除缓存读与缓存写后的普通输入','Input excluding cache reads and cache writes');
  const writeBreakdown = [];
  if(typeof usage.cacheCreation5mTokens === 'number') writeBreakdown.push('5m '+num(usage.cacheCreation5mTokens));
  if(typeof usage.cacheCreation1hTokens === 'number') writeBreakdown.push('1h '+num(usage.cacheCreation1hTokens));
  const cacheWriteTip = writeBreakdown.length ? cacheTip+' · '+writeBreakdown.join(' · ') : cacheTip;
  const tokenCol = '<div class="mdcol">'+
    '<div class="mdrow">'+tkm(L('未缓存输入','Uncached Input'), usage.inputUncachedTokens, inputTip)+tkm(L('缓存读','Cache Read'), usage.cacheReadTokens, cacheTip)+tkm(L('缓存写','Cache Write'), usage.cacheCreationTokens, cacheWriteTip)+tkm(L('输出','Output'), usage.outputTokens)+'</div>'+
  '</div>';
  const timeCol = '<div class="mdcol">'+timingDetail(t)+'</div>';
  const detail = '<div class="metrics-cw'+open+'" aria-hidden="'+(metricsOpen?'false':'true')+'"><div class="metrics-detail'+open+'">'+tokenCol+timeCol+'</div></div>';
  return head + detail;
}
// 耗时明细（图例 + 三段瀑布），供 metrics 展开态右栏用。
function timingDetail(t){
  const ti = t.timings || {};
  const total = typeof t.durationMs === 'number' ? t.durationMs : 0;
  const firstByte = numOr(ti.firstSseMs, ti.firstByteMs);
  const firstOut = pickFirst(ti.firstTextMs, ti.firstToolMs);
  const firstThink = numOr(ti.firstThinkingMs);
  const replyMs = typeof firstByte === 'number' ? firstByte : 0;
  let thinkMs = 0;
  if(typeof firstThink === 'number' && typeof firstOut === 'number' && firstOut > firstThink){
    thinkMs = firstOut - firstThink;
  }
  const accountedBeforeGen = replyMs + thinkMs;
  const genMs = total > accountedBeforeGen ? total - accountedBeforeGen : 0;
  const metric = (k,v,color) => '<span class="metric"><i style="background:'+color+'"></i>'+esc(k)+' <b>'+ms(v)+'</b></span>';
  const seg = (label, val, color) => val > 0 ? '<span class="wf-seg" style="flex:'+val+';background:'+color+'" title="'+esc(label)+' '+ms(val)+'"></span>' : '';
  const firstLabel = L('首响应','First Response'), thinkLabel = L('思考','Thinking'), genLabel = L('生成','Generation');
  const legend = '<div class="mdrow">'+
    (replyMs > 0 ? metric(firstLabel, replyMs, 'var(--blue)') : '')+
    (thinkMs > 0 ? metric(thinkLabel, thinkMs, 'var(--amber)') : '')+
    (genMs > 0 ? metric(genLabel, genMs, 'var(--green)') : '')+
  '</div>';
  const waterfall = total > 0
    ? '<div class="wf"><div class="wf-bar">'+seg(firstLabel, replyMs, 'var(--blue)')+seg(thinkLabel, thinkMs, 'var(--amber)')+seg(genLabel, genMs, 'var(--green)')+'</div></div>'
    : '';
  return legend + waterfall;
}
function forwardedEndpoint(t){
  // upstream.url is the exact URL selected after Gateway protocol routing.
  // Include the host so equal local entry paths still reveal the final service.
  const raw = t && t.upstream && t.upstream.url;
  if(raw){
    try {
      const u = new URL(String(raw));
      if(u.host) return u.host + u.pathname + u.search;
    } catch {}
  }
  // Compatibility fallback for incomplete/older traces. protocol reflects the
  // final wire protocol; apiType only reflects the client entry endpoint.
  const p = t.protocol;
  if(p === 'anthropic-messages') return '/v1/messages';
  if(p === 'openai-responses') return '/v1/responses';
  if(p === 'openai-chat-completions') return '/v1/chat/completions';
  const at = (t.request && t.request.apiType) || '';
  if(at === 'messages') return '/v1/messages';
  if(at === 'responses') return '/v1/responses';
  if(at === 'chat-completions' || at === 'chat') return '/v1/chat/completions';
  return (t.request && t.request.path) || '';
}
function requestEndpoint(t){
  return t && t.request && (t.request.url || t.request.path) || '';
}
function renderTraceJson(t){
  // 兼容旧入口：直接渲染原始视图正文（已并入 view-raw）。
  el('detail').innerHTML = renderRawView(t);
}
function numOr(...vals){ for(const v of vals) if(typeof v === 'number') return v; return undefined; }
function pickFirst(...vals){ let best; for(const v of vals){ if(typeof v === 'number' && (best === undefined || v < best)) best = v; } return best; }
function section(key,title,body,openDefault,count){
  const open = Object.prototype.hasOwnProperty.call(sectionState,key) ? sectionState[key] : openDefault;
  return '<div class="sec '+(open?'':'closed')+'" data-sec="'+esc(key)+'"><div class="sec-h" role="button" tabindex="0" aria-expanded="'+(open?'true':'false')+'"><span class="tw">▶</span><span class="t">'+title+'</span><span class="cnt">'+esc(count || '')+'</span></div><div class="cw" aria-hidden="'+(open?'false':'true')+'"><div class="sec-b">'+body+'</div></div></div>';
}
function charLabel(v){ const s = typeof v === 'string' ? v : j(v); return s ? s.length+' chars' : '0'; }
function responseBadge(t){ const snap=responseSnapshot(t); if(snap && snap.stopReason) return esc(snap.stopReason); return esc(t.response && t.response.statusCode || ''); }
function isSystemRole(role){ return role === 'system' || role === 'developer'; }
// 标签只描述真实协议载体和角色，不根据消息位置额外推断语义。
function messageRoleLabel(carrier, role){
  return carrier+'.'+String(role || 'message').toUpperCase();
}
function systemEntries(t){
  const b = bodyOf(t);
  const entries = [];
  const add = (value, label, roleClass, origin) => {
    const consume = (v, path) => {
      if(v === undefined || v === null) return;
      if(typeof v === 'string'){
        if(v.trim()) entries.push({ text:v, label, roleClass, origin:path });
        return;
      }
      if(Array.isArray(v)){
        v.forEach((item, index) => consume(item, path+'['+index+']'));
        return;
      }
      if(typeof v === 'object'){
        if(typeof v.text === 'string' && v.text.trim()) entries.push({ text:v.text, label, roleClass, origin:path+'.text' });
        // Gemini systemInstruction uses {parts:[{text:...}]} instead of a direct text field.
        if(Array.isArray(v.parts)) v.parts.forEach((part, index) => consume(part, path+'.parts['+index+']'));
      }
    };
    consume(value, origin);
  };
  // 所有 System 类载体统一用 developer 那个紫色 pill：system / instructions / systemInstruction /
  // 消息里的 system|developer 项，讲的都是同一件事（喂给模型的系统提示），只有承载它的协议字段不同。
  // 区分留给标签文字（BODY.SYSTEM vs BODY.INSTRUCTIONS）和 title 里的精确 JSON 路径，不再靠颜色。
  add(b.system,'BODY.SYSTEM','developer','body.system');
  add(b.instructions,'BODY.INSTRUCTIONS','developer','body.instructions');
  if(Array.isArray(b.messages)) b.messages.forEach((m, index) => {
    if(!m || !isSystemRole(m.role)) return;
    add(m.content,messageRoleLabel('MESSAGES',m.role),'developer','body.messages['+index+'].content');
  });
  if(Array.isArray(b.input)) b.input.forEach((m, index) => {
    if(!m || !isSystemRole(m.role)) return;
    add(m.content,messageRoleLabel('INPUT',m.role),'developer','body.input['+index+'].content');
  });
  add(b.systemInstruction,'BODY.SYSTEMINSTRUCTION','developer','body.systemInstruction');
  return entries;
}
function systemValue(t){
  const b = bodyOf(t);
  const parts = [];
  if(b.system !== undefined) parts.push(b.system);
  if(b.instructions !== undefined) parts.push(b.instructions);
  if(Array.isArray(b.messages)) b.messages.filter(m => m && isSystemRole(m.role)).forEach(m => parts.push(m.content));
  if(Array.isArray(b.input)) b.input.filter(m => m && isSystemRole(m.role)).forEach(m => parts.push(m.content));
  if(b.systemInstruction) parts.push(b.systemInstruction);
  return parts.length === 1 ? parts[0] : parts;
}
// System 分段：保留每段的协议位置，用简短路径标签区分顶层字段和消息角色。
function systemSegments(t){
  return systemEntries(t).map(entry => entry.text);
}
function renderSystem(t){
  const entries = systemEntries(t);
  if(!entries.length) return '<div class="empty">'+L('无 System','No System')+'</div>';
  // PRETTY 是默认的人类阅读视图：Markdown 排版与 XML 折叠同时生效，内容不删减；
  // MD 保留纯 Markdown 解析，RAW 则逐字显示原始文本。
  const blocks = entries.map(entry => {
    const text = entry.text;
    const textPane = '<div class="sys-pane" data-sysfmt-pane="text"><div class="md sys-pretty">'+renderTextRich(text)+'</div></div>';
    const markdownPane = '<div class="sys-pane" data-sysfmt-pane="markdown" style="display:none"><div class="md">'+renderMarkdown(text)+'</div></div>';
    const rawPane = '<div class="sys-pane" data-sysfmt-pane="raw" style="display:none"><pre class="codebox">'+esc(text)+'</pre></div>';
    const switcher = '<div class="sys-fmt">'+
      '<button class="sys-fmt-btn active" data-sysfmt="text" title="'+L('Markdown 排版与可折叠结构','Formatted Markdown with collapsible structure')+'">PRETTY</button>'+
      '<button class="sys-fmt-btn" data-sysfmt="markdown" title="'+L('纯 Markdown 预览','Markdown preview')+'">MD</button>'+
      '<button class="sys-fmt-btn" data-sysfmt="raw" title="'+L('原始文本','Raw text')+'">RAW</button>'+
    '</div>';
    const label = '<div class="msg-role"><span class="pill '+entry.roleClass+'" title="'+esc(entry.origin)+'">'+esc(entry.label)+'</span></div>';
    return '<div class="sysblk sys-wrap" data-sysfmt="text">'+label+'<div class="sysblk-body">'+switcher+textPane+markdownPane+rawPane+'</div></div>';
  }).join('');
  return blocks;
}
function renderMarkdown(s){
  // 轻量 Markdown 渲染：标题 / 多级无序与有序列表 / 代码块 / 内联代码 / 粗体 / 斜体。
  // 所有内容先 esc，不执行上游携带的 HTML。
  if(!s) return '';
  const lines = String(s).split(/\\r?\\n/);
  let out = '';
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];
  const listStack = [];
  const closeList = () => {
    const top = listStack.pop();
    if(!top) return;
    if(top.liOpen) out += '</li>';
    out += '</'+top.type+'>';
  };
  const flushLists = () => { while(listStack.length) closeList(); };
  const openList = (indent, type) => {
    out += '<'+type+' class="md-list '+(type === 'ol' ? 'md-ol' : 'md-ul')+'">';
    listStack.push({ indent, type, liOpen:false });
  };
  const closeItem = top => {
    if(top && top.liOpen){ out += '</li>'; top.liOpen = false; }
  };
  const inline = txt => {
    let h = esc(txt);
    h = h.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    h = h.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
    h = h.replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, '$1<i>$2</i>');
    return h;
  };
  for(const raw of lines){
    if(inCode){
      if(/^\`\`\`/.test(raw)){
        out += '<pre class="md-code'+(codeLang?' lang-'+esc(codeLang):'')+'">'+esc(codeBuf.join('\\n'))+'</pre>';
        inCode = false; codeLang = ''; codeBuf = [];
      } else { codeBuf.push(raw); }
      continue;
    }
    const fence = /^\`\`\`(\\w*)\\s*$/.exec(raw);
    if(fence){ flushLists(); inCode = true; codeLang = fence[1] || ''; codeBuf = []; continue; }
    const h = /^(#{1,6})\\s+(.+)$/.exec(raw);
    if(h){ flushLists(); out += '<h'+h[1].length+' class="md-h">'+inline(h[2])+'</h'+h[1].length+'>'; continue; }
    const li = /^(\\s*)(?:([-+*])|(\\d+)[.)])\\s+(.+)$/.exec(raw);
    if(li){
      const indent = li[1].replace(/\\t/g,'    ').length;
      const type = li[3] ? 'ol' : 'ul';
      while(listStack.length && indent < listStack[listStack.length - 1].indent) closeList();
      if(!listStack.length) openList(indent,type);
      else {
        const top = listStack[listStack.length - 1];
        if(indent > top.indent) openList(indent,type);
        else if(type !== top.type){ closeItem(top); closeList(); openList(indent,type); }
        else closeItem(top);
      }
      const current = listStack[listStack.length - 1];
      out += '<li><span class="md-li-text">'+inline(li[4])+'</span>';
      current.liOpen = true;
      continue;
    }
    if(!raw.trim()){ flushLists(); out += '<div class="md-br"></div>'; continue; }
    flushLists();
    out += '<p class="md-p">'+inline(raw)+'</p>';
  }
  if(inCode) out += '<pre class="md-code">'+esc(codeBuf.join('\\n'))+'</pre>';
  flushLists();
  return out;
}
function getMessages(t){
  const b = bodyOf(t);
  // 对话区忠实呈现原始日志的顺序与角色。但 messages/input 里的 system|developer 项【已经】
  // 由 systemEntries 收进 System 区（带精确 JSON 路径），在这里再整段渲染一遍就是重复：
  // 实测 Claude 一条请求重复约 34KB、Codex 一条约 24KB。所以保留位置和角色，正文换成一行指引。
  // （旧注释声称"不重复"，与 systemEntries 的实现不符。）
  const mark = (item, normalized, carrier, origin) => {
    if(!item || typeof item !== 'object' || !isSystemRole(item.role)) return normalized;
    return Object.assign({}, normalized, {
      systemEcho:true,
      systemEchoLabel:messageRoleLabel(carrier,item.role),
      systemEchoOrigin:origin,
      systemEchoLen:msgsToText([normalized]).length
    });
  };
  if(Array.isArray(b.messages)) return b.messages.map((m, i) => mark(m, normalizeMessage(m), 'MESSAGES', 'body.messages['+i+'].content'));
  // additional_tools 是工具声明而不是对话项（且没有 content），留在这里只会渲染成一条空的
  // developer 气泡；它已经在 Tools 区完整展示。
  if(Array.isArray(b.input)) return b.input
    .map((m, i) => ({ item:m, sourceIndex:i }))
    .filter(entry => !(entry.item && typeof entry.item === 'object' && entry.item.type === 'additional_tools'))
    .map(entry => mark(entry.item, normalizeMessage(entry.item), 'INPUT', 'body.input['+entry.sourceIndex+'].content'));
  if(Array.isArray(b.contents)) return b.contents.map(geminiMessage).filter(Boolean);
  return [];
}
/** Decode base64 to UTF-8 text without the escape()/unescape() mojibake trap. */
function b64Utf8(value){
  try {
    const bin = atob(value);
    const bytes = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch { return ''; }
}
/** Plain-text reasoning from a Responses reasoning item (summary[] or content[]). */
function reasoningItemText(m){
  const pick = v => Array.isArray(v) ? v.map(p => (p && (p.text || p.input_text || p.output_text)) || '').filter(Boolean).join('\\n') : (typeof v === 'string' ? v : '');
  return pick(m.summary) || pick(m.content) || '';
}
// namespace.name，两者缺一就退回另一个。Codex 的 spawn_agent 属于 multi_agent_v1，
// MCP 工具属于 mcp__codex_apps__github 这类命名空间。
function qualifiedToolName(namespace, name){
  const ns = typeof namespace === 'string' ? namespace.trim() : '';
  const n = typeof name === 'string' ? name.trim() : '';
  if(ns && n) return ns + '.' + n;
  return n || ns;
}
function normalizeMessage(m){
  if(!m || typeof m !== 'object') return { role:'unknown', content:'' };
  // OpenAI Responses 历史项：function_call / function_call_output（无 role 字段）
  if(m.type === 'function_call_output' || (m.role === undefined && m.call_id !== undefined && m.output !== undefined)){
    return { role:'tool', content:[{ type:'tool_result', tool_use_id:m.call_id || '', content:m.output, rawBlock:m }] };
  }
  if(m.type === 'function_call'){
    // namespace 是调用归属的唯一线索：MCP 命名空间下的子工具名形如 _fetch_pr / _search，
    // 丢了 namespace 就只剩一个裸 _fetch_pr，根本认不出是哪个 MCP server 的工具。
    return { role:'assistant', content:[{ type:'tool_use', id:m.call_id || m.id || '', name:qualifiedToolName(m.namespace, m.name) || 'tool_use', input:parseJsonMaybe(m.arguments), rawBlock:m }] };
  }
  // Codex freeform（custom）工具：载荷在 input 而不是 arguments，且是裸文本不是 JSON。
  if(m.type === 'custom_tool_call'){
    return { role:'assistant', content:[{ type:'tool_use', id:m.call_id || m.id || '', name:m.name || 'custom_tool_call', input:{ input:m.input === undefined ? '' : m.input }, rawBlock:m }] };
  }
  if(m.type === 'custom_tool_call_output'){
    return { role:'tool', content:[{ type:'tool_result', tool_use_id:m.call_id || '', content:m.output, rawBlock:m }] };
  }
  // tool_search：声明没有 name（由 type 隐含），arguments 已是对象；结果放在 tools 而不是 output。
  if(m.type === 'tool_search_call'){
    return { role:'assistant', content:[{ type:'tool_use', id:m.call_id || m.id || '', name:'tool_search', input:parseJsonMaybe(m.arguments), rawBlock:m }] };
  }
  if(m.type === 'tool_search_output'){
    return { role:'tool', content:[{ type:'tool_result', tool_use_id:m.call_id || '', content:m.tools === undefined ? m.output : m.tools, rawBlock:m }] };
  }
  if(m.type === 'local_shell_call'){
    return { role:'assistant', content:[{ type:'tool_use', id:m.call_id || m.id || '', name:'local_shell', input:m.action || {}, rawBlock:m }] };
  }
  if(m.type === 'web_search_call'){
    return { role:'assistant', content:[{ type:'tool_use', id:m.call_id || m.id || '', name:'web_search', input:m.action || {}, rawBlock:m }] };
  }
  // Responses 推理项：明文在 summary[].text / content[].text，密文只有 encrypted_content。
  if(m.type === 'reasoning'){
    const think = reasoningItemText(m);
    // sigOrigin 区分两种「没有明文」：Responses 的 reasoning 是本步没生成摘要、载荷本就加密下发；
    // Anthropic 的 signature-only thinking 才是上游主动隐去了明文。文案不该混用。
    return { role:'assistant', content:[{ type:'thinking', thinking:think, text:think, signature:m.encrypted_content || '', sigOrigin:'reasoning', rawBlock:m }] };
  }
  // Codex 压缩条目：既没有 role 也没有 content，若不单独处理就是一个空的 unknown 气泡——
  // 而它承载的恰好是整段被压缩掉的上下文。XwX 自己生成的摘要是 xwxc1: + base64，可以还原；
  // 其他 provider 的压缩产物是不透明的。
  if(m.type === 'compaction' || m.type === 'compaction_summary' || m.type === 'context_compaction'){
    const raw = typeof m.encrypted_content === 'string' ? m.encrypted_content : '';
    const decoded = raw.indexOf('xwxc1:') === 0 ? b64Utf8(raw.slice(6)) : '';
    const text = decoded
      || '[上下文压缩摘要：由上游 provider 生成，本地无法解码（' + raw.length + ' 字符密文）]';
    return { role:'system', content:[{ type:'text', text:text }] };
  }
  if(m.type === 'compaction_trigger'){
    return { role:'system', content:[{ type:'text', text:'[压缩触发点：XwX 在此处替客户端发起了一次上下文压缩摘要请求]' }] };
  }
  if(m.role === 'tool') return Object.assign({}, m, { content:[{ type:'tool_result', tool_use_id:m.tool_call_id || '', content:m.content || '', rawBlock:m }] });
  const content = [];
  if(Array.isArray(m.content)) content.push(...m.content);
  else if(typeof m.content === 'string' && m.content.trim()) content.push({ type:'text', text:m.content });
  else if(m.content !== undefined && m.content !== null) content.push(m.content);
  else {
    const fallbackText = m.text ?? m.input_text ?? m.output_text;
    if(typeof fallbackText === 'string') content.push({ type:'text', text:fallbackText });
    else if(fallbackText !== undefined && fallbackText !== null) content.push(fallbackText);
  }
  if(Array.isArray(m.tool_calls)) {
    m.tool_calls.forEach(call => {
      const fn = call && call.function || {};
      content.push({ type:'tool_use', id:call && call.id || '', name:fn.name || call.name || 'tool_use', input:parseJsonMaybe(fn.arguments), rawBlock:call });
    });
  }
  return Object.assign({}, m, { role:m.role || 'unknown', content });
}
function geminiMessage(item){
  if(!item || typeof item !== 'object') return null;
  const blocks = [];
  (item.parts || []).forEach(part => {
    if(part.text) blocks.push({ type: part.thought ? 'thinking' : 'text', text: part.text, thinking: part.text });
    if(part.functionCall) blocks.push({ type:'tool_use', id:part.functionCall.id || '', name:part.functionCall.name || 'tool_use', input:part.functionCall.args || {}, rawBlock:part });
    if(part.functionResponse) blocks.push({ type:'tool_result', tool_use_id:part.functionResponse.id || part.functionResponse.name || '', content:part.functionResponse.response || '', rawBlock:part });
  });
  if(!blocks.length) return null;
  return { role:item.role === 'model' ? 'assistant' : (item.role || 'user'), content:blocks };
}
function responseSnapshot(t){ return t && t.sse && t.sse.snapshot || t && t.response && t.response.snapshot; }
function renderResponse(t){
  const snap = responseSnapshot(t);
  const alert = responseStatusAlert(snap);
  if(snap && Array.isArray(snap.content) && snap.content.length){
    const blocks = coalesceTextBlocks(snap.content);
    const choices = [...new Set(blocks.filter(b => b && typeof b.choiceIndex === 'number').map(b => b.choiceIndex))].sort((a,b) => a-b);
    let rendered;
    if(choices.length > 1){
      let hasText = false;
      let hasTool = false;
      const grouped = choices.map(index => {
        const part = renderResponseBlocks(t, blocks.filter(b => b && b.choiceIndex === index));
        hasText = hasText || part.hasText;
        hasTool = hasTool || part.hasTool;
        return '<div class="resp-choice"><div class="resp-choice-k">'+L('候选 ','CHOICE ')+num(index)+'</div>'+part.html+'</div>';
      }).join('');
      const ungrouped = renderResponseBlocks(t, blocks.filter(b => !b || typeof b.choiceIndex !== 'number'));
      rendered = { html:grouped+ungrouped.html, hasText:hasText || ungrouped.hasText, hasTool:hasTool || ungrouped.hasTool };
    } else rendered = renderResponseBlocks(t, blocks);
    let h = rendered.html;
    if(!rendered.hasText && rendered.hasTool) h += '<div class="empty">'+L('本次模型请求以工具调用结束；工具结果会进入后续请求。','This model request ended with a tool call; its result continues in a later request.')+'</div>';
    else if(!rendered.hasText && h) h += '<div class="empty">'+L('本次模型请求没有正文输出。','This model request has no text output.')+'</div>';
    return alert+(h || '<div class="empty">无响应内容</div>');
  }
  const events = t && t.sse && t.sse.events || [];
  if(events.length) return alert+'<div class="empty">'+L('此请求没有可展示的正文或工具调用；原始事件仍在下方 SSE Events 与“日志”中。','This request has no displayable text or tool call. Raw events remain in SSE Events below and in Log.')+'</div>';
  const body = t.response && (t.response.body || t.response.rawBody) || t.error || '';
  return alert+(body ? '<pre class="json">'+esc(typeof body === 'string' ? body : j(body))+'</pre>' : '<div class="empty">无响应内容</div>');
}
function renderResponseBlocks(t, blocks){
  // 思考与正文做视觉区分：thinking 块 → 琥珀块；text 块 → 默认深色正文。
  let h = '';
  let hasText = false;
  let hasTool = false;
  blocks.forEach(b => {
      if(!b || typeof b !== 'object') return;
      const ty = b.type || '';
      if(ty === 'thinking' || ty === 'reasoning' || ty === 'reasoning_text' || ty === 'redacted_thinking'){
        const thinkText = b.thinking || b.text || (Array.isArray(b.summary) ? b.summary.map(s => s && s.text || '').join('\\n') : '') || '';
        const sig = b.signature || b.data || '';
        const tk = (typeof usageOf(t).reasoningTokens === 'number') ? num(usageOf(t).reasoningTokens)+' token' : '';
        let inner;
        if(thinkText) inner = '<div class="resp-think-body">'+esc(thinkText)+'</div>';
        else if(sig) inner = '<div class="resp-think-body empty">'+esc(hiddenThinkingNote(b, sig))+'</div>'+collapsedBlob(L('加密载荷','Encrypted payload'), sig);
        else inner = '<div class="resp-think-body empty">'+L('思考内容未下发（上游只返回了 token 计数）','No reasoning content was sent; only a token count came back')+'</div>';
        h += '<div class="resp-think"><div class="resp-think-h">'+L('思考','Reasoning')+(tk?'<span class="tk">'+tk+'</span>':'')+'</div>'+inner+'</div>';
      } else if(ty === 'text' || ty === 'output_text'){
        hasText = true;
        h += '<div class="resp-text"><div class="md txt-md">'+renderTextRich(b.text || '')+'</div>'+renderCitations(b.citations)+'</div>';
      } else if(ty === 'refusal'){
        hasText = true;
        h += '<div class="resp-refusal"><div class="resp-refusal-k">'+L('模型拒绝','REFUSAL')+'</div><div class="pre-text">'+esc(b.text || b.refusal || '')+'</div></div>';
      } else {
        if(ty === 'tool_use' || ty === 'function_call') hasTool = true;
        h += renderBlocks([b]);
      }
  });
  return { html:h, hasText, hasTool };
}
function responseStatusAlert(snap){
  if(!snap) return '';
  const raw = snap.raw && typeof snap.raw === 'object' && snap.raw.response && typeof snap.raw.response === 'object' ? snap.raw.response : snap.raw;
  const detail = snap.incompleteReason || (raw && raw.incomplete_details && raw.incomplete_details.reason) || '';
  const stop = snap.stopReason || '';
  if(!detail && stop !== 'incomplete' && stop !== 'failed') return '';
  const label = stop === 'failed' ? L('响应失败','Response failed') : L('响应未完整结束','Response incomplete');
  return '<div class="resp-alert"><b>'+label+'</b>'+(detail?' · '+esc(detail):'')+'</div>';
}
function renderMessages(msgs){
  if(!msgs.length) return '<div class="empty">'+L('无 Messages','No messages')+'</div>';
  const callNames = toolCallNameIndex(msgs);
  return msgs.map(m => {
    // System 区已经展示过的段落只留一行指引，避免同一段 system prompt 在一页里出现两遍。
    const bodyHtml = m.systemEcho
      ? '<div class="msg-echo">'+L('内容已在上方 System 区展示','Shown in the System section above')
        + '<span class="msg-echo-meta">'+num(m.systemEchoLen || 0)+L(' 字符 · ',' chars · ')+esc(m.systemEchoOrigin || '')+'</span></div>'
      : (renderBlocks(normalizeBlocks(m.content), callNames) || '<div class="msg-empty">'+L('（空内容）','(empty)')+'</div>');
    const roleLabel = m.systemEcho ? (m.systemEchoLabel || m.role || 'message') : (m.role || 'message');
    const phase = typeof m.phase === 'string' && m.phase ? '<span class="msg-phase" title="phase">'+esc(m.phase)+'</span>' : '';
    return '<div class="msg"><div class="msg-role"><span class="pill '+roleClass(m.role)+'">'+esc(roleLabel)+'</span>'+phase+'</div><div class="msg-body">'+bodyHtml+'</div></div>';
  }).join('');
}
function toolCallNameIndex(msgs){
  const out = {};
  msgs.forEach(m => normalizeBlocks(m && m.content).forEach(b => {
    if(!b || typeof b !== 'object') return;
    const type = b.type || '';
    if(type !== 'tool_use' && type !== 'function_call' && !/(^|_)tool_use$/.test(type)) return;
    const id = b.id || b.call_id;
    if(id) out[id] = b.name || b.serverName || b.server_name || 'tool';
  }));
  return out;
}
// system 与 developer 归一到同一个紫色 pill：两者是同一概念在不同协议里的名字，
// 用颜色区分只会让同一段系统提示在 Claude / ChatGPT 之间看起来是两种东西。
function roleClass(role){ if(role === 'system' || role === 'developer') return 'developer'; if(role === 'user' || role === 'assistant') return role; if(role === 'tool') return 'tool'; if(role === 'reasoning') return 'assistant'; return 'unknown'; }
function normalizeBlocks(content){
  if(content === undefined || content === null) return [];
  if(typeof content === 'string') return content.trim() ? [{ type:'text', text:content }] : [];
  if(!Array.isArray(content)) return [content];
  return content.map(x => typeof x === 'string' ? { type:'text', text:x } : x).filter(x => x !== undefined && x !== null);
}
function toolResultText(c){
  if(c === undefined || c === null) return '';
  if(typeof c === 'string') return c;
  if(Array.isArray(c)){
    const parts = c.map(it => {
      if(it === null || it === undefined) return '';
      if(typeof it === 'string') return it;
      if(typeof it === 'object'){
        if(typeof it.text === 'string') return it.text;
        if(typeof it.output === 'string') return it.output;
        if(typeof it.content === 'string') return it.content;
        // web_search_result / tool_reference 这类既没 text 也没 output，裸 j() 会把
        // 每条 2KB 的 encrypted_content 全倒出来（实测 10 条结果 = 20KB，其中 18KB 是密文），
        // 标题和 URL 被埋在后面根本读不到。
        const summary = structuredResultLine(it);
        if(summary) return summary;
      }
      return j(it);
    });
    return parts.join('\\n');
  }
  if(typeof c === 'object'){
    if(typeof c.text === 'string') return c.text;
    if(typeof c.output === 'string') return c.output;
    if(typeof c.content === 'string') return c.content;
    const summary = structuredResultLine(c);
    if(summary) return summary;
  }
  return j(c);
}
// 把「有语义但没有 text 字段」的结果项压成一行可读摘要；识别不了就返回空让调用方回退到 j()。
// 密文/索引类字段（encrypted_content、encrypted_index、page_age…）只报长度，不倒内容。
function structuredResultLine(it){
  if(it.type === 'tool_reference' && it.tool_name) return String(it.tool_name);
  const title = typeof it.title === 'string' ? it.title : '';
  const url = typeof it.url === 'string' ? it.url : '';
  if(title || url){
    let line = title && url ? title + ' — ' + url : (title || url);
    if(typeof it.page_age === 'string' && it.page_age) line += '  (' + it.page_age + ')';
    const enc = typeof it.encrypted_content === 'string' ? it.encrypted_content.length : 0;
    if(enc) line += '  [' + L('密文 ','encrypted ') + num(enc) + L(' 字符',' chars') + ']';
    return line;
  }
  return '';
}
function renderBlocks(blocks, callNames){
  const list = coalesceTextBlocks(blocks);
  const many = list.length > 1;
  return list.map(b => {
    if(!b || typeof b !== 'object') return blockWrap('<pre class="codebox">'+esc(j(b))+'</pre>', many, b);
    const type = b.type || 'raw';
    const rawBlock = rawBlockValue(b);
    if(type === 'text' || type === 'input_text' || type === 'output_text') return blockWrap('<div class="md txt-md">'+renderTextRich(textBlockValue(b))+'</div>'+renderCitations(b.citations), many, rawBlock, true);
    if(type === 'refusal') return blockWrap('<div class="resp-refusal"><div class="resp-refusal-k">'+L('模型拒绝','REFUSAL')+'</div><div class="pre-text">'+esc(b.text || b.refusal || '')+'</div></div>', many, rawBlock);
    if(type === 'thinking' || type === 'reasoning' || type === 'reasoning_text' || type === 'redacted_thinking'){
      const thinkText = b.thinking || b.text || (Array.isArray(b.summary) ? b.summary.map(s => s && s.text || '').join('\\n') : '') || '';
      const sig = b.signature || b.data || '';
      // 两种「没有明文」要分开说，而且密文本身要折起来——Codex 一条 reasoning 就有 1KB base64，
      // 直接铺在气泡里会把整段对话挤走。
      let inner;
      if(thinkText) inner = '<div class="pre-text">'+esc(thinkText)+'</div>';
      else if(sig) inner = '<div class="think-hidden">'+esc(hiddenThinkingNote(b, sig))+'</div>'+collapsedBlob(L('加密载荷','Encrypted payload'), sig);
      else inner = '<div class="think-hidden">'+L('思考内容未下发（上游只返回了 token 计数）','No reasoning content was sent; only a token count came back')+'</div>';
      return blockWrap('<div class="thinking"><div class="thinking-label">thinking</div>'+inner+'</div>', many, rawBlock);
    }
    if(type === 'tool_use' || type === 'function_call' || /(^|_)tool_use$/.test(type)){
      let rawInput;
      if(b.input !== undefined) rawInput = b.input;
      else if(b.arguments !== undefined) rawInput = b.arguments;
      else if(b.rawInput !== undefined) rawInput = b.rawInput;
      let inputText;
      if(rawInput === undefined || rawInput === null) inputText = '';
      else if(typeof rawInput === 'string'){
        const parsed = parseJsonMaybe(rawInput);
        inputText = (parsed !== undefined && parsed !== null && typeof parsed === 'object') ? j(parsed) : rawInput;
      } else inputText = j(rawInput);
      const callId = b.id || b.call_id || '';
      return blockWrap('<div class="tool-use-label"><span>'+esc(b.wireType || type)+' · '+esc(b.name || b.serverName || b.server_name || 'tool')+((b.serverName||b.server_name)&&b.name?' @'+esc(b.serverName||b.server_name):'')+'</span>'+toolIdBadge(callId)+'</div><pre class="codebox">'+esc(inputText)+'</pre>', many, rawBlock);
    }
    // Anthropic 的内置/MCP 工具结果（web_search_tool_result、code_execution_tool_result、
    // mcp_tool_result…）与普通 tool_result 同构，按后缀归一，避免退化成整块裸 JSON。
    if(type === 'tool_result' || type === 'function_call_output' || /(^|_)tool_result$/.test(type)){
      const callId = b.tool_use_id || b.call_id || '';
      const linked = callId && callNames && callNames[callId] ? '<span class="tool-linked-name">↳ '+esc(callNames[callId])+'</span>' : '';
      return blockWrap('<div class="tool-use-label"><span>'+esc(b.wireType || type)+((b.isError||b.is_error)?' · error':'')+'</span>'+linked+toolIdBadge(callId)+'</div><pre class="codebox">'+esc(toolResultText(b.content !== undefined ? b.content : b.output))+'</pre>', many, rawBlock);
    }
    if(type === 'image' || type === 'image_url' || type === 'input_image') return blockWrap(renderImageBlock(b), many, rawBlock);
    return blockWrap('<pre class="codebox">'+esc(j(b))+'</pre>', many, rawBlock);
  }).join('');
}
function toolIdBadge(id){
  return id ? '<span class="tool-link-id" title="'+L('工具调用关联 ID','Tool call correlation ID')+'"><span class="tool-link-k">CALL ID</span>'+esc(id)+'</span>' : '';
}
function rawBlockValue(block){
  if(!block || typeof block !== 'object') return block;
  if(Array.isArray(block.rawBlocks)) return block.rawBlocks;
  return block.rawBlock || block;
}
// Anthropic 把带引用的回答切成「未引用 / 已引用」交替的多个 text 块：实测一次回答 22 个块里
// 20 个是 text，有的只是半句话、有的只是一个空格。每块各渲染一个段落，会把一段连续回答切成
// 20 个断句段落并留下空隙。所以先把相邻同类 text 块并回一段，引用也一并合并。
// 上游的切分点就在句子中间，直接拼接即可还原原文。
function coalesceTextBlocks(blocks){
  if(!Array.isArray(blocks) || blocks.length < 2) return Array.isArray(blocks) ? blocks : [];
  const isText = b => !!b && typeof b === 'object' && (b.type === 'text' || b.type === 'output_text');
  const out = [];
  for(const b of blocks){
    const prev = out.length ? out[out.length - 1] : undefined;
    if(isText(b) && isText(prev) && prev.type === b.type && prev.choiceIndex === b.choiceIndex){
      const merged = Object.assign({}, prev, { text: textBlockValue(prev) + textBlockValue(b) });
      const cites = (Array.isArray(prev.citations) ? prev.citations : []).concat(Array.isArray(b.citations) ? b.citations : []);
      if(cites.length) merged.citations = cites;
      merged.rawBlocks = (Array.isArray(prev.rawBlocks) ? prev.rawBlocks : [rawBlockValue(prev)])
        .concat(Array.isArray(b.rawBlocks) ? b.rawBlocks : [rawBlockValue(b)]);
      delete merged.rawBlock;
      out[out.length - 1] = merged;
      continue;
    }
    out.push(b);
  }
  return out;
}
// Responses 的 reasoning：summary:'auto' 本来就可能这一步不产出摘要，载荷则按 include 请求
// 加密下发——说成「上游已加密隐藏」是把两件事混了。Anthropic 的 signature-only 才是上游隐去明文。
// （注意：本文件的 viewer JS 在模板字符串里，注释中也不能出现裸反引号。）
function hiddenThinkingNote(b, sig){
  const len = num(String(sig).length);
  return b && b.sigOrigin === 'reasoning'
    ? L('本步没有下发思考摘要，只有加密的 reasoning 载荷（'+len+' 字符）','No reasoning summary for this step; only an encrypted reasoning payload ('+len+' chars)')
    : L('思考明文未下发：上游已加密，仅返回签名（'+len+' 字符）','Reasoning plaintext withheld upstream; only a signature came back ('+len+' chars)');
}
// 密文/签名一律折叠：默认只显示长度，展开才铺开。
function collapsedBlob(label, value){
  const s = String(value || '');
  if(!s) return '';
  return '<details class="think-blob"><summary>'+esc(label)+' <span class="think-blob-len">'+num(s.length)+L(' 字符',' chars')+'</span></summary><div class="think-sig">'+esc(s)+'</div></details>';
}
function textBlockValue(block){
  const value = block.text ?? block.content ?? block.input_text ?? block.output_text ?? '';
  return typeof value === 'string' ? value : j(value);
}
// web_search 回答的来源出处。encrypted_index 是不透明的，不渲染；cited_text 放进 title 供悬停查看。
function renderCitations(list){
  if(!Array.isArray(list) || !list.length) return '';
  const items = list.map((c, i) => {
    if(!c || typeof c !== 'object') return '';
    const rawUrl = typeof c.url === 'string' ? c.url : '';
    const url = safeCitationUrl(rawUrl);
    const label = (typeof c.title === 'string' && c.title)
      || (typeof c.filename === 'string' && c.filename)
      || rawUrl
      || (typeof c.file_id === 'string' && c.file_id)
      || (typeof c.type === 'string' && c.type)
      || 'source';
    const tip = typeof c.cited_text === 'string' ? c.cited_text : (typeof c.quote === 'string' ? c.quote : '');
    const body = '['+(i+1)+'] '+esc(label);
    return url
      ? '<a class="citation" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" title="'+esc(tip)+'">'+body+'</a>'
      : '<span class="citation" title="'+esc(tip)+'">'+body+'</span>';
  }).join('');
  if(!items) return '';
  return '<div class="citations"><span class="citations-k">'+L('来源','SOURCES')+'</span>'+items+'</div>';
}
function safeCitationUrl(value){
  if(typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}
function renderTextWithXmlFolds(text){
  // 在长文本中识别顶层 <TAG ...>...</TAG> 块（支持属性、成对、可同名嵌套但折叠按最外层），
  // 渲染成可点击折叠的 <details>。仅识别行首出现的开标签，避免误伤代码中的尖括号。
  const s = String(text || '');
  if(!s) return '';
  const out = [];
  let i = 0;
  const len = s.length;
  while(i < len){
    const lineStart = (i === 0) || s.charCodeAt(i - 1) === 10;
    if(lineStart){
      const m = /^<([A-Za-z][\\w-]*)(\\s[^>\\n]*)?>/.exec(s.slice(i));
      if(m){
        const tag = m[1];
        const attrs = m[2] || '';
        // 找最外层闭合 </tag>，支持同名嵌套计数
        let depth = 1;
        let scan = i + m[0].length;
        let closeAt = -1;
        const openProbe = '<' + tag;
        const closeProbe = '</' + tag + '>';
        while(scan < len){
          const nextClose = s.indexOf(closeProbe, scan);
          if(nextClose < 0) break;
          // 查找下一处同名开标签 <tag 后跟空白或 >
          let nextOpen = -1;
          let probeFrom = scan;
          while(probeFrom < nextClose){
            const cand = s.indexOf(openProbe, probeFrom);
            if(cand < 0 || cand >= nextClose) break;
            const after = s.charCodeAt(cand + openProbe.length);
            if(after === 0x20 || after === 0x09 || after === 0x3e){ nextOpen = cand; break; }
            probeFrom = cand + openProbe.length;
          }
          if(nextOpen >= 0 && nextOpen < nextClose){
            depth++;
            // 跳过这个 open 标签的 '>' 位置
            const gt = s.indexOf('>', nextOpen);
            scan = gt < 0 ? nextClose : gt + 1;
          } else {
            depth--;
            if(depth === 0){ closeAt = nextClose; break; }
            scan = nextClose + closeProbe.length;
          }
        }
        if(closeAt >= 0){
          let inner = s.slice(i + m[0].length, closeAt);
          // 去掉开标签后紧跟的换行，让折叠体起始更紧凑
          if(inner.charCodeAt(0) === 13) inner = inner.slice(1);
          if(inner.charCodeAt(0) === 10) inner = inner.slice(1);
          const lineCount = inner.split(/\\r?\\n/).length;
          const charCount = inner.length;
          const attrHtml = attrs ? '<span class="xml-attr">'+esc(attrs)+'</span>' : '';
          out.push('<details class="xml-fold" open><summary class="xml-fold-sum"><span class="xml-tag">&lt;'+esc(tag)+attrHtml+'&gt;</span><span class="xml-meta">'+lineCount+' \u884c \u00b7 '+charCount+' \u5b57\u7b26</span></summary><div class="xml-fold-body">'+renderTextWithXmlFolds(inner)+'</div></details>');
          const closeLen = closeProbe.length;
          i = closeAt + closeLen;
          if(s.charCodeAt(i) === 13) i++;
          if(s.charCodeAt(i) === 10) i++;
          continue;
        }
      }
    }
    const nl = s.indexOf('\\n', i);
    const end = nl < 0 ? len : nl + 1;
    out.push(esc(s.slice(i, end)));
    i = end;
  }
  return out.join('');
}
function xmlElements(source, tag){
  const s = String(source || '');
  if(!/^[A-Za-z_][\\w-]*$/.test(tag)) return [];
  const openProbe = '<'+tag;
  const closeProbe = '</'+tag+'>';
  const out = [];
  let from = 0;
  while(from < s.length){
    const start = s.indexOf(openProbe,from);
    if(start < 0) break;
    const after = s.charCodeAt(start + openProbe.length);
    if(after !== 0x20 && after !== 0x09 && after !== 0x0a && after !== 0x0d && after !== 0x3e){ from = start + openProbe.length; continue; }
    const gt = s.indexOf('>',start + openProbe.length);
    if(gt < 0) break;
    const close = s.indexOf(closeProbe,gt + 1);
    if(close < 0) break;
    out.push({
      attrs:s.slice(start + openProbe.length,gt),
      inner:s.slice(gt + 1,close),
      full:s.slice(start,close + closeProbe.length)
    });
    from = close + closeProbe.length;
  }
  return out;
}
function xmlAttrValue(attrs, name){
  const s = String(attrs || '');
  for(const quote of ['"',"'"]){
    const probe = name+'='+quote;
    const start = s.indexOf(probe);
    if(start < 0) continue;
    const valueStart = start + probe.length;
    const end = s.indexOf(quote,valueStart);
    if(end >= 0) return s.slice(valueStart,end);
  }
  return '';
}
function xmlOnlyKnownAttrs(attrs, names){
  let rest = String(attrs || '');
  names.forEach(name => {
    for(const quote of ['"',"'"]){
      const probe = name+'='+quote;
      let start = rest.indexOf(probe);
      while(start >= 0){
        const valueStart = start + probe.length;
        const end = rest.indexOf(quote,valueStart);
        if(end < 0) break;
        rest = rest.slice(0,start)+rest.slice(end + 1);
        start = rest.indexOf(probe);
      }
    }
  });
  return !rest.trim();
}
function xmlUnknownRemainder(source, elements){
  let rest = String(source || '');
  elements.forEach(item => {
    const at = rest.indexOf(item.full);
    if(at >= 0) rest = rest.slice(0,at)+rest.slice(at + item.full.length);
  });
  return rest.trim();
}
function renderEnvironmentContext(inner){
  const fieldDefs = [
    ['cwd',L('工作目录','Working directory')],
    ['shell','Shell'],
    ['current_date',L('当前日期','Current date')],
    ['timezone',L('时区','Timezone')]
  ];
  const topElements = [];
  const facts = [];
  for(const def of fieldDefs){
    const nodes = xmlElements(inner,def[0]);
    topElements.push(...nodes);
    for(const node of nodes){
      if(node.inner.indexOf('<') >= 0 || !xmlOnlyKnownAttrs(node.attrs,[])) return '';
      const value = node.inner.trim();
      if(value) facts.push({ key:def[0], label:def[1], value });
    }
  }
  const filesystems = xmlElements(inner,'filesystem');
  topElements.push(...filesystems);
  if(xmlUnknownRemainder(inner,topElements)) return '';

  const roots = [];
  const rules = [];
  const modes = [];
  for(const filesystem of filesystems){
    if(!xmlOnlyKnownAttrs(filesystem.attrs,[])) return '';
    const workspaceGroups = xmlElements(filesystem.inner,'workspace_roots');
    const profiles = xmlElements(filesystem.inner,'permission_profile');
    if(xmlUnknownRemainder(filesystem.inner,[...workspaceGroups,...profiles])) return '';
    for(const group of workspaceGroups){
      if(!xmlOnlyKnownAttrs(group.attrs,[])) return '';
      const rootNodes = xmlElements(group.inner,'root');
      if(xmlUnknownRemainder(group.inner,rootNodes)) return '';
      for(const node of rootNodes){
        if(node.inner.indexOf('<') >= 0 || !xmlOnlyKnownAttrs(node.attrs,[])) return '';
        const value = node.inner.trim();
        if(value) roots.push(value);
      }
    }
    for(const profile of profiles){
      if(!xmlOnlyKnownAttrs(profile.attrs,['type'])) return '';
      const profileMode = xmlAttrValue(profile.attrs,'type');
      const fileSystems = xmlElements(profile.inner,'file_system');
      if(xmlUnknownRemainder(profile.inner,fileSystems)) return '';
      for(const fileSystem of fileSystems){
        if(!xmlOnlyKnownAttrs(fileSystem.attrs,['type'])) return '';
        const fileMode = xmlAttrValue(fileSystem.attrs,'type');
        const mode = [profileMode,fileMode].filter(Boolean).join(' · ');
        if(mode && !modes.includes(mode)) modes.push(mode);
        const entries = xmlElements(fileSystem.inner,'entry');
        if(xmlUnknownRemainder(fileSystem.inner,entries)) return '';
        for(const entry of entries){
          if(!xmlOnlyKnownAttrs(entry.attrs,['access'])) return '';
          const paths = xmlElements(entry.inner,'path');
          const specials = xmlElements(entry.inner,'special');
          if(xmlUnknownRemainder(entry.inner,[...paths,...specials])) return '';
          const targetNodes = [...paths,...specials];
          if(!targetNodes.length || targetNodes.some(node => node.inner.indexOf('<') >= 0 || !xmlOnlyKnownAttrs(node.attrs,[]))) return '';
          const targets = targetNodes.map(node => node.inner.trim()).filter(Boolean);
          if(!targets.length) return '';
          targets.forEach(target => rules.push({ access:xmlAttrValue(entry.attrs,'access') || L('规则','rule'), target }));
        }
      }
    }
  }
  if(!facts.length && !roots.length && !rules.length && !modes.length) return '';

  const factsHtml = facts.length ? '<div class="env-facts">'+facts.map(item =>
    '<div class="env-fact"><span class="env-fact-k" title="'+esc(item.key)+'">'+esc(item.label)+'</span><span class="env-fact-v">'+esc(item.value)+'</span></div>'
  ).join('')+'</div>' : '';
  const fsMeta = [];
  if(roots.length) fsMeta.push(roots.length+L(' 个工作区',' workspaces'));
  fsMeta.push(...modes);
  if(rules.length) fsMeta.push(rules.length+L(' 条权限',' permissions'));
  const rootRows = roots.map(value => '<div class="env-file-row"><span class="env-file-label">'+L('工作区','Workspace')+'</span><span class="env-file-value">'+esc(value)+'</span></div>');
  const ruleRows = rules.map(rule => {
    const access = rule.access === 'read' ? L('读取','Read') : (rule.access === 'write' ? L('写入','Write') : rule.access);
    return '<div class="env-file-row"><span class="env-file-label">'+esc(access)+'</span><span class="env-file-value">'+esc(rule.target)+'</span></div>';
  });
  const fileHtml = (rootRows.length || ruleRows.length || fsMeta.length)
    ? '<details class="env-file"><summary class="env-file-sum"><span class="env-file-k">'+L('文件系统与权限','Filesystem and permissions')+'</span><span class="env-file-meta">'+esc(fsMeta.join(' · '))+'</span></summary><div class="env-file-body">'+rootRows.join('')+ruleRows.join('')+'</div></details>'
    : '';
  return '<div class="env-context-body">'+factsHtml+fileHtml+'</div>';
}
function renderTextRich(text){
  // text-block PRETTY 视图：保留顶层 XML 标签折叠，其余文本走 markdown 渲染。
  // 在 fenced code（\`\`\`...\`\`\`）内部不做 XML fold 探测，避免误伤代码里的尖括号。
  const s = String(text || '');
  if(!s) return '';
  const out = [];
  let buf = '';
  const flushBuf = () => { if(buf){ out.push(renderMarkdown(buf)); buf = ''; } };
  let i = 0;
  const len = s.length;
  let inFence = false;
  while(i < len){
    const lineStart = (i === 0) || s.charCodeAt(i - 1) === 10;
    if(lineStart){
      // 检测 fenced code 边界：行首 \`\`\`（可带语言）
      const fence = /^\`\`\`[^\\n]*\\r?\\n?/.exec(s.slice(i));
      if(fence){
        // fence 行整体保留进 buf，让 renderMarkdown 处理代码块语义
        buf += s.slice(i, i + fence[0].length);
        i += fence[0].length;
        inFence = !inFence;
        continue;
      }
      if(!inFence){
        const m = /^<([A-Za-z][\\w-]*)(\\s[^>\\n]*)?>/.exec(s.slice(i));
        if(m){
          const tag = m[1];
          const attrs = m[2] || '';
          let depth = 1;
          let scan = i + m[0].length;
          let closeAt = -1;
          const openProbe = '<' + tag;
          const closeProbe = '</' + tag + '>';
          while(scan < len){
            const nextClose = s.indexOf(closeProbe, scan);
            if(nextClose < 0) break;
            let nextOpen = -1;
            let probeFrom = scan;
            while(probeFrom < nextClose){
              const cand = s.indexOf(openProbe, probeFrom);
              if(cand < 0 || cand >= nextClose) break;
              const after = s.charCodeAt(cand + openProbe.length);
              if(after === 0x20 || after === 0x09 || after === 0x3e){ nextOpen = cand; break; }
              probeFrom = cand + openProbe.length;
            }
            if(nextOpen >= 0 && nextOpen < nextClose){
              depth++;
              const gt = s.indexOf('>', nextOpen);
              scan = gt < 0 ? nextClose : gt + 1;
            } else {
              depth--;
              if(depth === 0){ closeAt = nextClose; break; }
              scan = nextClose + closeProbe.length;
            }
          }
          if(closeAt >= 0){
            flushBuf();
            let inner = s.slice(i + m[0].length, closeAt);
            if(inner.charCodeAt(0) === 13) inner = inner.slice(1);
            if(inner.charCodeAt(0) === 10) inner = inner.slice(1);
            const lineCount = inner.split(/\\r?\\n/).length;
            const charCount = inner.length;
            const attrHtml = attrs ? '<span class="xml-attr">'+esc(attrs)+'</span>' : '';
            const structured = tag.toLowerCase() === 'environment_context' && !attrs.trim() ? renderEnvironmentContext(inner) : '';
            const summaryLabel = structured ? esc(L('环境上下文','Environment context')) : '&lt;'+esc(tag)+attrHtml+'&gt;';
            out.push('<details class="xml-fold'+(structured?' env-context':'')+'" open><summary class="xml-fold-sum"><span class="xml-tag">'+summaryLabel+'</span><span class="xml-meta">'+lineCount+' \u884c \u00b7 '+charCount+' \u5b57\u7b26</span></summary><div class="xml-fold-body">'+(structured || renderTextRich(inner))+'</div></details>');
            const closeLen = closeProbe.length;
            i = closeAt + closeLen;
            if(s.charCodeAt(i) === 13) i++;
            if(s.charCodeAt(i) === 10) i++;
            continue;
          }
        }
      }
    }
    const nl = s.indexOf('\\n', i);
    const end = nl < 0 ? len : nl + 1;
    buf += s.slice(i, end);
    i = end;
  }
  flushBuf();
  return out.join('');
}
function renderImageBlock(b){
  const url = imageSrc(b);
  if(url) return '<img class="content-image" src="'+esc(url)+'" alt="'+esc(L('请求中的图片','Image in request'))+'" loading="lazy">';
  return '<div class="codebox">[Image]</div>';
}
function imageSrc(b){
  if(!b || typeof b !== 'object') return '';
  if(typeof b.image_url === 'string') return b.image_url;
  if(b.image_url && typeof b.image_url === 'object' && b.image_url.url) return b.image_url.url;
  if(typeof b.url === 'string') return b.url;
  const src = b.source;
  if(src && typeof src === 'object'){
    if(src.type === 'url' && src.url) return src.url;
    if(src.type === 'base64' && src.data) return 'data:'+(src.media_type || 'image/png')+';base64,'+src.data;
    if(src.data) return 'data:'+(src.media_type || 'image/png')+';base64,'+src.data;
  }
  return '';
}
function blockWrap(html, many, raw, plain){
  // 多模式视图：默认 pretty（解析后），可切到 raw（原始 JSON）。
  // 仅当 raw 是 object 才显示切换器；纯字符串/图片 block 不展示。
  // plain=true 标记「白底纯文本块」：相邻两个这样的块之间才补智能补线（.txtsib+.txtsib）。
  const showFmt = raw && typeof raw === 'object';
  const fmt = showFmt
    ? '<div class="block-fmt">'+
        '<button class="block-fmt-btn active" data-bfmt="pretty" title="'+L('解析视图','Formatted view')+'">PRETTY</button>'+
        '<button class="block-fmt-btn" data-bfmt="raw" title="'+L('原始 JSON','Raw JSON')+'">RAW</button>'+
      '</div>'
    : '';
  const rawPane = showFmt
    ? '<div class="block-pane" data-bfmt-pane="raw" style="display:none"><pre class="codebox">'+esc(j(raw))+'</pre></div>'
    : '';
  return '<div class="content-block '+(many?'block-framed':'')+(plain?' txtsib':'')+'" data-bfmt="pretty">'+
    fmt+
    '<div class="block-pane" data-bfmt-pane="pretty">'+html+'</div>'+
    rawPane+
  '</div>';
}
function declaredToolList(b){
  // Codex Desktop 0.144+ ("responses-lite") ships tool declarations as an input
  // item {type:'additional_tools', role:'developer', tools:[...]} instead of the
  // top-level tools field. Both containers can appear in one request.
  const out = [];
  if(Array.isArray(b.tools)) b.tools.forEach(tool => {
    // Gemini groups declarations: tools:[{functionDeclarations:[...]}].
    if(tool && typeof tool === 'object' && Array.isArray(tool.functionDeclarations)) out.push(...tool.functionDeclarations);
    else out.push(tool);
  });
  if(Array.isArray(b.input)) b.input.forEach(item => {
    if(item && typeof item === 'object' && item.type === 'additional_tools' && Array.isArray(item.tools)) out.push(...item.tools);
  });
  return out;
}
function normalizeToolDecl(tool){
  if(!tool || typeof tool !== 'object') return tool;
  // Chat Completions nests everything under a function object. Read mode only needs
  // the human-facing fields; the untouched wrapper remains available in Log mode.
  if(tool.function) return { name:tool.function.name, description:tool.function.description, input_schema:tool.function.parameters || {} };
  // tool_search declares no name; the name is implied by the type.
  if(tool.type === 'tool_search' && !tool.name) return Object.assign({}, tool, { name:'tool_search' });
  return tool;
}
function tools(t){
  const b = bodyOf(t);
  const declared = declaredToolList(b);
  if(declared.length) return declared.map(normalizeToolDecl);
  if(Array.isArray(b.functions)) return b.functions.map(fn => ({ name:fn.name, description:fn.description, input_schema:fn.parameters || {} }));
  // Nothing declared up front: fall back to tools pulled in mid-turn by tool_search
  // so the section is never blank while the model can still call something.
  return searchLoadedTools(b);
}
/** Tools pulled in mid-turn by tool_search; declarations live in tool_search_output.tools. */
function searchLoadedTools(b){
  const out = [];
  if(Array.isArray(b.input)) b.input.forEach(item => {
    if(item && typeof item === 'object' && item.type === 'tool_search_output' && Array.isArray(item.tools)) out.push(...item.tools);
  });
  return out.map(normalizeToolDecl);
}
// 可调用工具总数。namespace 声明在列表里只占一项，但它下面挂着 N 个真正可调用的子工具
// （实测 Codex 一轮 20 个顶层声明 = 161 个可调用工具，MCP 那几个命名空间就占了 137 个）。
// 这个数字是用来判断 prompt 有多重的，所以按可调用数算，而不是按声明条数算。
function toolsCount(t){
  let n = 0;
  for(const tool of tools(t)) n += callableToolCount(tool);
  return n;
}
function callableToolCount(tool){
  if(!tool || typeof tool !== 'object') return 1;
  if(Array.isArray(tool.tools)){
    let n = 0;
    for(const child of tool.tools) n += callableToolCount(child);
    return n || 1;   // 声明了命名空间但子列表是空的（尚未 tool_search 拉取）仍算它自己一项
  }
  return 1;
}
function embeddedToolCount(tool){
  if(!tool || typeof tool !== 'object') return 0;
  let n = embeddedToolEntries(toolDeclDescription(tool)).length;
  if(Array.isArray(tool.tools)) for(const child of tool.tools) n += embeddedToolCount(child);
  return n;
}
function toolsBadge(t){
  const declared = toolsCount(t);
  const embedded = tools(t).reduce((sum, tool) => sum + embeddedToolCount(tool), 0);
  return declared+' '+L('个直接工具','direct tools')+(embedded ? ' · '+embedded+' '+L('个嵌套工具','nested tools') : '');
}
function toolDeclDisplayName(tool){
  if(!tool) return 'tool';
  if(tool.name) return tool.name;
  if(tool.id) return tool.id;
  if(tool.function && tool.function.name) return tool.function.name;
  if(tool.type) return tool.type;
  return 'tool';
}
function toolDeclDescription(tool){
  return tool && (tool.description || (tool.function && tool.function.description)) || '';
}
function toolDeclSchema(tool){
  return tool && (tool.input_schema || tool.parameters || (tool.function && tool.function.parameters));
}
function toolDeclKind(tool){
  if(!tool || !tool.type) return '';
  return String(tool.type);
}
function renderTools(t){
  const list = tools(t);
  if(!list.length) return '<div class="empty">'+L('此请求没有工具','No tools in this request')+'</div>';
  return list.map((tool,i) => {
    const name = toolDeclDisplayName(tool);
    const desc = toolDeclDescription(tool);
    const kind = toolDeclKind(tool);
    const kindHtml = kind && kind !== name ? '<span class="tool-kind">'+esc(kind)+'</span>' : '';
    return '<div class="tool-block" data-tool="'+i+'"><div class="tool-head" role="button" tabindex="0" aria-expanded="false"><span class="tool-tw">▶</span><span class="tool-name">'+esc(name)+'</span>'+kindHtml+'<span class="tool-desc">'+esc(short(toolDescriptionIntro(desc),120))+'</span></div><div class="cw" aria-hidden="true"><div class="tool-body">'+renderToolBody(tool)+'</div></div></div>';
  }).join('');
}
function renderToolBody(tool){
  const desc = toolDeclDescription(tool);
  const children = tool && Array.isArray(tool.tools) ? tool.tools : [];
  const intro = toolDescriptionIntro(desc);
  const embedded = embeddedToolEntries(desc);
  return (intro?'<div class="tool-full">'+esc(intro)+'</div>':'')+
    toolDeclFlags(tool)+
    (embedded.length ? renderEmbeddedTools(embedded, desc, toolDeclDisplayName(tool)) : '')+
    (children.length ? renderSubtools(children) : renderParams(toolDeclSchema(tool), tool));
}
function toolDescriptionIntro(description){
  const lines = String(description || '').replace(/\\r/g,'').split('\\n');
  for(const raw of lines){
    const line = raw.trim();
    if(!line || /^#{1,6}\\s/.test(line) || /^\\x60{3}/.test(line)) continue;
    return line.replace(/^[-*]\\s+/,'').replace(/\\x60([^\\x60]+)\\x60/g,'$1');
  }
  return '';
}
// Codex 的 exec 声明把可调用操作和 TypeScript 签名写进一大段 Markdown。
// 阅读页只取三级标题和第一句用途；完整原文仍可在 Log 里核对。
function embeddedToolEntries(description){
  const text = String(description || '').replace(/\\r/g,'');
  const matches = Array.from(text.matchAll(/^###\\s+\\x60?([A-Za-z0-9_.:-]+)\\x60?\\s*$/gm));
  const out = [];
  for(let i=0;i<matches.length;i++){
    const start = matches[i].index + matches[i][0].length;
    const end = i+1 < matches.length ? matches[i+1].index : text.length;
    const body = text.slice(start,end);
    if(!/exec tool declaration:/i.test(body)) continue;
    let summary = '';
    let fenced = false;
    for(const raw of body.split('\\n')){
      const line = raw.trim();
      if(/^\\x60{3}/.test(line)){ fenced = !fenced; continue; }
      if(fenced || !line || /^exec tool declaration:/i.test(line) || /^#{1,6}\\s/.test(line)) continue;
      summary = line.replace(/^[-*]\\s+/,'').replace(/\\x60([^\\x60]+)\\x60/g,'$1');
      break;
    }
    out.push({ name:matches[i][1], summary });
  }
  return out;
}
function renderEmbeddedTools(entries, description, parentName){
  const rows = entries.map(entry => '<div class="embedded-tool-row"><span class="embedded-tool-name">'+esc(entry.name)+'</span><span class="embedded-tool-desc">'+esc(entry.summary || L('本次声明未附用途说明','No purpose supplied in this declaration'))+'</span></div>').join('');
  const deferred = /deferred nested tools may be omitted/i.test(String(description || ''))
    ? '<div class="embedded-tool-note">'+L('此清单来自本次声明；延迟加载的操作可能只在运行时出现。','This list comes from the current declaration; deferred operations may appear only at runtime.')+'</div>'
    : '';
  const title = parentName
    ? L(esc(parentName)+' 提供的工具','Tools available through '+esc(parentName))
    : L('嵌套工具','Nested tools');
  return '<div class="param-title">'+title+' · '+entries.length+'</div><div class="embedded-tools">'+rows+'</div>'+deferred;
}
// 声明里那些改变工具行为、但既不是 name/description/schema 的字段。漏掉它们会读错请求：
// external_web_access:false 说的是「联网其实是关的」，max_uses 是调用次数上限，
// defer_loading 表示这条只是占位、真正的定义要靠 tool_search 拉取。
function toolDeclFlags(tool){
  if(!tool || typeof tool !== 'object') return '';
  const flags = [];
  const add = (label, value) => flags.push('<span class="tool-flag"><span class="tool-flag-k">'+esc(label)+'</span>'+esc(value)+'</span>');
  if(typeof tool.max_uses === 'number') add(L('调用上限','max uses'), String(tool.max_uses));
  if(tool.external_web_access === false) add(L('联网','web access'), L('关闭','off'));
  else if(tool.external_web_access === true) add(L('联网','web access'), L('开启','on'));
  if(tool.defer_loading === true) add(L('延迟加载','deferred'), L('占位声明，定义待 tool_search 拉取','placeholder; definition arrives via tool_search'));
  if(tool.strict === true) add(L('严格模式','strict'), 'true');
  if(tool.execution) add(L('执行侧','execution'), String(tool.execution));
  if(tool.cache_control && tool.cache_control.type) add(L('缓存','cache'), String(tool.cache_control.type));
  return flags.length ? '<div class="tool-flags">'+flags.join('')+'</div>' : '';
}
function renderSubtools(children){
  return '<div class="tool-subtools"><div class="param-title">'+L('子工具','Child tools')+'</div>'+
    children.map(child => {
      const name = toolDeclDisplayName(child);
      const desc = toolDeclDescription(child);
      const kind = toolDeclKind(child);
      const kindHtml = kind && kind !== name ? '<span class="tool-kind">'+esc(kind)+'</span>' : '';
      return '<details class="tool-child"><summary class="tool-child-head"><span class="tool-child-name">'+esc(name)+'</span>'+kindHtml+(desc?'<span class="tool-child-desc">'+esc(short(toolDescriptionIntro(desc),120))+'</span>':'')+'</summary><div class="tool-child-body">'+renderToolBody(child)+'</div></details>';
    }).join('')+
  '</div>';
}
function renderParams(schema, tool){
  if(tool && tool.type === 'custom' && tool.format){
    const fmt = tool.format && (tool.format.syntax || tool.format.type) ? ' · '+(tool.format.syntax || tool.format.type) : '';
    return '<div class="tool-note">'+L('自由文本输入','Free-form input')+esc(fmt)+'</div>';
  }
  if(schema && typeof schema === 'object' && Object.keys(schema).length){
    const rows = flattenSchemaRows(schema,'',false,0);
    return '<div class="param-title">'+L('参数','Parameters')+'</div><div class="schema-list">'+(rows.length ? rows.map(renderSchemaRow).join('') : '<div class="tool-note">'+L('无参数','No parameters')+'</div>')+'</div>';
  }
  if(tool && tool.type && tool.type !== 'function') return '<div class="tool-note">'+L('内置工具；没有暴露 JSON 参数 schema。','Built-in tool; no JSON parameter schema is exposed.')+'</div>';
  return '<div class="tool-note">'+L('无参数','No parameters')+'</div>';
}
function flattenSchemaRows(schema, name, required, depth, typeOverride){
  if(depth > 14 || !schema || typeof schema !== 'object') return [];
  const isArray = schema.type === 'array' || (!schema.type && schema.items !== undefined);
  const rows = name ? [{ name, depth:Math.max(0,depth-1), type:typeOverride || schemaTypeLabel(schema), required, help:schemaHelp(schema) }] : [];
  const childSchema = isArray && schema.items && typeof schema.items === 'object' ? schema.items : schema;
  const props = childSchema.properties && typeof childSchema.properties === 'object' ? childSchema.properties : {};
  const requiredSet = new Set(Array.isArray(childSchema.required) ? childSchema.required : []);
  const keys = Object.keys(props);
  // question 与 options 在 JSON Schema 里是同一对象的兄弟字段，但人类阅读时 options
  // 明显是这道 question 的答案集合。阅读视图把它排到 question 后并多缩进一级；
  // Log 仍保留原始字段顺序和结构，不改请求内容。
  if(Object.prototype.hasOwnProperty.call(props,'question') && Object.prototype.hasOwnProperty.call(props,'options')){
    const optionIndex = keys.indexOf('options');
    if(optionIndex >= 0) keys.splice(optionIndex,1);
    keys.splice(keys.indexOf('question')+1,0,'options');
  }
  for(const key of keys){
    const semanticChild = key === 'options' && Object.prototype.hasOwnProperty.call(props,'question');
    rows.push(...flattenSchemaRows(props[key],key,requiredSet.has(key),depth+1+(semanticChild?1:0)));
  }
  if(childSchema.additionalProperties && typeof childSchema.additionalProperties === 'object'){
    const anyValue = Object.keys(childSchema.additionalProperties).length === 0 ? L('任意值','any value') : undefined;
    rows.push(...flattenSchemaRows(childSchema.additionalProperties,L('任意键','Any key'),false,depth+1,anyValue));
  }
  return rows;
}
function renderSchemaRow(row){
  const depth = Math.max(0,Math.min(8,Number(row.depth) || 0));
  return '<div class="schema-row schema-depth-'+depth+'" style="--schema-depth:'+depth+'"><div class="schema-head"><span class="schema-field">'+esc(row.name)+'</span><span class="schema-type">'+esc(row.type)+'</span>'+(row.required?'<span class="schema-required">'+L('必填','required')+'</span>':'')+'</div><div class="schema-help'+(row.help?'':' schema-help-empty')+'">'+esc(row.help || '')+'</div></div>';
}
function schemaTypeName(type){
  const key = String(type || '');
  if(key === 'string') return L('文本','text');
  if(key === 'object') return L('对象','object');
  if(key === 'boolean') return L('布尔值','boolean');
  if(key === 'integer') return L('整数','integer');
  if(key === 'number') return L('数字','number');
  if(key === 'null') return L('空值','null');
  return key || L('未指定','unspecified');
}
function schemaTypeLabel(schema){
  if(Array.isArray(schema.type)) return schema.type.map(schemaTypeName).join(' | ');
  if(schema.type === 'array' || (!schema.type && schema.items)){
    const itemType = schemaTypeLabel(schema.items || {});
    return L(itemType+'列表','list of '+itemType);
  }
  if(schema.type) return schemaTypeName(schema.type);
  if(schema.enum) return L('枚举','enum');
  if(schema.const !== undefined) return L('固定值','constant');
  for(const kind of ['anyOf','oneOf','allOf']){
    if(Array.isArray(schema[kind])) return Array.from(new Set(schema[kind].map(schemaTypeLabel))).join(' | ');
  }
  if(schema.properties || schema.additionalProperties !== undefined) return schemaTypeName('object');
  if(schema['$ref']) return L('引用','reference');
  return L('未指定','unspecified');
}
function schemaHelp(schema){
  const parts = [];
  if(schema.description) parts.push(String(schema.description));
  const values = [];
  const seen = new Set();
  const addValue = value => {
    const label = typeof value === 'string' ? value : j(value);
    if(!seen.has(label)){ seen.add(label); values.push(label); }
  };
  const collectValues = value => {
    if(!value || typeof value !== 'object') return;
    if(Array.isArray(value.enum)) value.enum.forEach(addValue);
    if(value.const !== undefined) addValue(value.const);
    for(const kind of ['anyOf','oneOf']) if(Array.isArray(value[kind])) value[kind].forEach(collectValues);
  };
  collectValues(schema);
  if(values.length) parts.push(L('可选值：','Values: ')+values.join(', '));
  if(schema.default !== undefined) parts.push(L('默认：','Default: ')+(typeof schema.default === 'string' ? schema.default : j(schema.default)));
  if(schema.format) parts.push(L('格式：','Format: ')+schema.format);
  if(schema.pattern) parts.push(L('模式：','Pattern: ')+schema.pattern);
  if(schema.propertyNames && typeof schema.propertyNames === 'object'){
    const keyType = schemaTypeLabel(schema.propertyNames);
    if(keyType) parts.push(L('键名：','Keys: ')+keyType);
  }
  const lower = schema.exclusiveMinimum !== undefined
    ? L('大于 ','Greater than ')+schema.exclusiveMinimum
    : schema.minimum !== undefined ? L('最小 ','Minimum ')+schema.minimum : '';
  const upper = schema.exclusiveMaximum !== undefined
    ? L('小于 ','Less than ')+schema.exclusiveMaximum
    : schema.maximum !== undefined ? L('最大 ','Maximum ')+schema.maximum : '';
  if(lower || upper) parts.push([lower,upper].filter(Boolean).join(' · '));
  if(schema.minLength !== undefined) parts.push(L('至少 ','At least ')+schema.minLength+L(' 个字符',' characters'));
  if(schema.maxLength !== undefined) parts.push(L('最多 ','At most ')+schema.maxLength+L(' 个字符',' characters'));
  if(schema.minItems !== undefined) parts.push(L('至少 ','At least ')+schema.minItems+L(' 项',' items'));
  if(schema.maxItems !== undefined) parts.push(L('最多 ','At most ')+schema.maxItems+L(' 项',' items'));
  return parts.join(' · ');
}
function renderSse(t){
  const events = t.sse && t.sse.events || [];
  if(!events.length) return '<div class="empty">'+L('非 SSE 响应或未收到事件','Non-SSE response or no events received')+'</div>';
  return sseEventGroups(events).map(item => {
    if(item.kind === 'group') return renderSseGroup(item);
    return renderSseRow(item.event, item.index, false);
  }).join('');
}
function renderSseRow(e, i, child){
  const data = sseEventData(e);
  const eventName = e.event || 'data';
  return '<details class="sse-row'+(child?' sse-child':'')+'" data-sse="'+i+'"><summary class="sse-sum"><span class="tm">'+ms(e.timestampMs)+'</span><span class="ev" title="'+esc(eventName)+'">'+esc(eventName)+'</span><span class="sse-peek">'+esc(sseEventSummary(e, data))+'</span><span class="sse-size">'+esc(charLabel(data))+'</span></summary><pre class="sse-data">'+esc(data)+'</pre></details>';
}
function renderSseGroup(group){
  const first = group.items[0] && group.items[0].event || {};
  const last = group.items[group.items.length - 1] && group.items[group.items.length - 1].event || first;
  const dataChars = group.items.reduce((sum, item) => sum + sseEventData(item.event).length, 0);
  const deltas = group.items.map(item => sseDeltaText(item.event, sseEventData(item.event))).filter(Boolean).join('');
  const preview = compactText(deltas, 220);
  const headline = group.items.length+' chunks'+(preview ? ' · '+preview : '');
  const rows = group.items.map(item => renderSseRow(item.event, item.index, true)).join('');
  return '<details class="sse-group" data-sse-group="'+esc(group.name)+'"><summary class="sse-group-sum"><span class="tm">'+ms(first.timestampMs)+'-'+ms(last.timestampMs)+'</span><span class="ev" title="'+esc(group.name)+'">'+esc(group.name)+'</span><span class="sse-peek">'+esc(headline)+'</span><span class="sse-size">'+esc(num(dataChars)+' chars')+'</span></summary><div class="sse-group-body">'+rows+'</div></details>';
}
function sseEventGroups(events){
  const out = [];
  let run = [];
  const flush = () => {
    if(!run.length) return;
    if(run.length >= 4){
      out.push({ kind:'group', name:run[0].event.event || 'data', items:run });
    } else {
      run.forEach(item => out.push({ kind:'row', event:item.event, index:item.index }));
    }
    run = [];
  };
  events.forEach((event, index) => {
    const data = sseEventData(event);
    const delta = isSseDeltaEvent(event, data);
    const same = run.length && (run[0].event.event || 'data') === (event.event || 'data');
    if(delta && (!run.length || same)){
      run.push({ event, index });
      return;
    }
    flush();
    if(delta) run.push({ event, index });
    else out.push({ kind:'row', event, index });
  });
  flush();
  return out;
}
function sseEventData(e){
  if(!e || e.data == null) return '';
  return typeof e.data === 'string' ? e.data : j(e.data);
}
function isSseDeltaEvent(e, data){
  const name = e && e.event || '';
  if(/(?:\.|_)delta$/i.test(name)) return true;
  const parsed = parseJsonMaybe(data);
  return !!(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (typeof parsed.delta === 'string' || (parsed.delta && typeof parsed.delta === 'object') || /(?:\.|_)delta$/i.test(String(parsed.type || ''))));
}
function sseDeltaText(e, data){
  const parsed = parseJsonMaybe(data);
  if(parsed && typeof parsed === 'object' && !Array.isArray(parsed)){
    if(typeof parsed.delta === 'string') return parsed.delta;
    if(parsed.delta && typeof parsed.delta === 'object'){
      const d = parsed.delta;
      if(typeof d.text === 'string') return d.text;
      if(typeof d.thinking === 'string') return d.thinking;
      if(typeof d.partial_json === 'string') return d.partial_json;
      if(typeof d.content === 'string') return d.content;
    }
    if(typeof parsed.text === 'string') return parsed.text;
  }
  return '';
}
function sseEventSummary(e, data){
  const parsed = parseJsonMaybe(data);
  const deltaText = sseDeltaText(e, data);
  if(deltaText) return compactText(deltaText, 180);
  if(parsed && typeof parsed === 'object' && !Array.isArray(parsed)){
    if(typeof parsed.delta === 'string') return 'delta: '+compactText(parsed.delta, 160);
    if(typeof parsed.text === 'string') return compactText(parsed.text, 180);
    if(parsed.response && typeof parsed.response === 'object'){
      const r = parsed.response;
      return ['response', r.status, r.model, Array.isArray(r.tools) ? r.tools.length+' tools' : ''].filter(Boolean).join(' · ');
    }
    if(parsed.item && typeof parsed.item === 'object'){
      const item = parsed.item;
      return ['item', item.type, item.status, item.name].filter(Boolean).join(' · ');
    }
    if(parsed.type) return String(parsed.type);
  }
  return compactText(data, 220);
}
function compactText(value, limit){
  const s = String(value || '').replace(/\\s+/g, ' ').trim();
  if(s.length <= limit) return s;
  return s.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}
function parseJsonMaybe(value){ if(value === undefined || value === null || value === '') return {}; if(typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } }
function jsonTreeRows(value,depth,path){
  path = path || [];
  if(Array.isArray(value)) return value.map((item,index) => jsonTree(item,String(index),depth,path.concat(index))).join('');
  if(value && typeof value === 'object') return Object.keys(value).map(key => jsonTree(value[key],key,depth,path.concat(key))).join('');
  return jsonTree(value,undefined,depth,path);
}
function jsonTree(value,key,depth,path){
  depth = depth || 0;
  path = path || [];
  const label = key === undefined ? '' : '<span class="json-key">'+esc(key)+'</span>: ';
  if(isDeferredLogMarker(value)) return deferredLogFoldHtml(key, value, 'json-log-field', 'json');
  if(value === null) return '<div class="json-leaf">'+label+'<span class="json-null">null</span></div>';
  if(Array.isArray(value)){
    const pathKey = logFoldPath(path);
    const foldAttrs = logFoldAttrs('json',pathKey,depth < 2 && !LOG_DEFAULT_CLOSED_KEYS.has(String(key || '')));
    const rows = jsonTreeRows(value,depth+1,path);
    return '<details class="json-node"'+foldAttrs+'><summary>'+label+'[ ] <span class="json-count">'+value.length+'</span></summary>'+rows+'</details>';
  }
  if(typeof value === 'object'){
    const keys = Object.keys(value);
    const pathKey = logFoldPath(path);
    const foldAttrs = logFoldAttrs('json',pathKey,depth < 2 && !LOG_DEFAULT_CLOSED_KEYS.has(String(key || '')));
    const rows = jsonTreeRows(value,depth+1,path);
    return '<details class="json-node"'+foldAttrs+'><summary>'+label+'{ } <span class="json-count">'+keys.length+'</span></summary>'+rows+'</details>';
  }
  if(typeof value === 'string') return '<div class="json-leaf">'+label+'<span class="json-string">"'+esc(value)+'"</span></div>';
  if(typeof value === 'number') return '<div class="json-leaf">'+label+'<span class="json-num">'+esc(value)+'</span></div>';
  if(typeof value === 'boolean') return '<div class="json-leaf">'+label+'<span class="json-bool">'+esc(value)+'</span></div>';
  return '<div class="json-leaf">'+label+esc(String(value))+'</div>';
}
function traceToCurl(t){
  const headers = t.request && t.request.headers || {};
  const parts = ['curl','-X',shellQuote(t.request && t.request.method || 'POST'),shellQuote(t.upstream && t.upstream.url || '')];
  Object.keys(headers).forEach(k => { const lower=k.toLowerCase(); if(lower === 'host' || lower === 'content-length') return; const v=Array.isArray(headers[k]) ? headers[k].join(', ') : headers[k]; parts.push('-H',shellQuote(k+': '+v)); });
  const rawBody = t.request && t.request.rawBody || '';
  const parsedBody = t.request && t.request.body;
  const body = t.request && (rawBody || (parsedBody !== undefined ? JSON.stringify(parsedBody) : ''));
  if(body) parts.push('--data-raw', shellQuote(body));
  return parts.join(' ');
}
function shellQuote(value){ return "'" + String(value || '').replace(/'/g, "'\\\\''") + "'"; }
function promptSnapshot(t){
  const b = bodyOf(t); const lines = []; const sys = systemValue(t);
  if(sys && String(typeof sys === 'string' ? sys : j(sys)).trim()) lines.push('# System','',typeof sys === 'string' ? sys : j(sys),'');
  getMessages(t).forEach(m => { lines.push('## '+(m.role || 'message'),'',blocksText(normalizeBlocks(m.content)),''); });
  return lines.join('\\n').trim() || j(t.request && t.request.body || {});
}
function blocksText(blocks){ return blocks.map(b => { if(!b || typeof b !== 'object') return j(b); if(b.type === 'text') return b.text || ''; if(b.type === 'thinking') return '[thinking]\\n'+(b.thinking || b.text || ''); if(b.type === 'tool_use') return '[tool_use '+(b.name || 'tool')+']\\n'+j(b.input); if(b.type === 'tool_result') return '[tool_result]\\n'+(typeof b.content === 'string' ? b.content : j(b.content)); return j(b); }).filter(Boolean).join('\\n\\n'); }
function markdownTrace(t){
  const u=usageOf(t);
  return ['# Trace '+stableTraceOrdinal(t, ''),'','- Time: '+(t.startedAt || ''),'- Model: '+(t.request && t.request.model || 'unknown'),'- Endpoint: '+(t.request && t.request.method || 'POST')+' '+forwardedEndpoint(t),'- Status: '+(t.response && t.response.statusCode || 'n/a'),'- Duration: '+ms(t.durationMs),'- Tokens: input '+(u.inputTokens || 0)+', output '+(u.outputTokens || 0)+', cache read '+(u.cacheReadTokens || 0)+', cache create '+(u.cacheCreationTokens || 0),'','## Prompt','','\`\`\`text',promptSnapshot(t),'\`\`\`','','## Response','','\`\`\`json',j(responseSnapshot(t) || t.response && t.response.body || {}),'\`\`\`'].join('\\n');
}
async function copyText(text){
  try { if(navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); toast('已复制'); return; } } catch {}
  const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); toast('已复制');
}
function downloadText(name,text){
  const blob = new Blob([text], { type:'text/markdown;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); URL.revokeObjectURL(a.href); document.body.removeChild(a);
}
let diffBaseId; // diff 对照回合 id；默认上一轮，对比视图里可换任意更早回合
let diffBaseTurn;
let diffSelOpen = false; // 对照回合下拉的开合态（自绘下拉，跨 renderDiff 重建保留）
const diffTraceCache = new Map();
const diffTraceLoading = new Set();
const diffTraceErrors = new Map();
const diffSectionState = {};
// 重绘对比视图：对照回合选择器渲到 bar 的 cmp-controls(#diffPick)，diff 正文渲到 view-cmp(#diffBody)。
// 当前回合是锚点（只读 chip），对照回合限定更早回合，‹ › 步进 / 下拉直选 / 键盘左右键三种方式都落到 diffBaseId 后走这里。

function renderDiff(){
  const list = traces(); const t = currentTrace();
  const choiceGroups = diffChoiceGroups(list, t);
  const flat = flattenDiffChoices(choiceGroups);
  let selected = flat.find(x => diffChoiceKey(x) === activeDiffChoiceKey());
  if(!selected){
    selected = flat[0];
    diffBaseId = selected && selected.id;
    diffBaseTurn = selected && selected.turn;
  }
  const selectedKey = selected ? diffChoiceKey(selected) : '';
  const base = selected ? diffTraceForChoice(list, selected) : undefined;
  const navChoices = diffNavigationChoices(choiceGroups, selectedKey);
  const navIdx = navChoices.findIndex(x => diffChoiceKey(x) === selectedKey);
  const cacheKey = selected && selected.turn ? diffTraceCacheKey(selected.turn) : '';
  const loadError = cacheKey ? diffTraceErrors.get(cacheKey) : '';
  if(selected && !base && selected.turn && !diffTraceLoading.has(cacheKey) && !loadError){
    void loadDiffTrace(selected.turn);
  }
  const pick = el('diffPick');
  if(pick){
    if(flat.length){
      const tickSvg = '<svg class="diff-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      const options = choiceGroups.map(group => {
        if(!group.items.length) return '';
        const rows = group.items.map(item => {
          const isSelected = diffChoiceKey(item) === selectedKey;
          return '<div class="diff-opt'+(isSelected?' selected':'')+'" role="option" aria-selected="'+(isSelected?'true':'false')+'" data-diff-opt="'+esc(item.id || '')+'" data-diff-turn="'+esc(item.turn || '')+'">'+tickSvg+'<span>'+esc(item.label)+'</span></div>';
        }).join('');
        return '<div class="diff-optgroup" role="presentation">'+esc(group.label)+'</div>'+rows;
      }).join('');
      pick.innerHTML =
        '<button type="button" class="diff-nav" id="diffPrev"'+(navIdx<=0?' disabled':'')+' title="'+L('更早的对比请求','Earlier compare request')+'" aria-label="'+L('更早的对比请求','Earlier compare request')+'"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 6 9 12 15 18"></polyline></svg></button>'+
        '<div class="diff-sel-wrap'+(diffSelOpen?' open':'')+'" id="diffBase">'+
          '<button type="button" class="diff-sel" id="diffSelBtn" aria-haspopup="listbox" aria-expanded="'+(diffSelOpen?'true':'false')+'" title="'+L('选择对比请求','Select request to compare')+'">'+
            '<span class="diff-sel-label">'+esc(selected ? selected.label : L('选择对比请求','Select request to compare'))+'</span>'+
            '<svg class="diff-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>'+
          '</button>'+
          '<div class="diff-pop" id="diffPop" role="listbox">'+options+'</div>'+
        '</div>'+
        '<button type="button" class="diff-nav" id="diffNext"'+(navIdx<0||navIdx>=navChoices.length-1?' disabled':'')+' title="'+L('更新的对比请求','Later compare request')+'" aria-label="'+L('更新的对比请求','Later compare request')+'"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg></button>'+
        '<span class="diff-cur" title="'+L('当前请求','Current request')+'">'+esc(t ? requestLabel(stableTraceOrdinal(t, '?')) : '')+'</span>';
    } else {
      diffSelOpen = false;
      pick.innerHTML = '<span class="lbl">'+L('第一条请求，没有更早的请求可对比。','First request; nothing earlier to compare.')+'</span>';
    }
  }
  const bodyEl = el('diffBody');
  if(bodyEl){
    if(base) bodyEl.innerHTML = diffHtml(base, t);
    else if(loadError) bodyEl.innerHTML = '<div class="cmp-summary"><span>'+esc(loadError)+'</span></div>';
    else if(selected) bodyEl.innerHTML = '<div class="cmp-summary"><span>'+L('正在加载对比请求…','Loading request to compare…')+'</span></div>';
    else bodyEl.innerHTML = '<div class="cmp-summary"><span>'+L('第一条请求，没有更早的请求可对比。','First request; nothing earlier to compare.')+'</span></div>';
  }
}
function stepDiffBase(delta){
  const list = traces(); const t = currentTrace();
  const groups = diffChoiceGroups(list, t);
  const activeKey = activeDiffChoiceKey();
  const choices = diffNavigationChoices(groups, activeKey);
  if(!choices.length) return;
  const cur = choices.findIndex(x => diffChoiceKey(x) === activeKey);
  if(cur < 0) return;
  const next = Math.min(choices.length - 1, Math.max(0, cur + delta));
  if(choices[next] && diffChoiceKey(choices[next]) !== activeKey) selectDiffChoice(choices[next]);
}
function diffChoiceKey(item){
  const turn = Number(item && item.turn);
  if(Number.isInteger(turn) && turn > 0) return 'turn:' + turn;
  return 'id:' + String(item && item.id || '');
}
function activeDiffChoiceKey(){
  const turn = Number(diffBaseTurn);
  if(Number.isInteger(turn) && turn > 0) return 'turn:' + turn;
  return 'id:' + String(diffBaseId || '');
}
function selectDiffChoice(item){
  if(!item) return;
  diffBaseId = item.id;
  diffBaseTurn = item.turn;
  if(item.turn) diffTraceErrors.delete(diffTraceCacheKey(item.turn));
  renderDiff();
}
function diffChoiceFromNode(node){
  if(!node) return undefined;
  const turn = Number(node.dataset.diffTurn);
  return {
    id: node.dataset.diffOpt || undefined,
    turn: Number.isInteger(turn) && turn > 0 ? turn : undefined,
    label: node.textContent || ''
  };
}
function diffTraceCacheKey(turn){ return selectedSessionId + '|' + turn; }
function rememberDiffTrace(key, trace){
  diffTraceCache.delete(key);
  diffTraceCache.set(key, trace);
  while(diffTraceCache.size > 32){
    const oldest = diffTraceCache.keys().next().value;
    diffTraceCache.delete(oldest);
  }
}
function diffTraceForChoice(list, choice){
  if(choice.id){
    const byId = list.find(trace => trace.id === choice.id);
    if(byId) return byId;
  }
  if(choice.turn){
    const loaded = list.find(trace => stableTraceOrdinal(trace, 0) === choice.turn);
    if(loaded) return loaded;
    return diffTraceCache.get(diffTraceCacheKey(choice.turn));
  }
  return undefined;
}
async function loadDiffTrace(turn){
  if(!LIVE_MODE || !selectedSessionId || !Number.isInteger(turn) || turn < 1) return;
  const sid = selectedSessionId;
  const key = sid + '|' + turn;
  if(diffTraceCache.has(key) || diffTraceLoading.has(key)) return;
  diffTraceLoading.add(key);
  diffTraceErrors.delete(key);
  try {
    const page = await fetchSessionPage(sid, turn - 1, 1);
    const trace = (page.traces || []).find(item => stableTraceOrdinal(item, 0) === turn);
    if(!trace) throw new Error(L('找不到请求 '+turn+'。','Request '+turn+' could not be found.'));
    rememberDiffTrace(key, trace);
    if(selectedSessionId === sid && diffBaseTurn === turn){
      diffBaseId = trace.id;
      renderDiff();
    }
  } catch (err) {
    diffTraceErrors.set(key, err && err.message ? err.message : L('加载对比请求失败','Could not load request to compare'));
    if(selectedSessionId === sid && diffBaseTurn === turn) renderDiff();
  } finally {
    diffTraceLoading.delete(key);
  }
}
function timelineDiffChoices(list, current){
  const currentTurn = stableTraceOrdinal(current, 0);
  if(currentTurn > 1){
    const byTurn = new Map();
    for(const trace of list){
      const turn = stableTraceOrdinal(trace, 0);
      if(turn > 0 && turn < currentTurn) byTurn.set(turn, trace);
    }
    const items = [];
    const firstTurn = LIVE_MODE ? 1 : Math.min(currentTurn, ...byTurn.keys());
    for(let turn = firstTurn; turn < currentTurn; turn++){
      const trace = byTurn.get(turn);
      items.push({ id:trace && trace.id, turn, label:requestLabel(turn) });
    }
    return items;
  }
  const rawIdx = list.findIndex(trace => trace && current && trace.id === current.id);
  if(rawIdx <= 0) return [];
  return list.slice(0, rawIdx).map((trace, index) => {
    const turn = stableTraceOrdinal(trace, index + 1);
    return { id:trace && trace.id, turn, label:requestLabel(turn) };
  });
}
function diffChoiceGroups(list, current){
  if(!current) return [];
  const view = logicalTraceView(list);
  const currentInfo = view.meta.get(current.id) || fallbackTraceInfo(current);
  const groups = [
    { key:'default', label:'Default', items:[] },
    { key:'mainline', label:'Mainline', items:[] },
    { key:'same-subagent', label:'Same Subagent', items:[] },
    { key:'auxiliary', label:'Auxiliary', items:[] },
    { key:'timeline', label:'Timeline', items:[] }
  ];
  const seen = new Set();
  const currentKey = diffChoiceKey({ id:current.id, turn:stableTraceOrdinal(current, 0) });
  const addItem = (group, item) => {
    if(!item) return;
    const key = diffChoiceKey(item);
    if(!key || key === currentKey || seen.has(key)) return;
    group.items.push(item);
    seen.add(key);
  };
  const add = (group, trace) => {
    if(!trace || !trace.id) return;
    const turn = stableTraceOrdinal(trace, 0);
    addItem(group, { id:trace.id, turn:turn || undefined, label:requestLabel(turn || trace.turn) });
  };
  const currentRank = logicalSortRank(current, view);
  const before = list.filter(t => t.id !== current.id && logicalSortRank(t, view) < currentRank);
  const mainsBefore = before.filter(t => (view.meta.get(t.id) || {}).kind === 'main');
  if(currentInfo.kind === 'main'){
    const prevMain = mainsBefore[mainsBefore.length - 1];
    add(groups[0], prevMain);
  } else if(currentInfo.kind === 'subagent'){
    const same = before.filter(t => {
      const info = view.meta.get(t.id) || {};
      return info.kind === 'subagent' && info.subGroupKey && info.subGroupKey === currentInfo.subGroupKey;
    });
    const prevSub = same[same.length - 1];
    const parent = list.find(t => t.id === currentInfo.parentId);
    add(groups[0], prevSub);
    add(groups[0], parent);
  } else if(currentInfo.kind === 'aux'){
    const parent = list.find(t => t.id === currentInfo.parentId);
    add(groups[0], parent);
  }
  const prevLogical = before[before.length - 1];
  add(groups[0], prevLogical);
  for(const t of list){
    const info = view.meta.get(t.id) || fallbackTraceInfo(t);
    if(info.kind === 'main' && info.sortRank < currentRank) add(groups[1], t);
    if(currentInfo.kind === 'subagent' && info.kind === 'subagent' && info.subGroupKey === currentInfo.subGroupKey && info.sortRank < currentRank) add(groups[2], t);
    if(info.kind === 'aux' && info.parentId === currentInfo.parentId && info.sortRank < currentRank) add(groups[3], t);
  }
  for(const item of timelineDiffChoices(list, current)) addItem(groups[4], item);
  return orderDiffChoiceGroups(groups).filter(g => g.items.length);
}
function orderDiffChoiceGroups(groups){
  for(const group of groups){
    if(group.key === 'default' || group.key === 'timeline') continue;
    group.items.sort((a, b) => {
      const aTurn = Number(a && a.turn) || 0;
      const bTurn = Number(b && b.turn) || 0;
      return bTurn - aTurn;
    });
  }
  return groups;
}
function flattenDiffChoices(groups){
  const seen = new Set();
  const out = [];
  for(const group of groups){
    for(const item of group.items){
      const key = diffChoiceKey(item);
      if(seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
function diffNavigationChoices(groups, activeKey){
  const activeGroup = groups.find(group => group.items.some(item => diffChoiceKey(item) === activeKey));
  if(!activeGroup) return [];
  if(activeGroup.key === 'timeline') return activeGroup.items.slice();
  let recentFirst;
  if(activeGroup.key === 'mainline'){
    const primaryDefault = groups.find(group => group.key === 'default');
    recentFirst = flattenDiffChoices([
      { items:primaryDefault && primaryDefault.items.length ? [primaryDefault.items[0]] : [] },
      activeGroup
    ]);
  } else if(activeGroup.key === 'default' && diffChoiceKey(activeGroup.items[0]) === activeKey){
    const mainline = groups.find(group => group.key === 'mainline');
    recentFirst = flattenDiffChoices([
      { items:[activeGroup.items[0]] },
      { items:mainline ? mainline.items : [] }
    ]);
  } else {
    recentFirst = activeGroup.items.slice();
  }
  return recentFirst.reverse();
}
function logicalSortRank(t, view){
  const info = view.meta.get(t && t.id) || fallbackTraceInfo(t);
  return info.sortRank;
}
function diffHtml(a,b){
  const d = structuralDiff(a, b);
  return renderStructuralDiff(d);
}
function canonicalizeDiffValue(value){
  if(Array.isArray(value)) return value.map(canonicalizeDiffValue);
  if(value && typeof value === 'object'){
    const out = {};
    for(const key of Object.keys(value).sort()) out[key] = canonicalizeDiffValue(value[key]);
    return out;
  }
  return value;
}
function diffValueText(value){
  try { return JSON.stringify(canonicalizeDiffValue(value)); }
  catch { return j(value); }
}
function diffValueEqual(a, b){ return diffValueText(a) === diffValueText(b); }
function structuralDiff(a, b){
  const A = getMessages(a), B = getMessages(b);
  const msgRows = diffMsgRows(A, B);
  // System
  const oldSys = msgsToText(systemValue(a) ? [{ role:'system', content: systemValue(a) }] : []);
  const newSys = msgsToText(systemValue(b) ? [{ role:'system', content: systemValue(b) }] : []);
  const systemChanged = oldSys !== newSys;
  // Tools：原来只比名字集合，同名工具改了 description / schema 会被报成「未变」且区块不可展开。
  const oldT = tools(a), newT = tools(b);
  const oldToolMap = new Map(oldT.map(x => [toolDisplayName(x), x]));
  const newToolMap = new Map(newT.map(x => [toolDisplayName(x), x]));
  const addedTools = [], removedTools = [], changedTools = [];
  oldToolMap.forEach((tool, name) => {
    if(!newToolMap.has(name)) removedTools.push(tool);
    else if(!diffValueEqual(tool, newToolMap.get(name))) changedTools.push({ name, old:tool, next:newToolMap.get(name) });
  });
  newToolMap.forEach((tool, name) => { if(!oldToolMap.has(name)) addedTools.push(tool); });
  const toolsChanged = addedTools.length > 0 || removedTools.length > 0 || changedTools.length > 0 || oldT.length !== newT.length;
  // 与阅读视角的 Tools 计数同口径：按可调用工具数算，namespace 下的子工具要算进去
  const oldToolCount = oldT.reduce((n, tool) => n + callableToolCount(tool), 0);
  const newToolCount = newT.reduce((n, tool) => n + callableToolCount(tool), 0);
  // 顶层 body 字段（消息/system/tools 由各自的区块负责）；只在对比视图显示差异。
  const oldB = bodyOf(a), newB = bodyOf(b);
  const skip = new Set(PARAM_DIFF_SKIP);
  const allKeys = new Set([...Object.keys(oldB), ...Object.keys(newB)]);
  const fieldChanges = [];
  allKeys.forEach(k => {
    if(skip.has(k)) return;
    if(!diffValueEqual(oldB[k], newB[k])) fieldChanges.push({ key:k, oldVal:oldB[k], newVal:newB[k], added: oldB[k] === undefined, removed: newB[k] === undefined });
  });
  return {
    msgRows,
    newMsgCount: msgRows.filter(r => r.type === 'add').length,
    removedMsgCount: msgRows.filter(r => r.type === 'del').length,
    modifiedMsgCount: msgRows.filter(r => r.type === 'change').length,
    systemChanged, oldSystemText: oldSys, newSystemText: newSys, oldSystemLen: oldSys.length, newSystemLen: newSys.length,
    toolsChanged, oldToolCount, newToolCount, addedTools, removedTools, changedTools,
    fieldChanges
  };
}
// 消息也走 LCS：原来是「按 role 贪心 + 只看 1 步」，中间插入一轮工具循环就会把最终回答
// 和一条无关的中间消息配成 changed，后面整体错位——和行 diff 是同一类 bug。
function diffMsgRows(A, B){
  const ops = diffLcsOps(A.map(msgDiffKey), B.map(msgDiffKey));
  if(!ops){
    // 编辑距离超限：整体按删+增呈现，不猜配对
    return A.map(m => ({ type:'del', msg:m })).concat(B.map(m => ({ type:'add', msg:m })));
  }
  const rows = [];
  let i = 0;
  while(i < ops.length){
    if(ops[i].t === '='){
      let n = 0;
      while(i < ops.length && ops[i].t === '='){ n++; i++; }
      rows.push({ type:'same', count:n });
      continue;
    }
    const dels = [], adds = [];
    while(i < ops.length && ops[i].t !== '='){
      if(ops[i].t === '-') dels.push(A[ops[i].ai]); else adds.push(B[ops[i].bi]);
      i++;
    }
    rows.push(...pairMsgHunk(dels, adds));
  }
  return rows;
}
function msgDiffKey(m){ return (m && m.role ? m.role : '') + '\\u0000' + msgsToText([m]); }
// hunk 内配对：只在同 role 之间配。同一 role 在这个 hunk 里一删一增时是唯一解，直接配；
// 有多个候选才用相似度挑，且要够像才算 changed——否则宁可报成一删一增，也不要把两条
// 毫不相干的消息并排逐行 diff（旧实现就会把最终回答和一条插入的中间消息配到一起）。
function pairMsgHunk(dels, adds){
  const takenAdd = new Set(), partner = new Map();
  const roleTotal = (list, role) => list.reduce((n, m) => n + (m && m.role === role ? 1 : 0), 0);
  for(let i = 0; i < dels.length; i++){
    const role = dels[i] ? dels[i].role : undefined;
    const candidates = [];
    for(let k = 0; k < adds.length; k++) if(!takenAdd.has(k) && adds[k] && adds[k].role === role) candidates.push(k);
    if(!candidates.length) continue;
    if(candidates.length === 1 && roleTotal(dels, role) === 1){
      takenAdd.add(candidates[0]);
      partner.set(i, candidates[0]);
      continue;
    }
    let best = -1, bestScore = 0;
    for(const k of candidates){
      const score = diffTextSimilarity(msgsToText([dels[i]]), msgsToText([adds[k]]));
      if(score > bestScore){ bestScore = score; best = k; }
    }
    if(best >= 0 && bestScore >= 0.34){ takenAdd.add(best); partner.set(i, best); }
  }
  const rows = [];
  for(let i = 0; i < dels.length; i++) if(!partner.has(i)) rows.push({ type:'del', msg:dels[i] });
  for(let i = 0; i < dels.length; i++) if(partner.has(i)) rows.push({ type:'change', old:dels[i], next:adds[partner.get(i)] });
  for(let k = 0; k < adds.length; k++) if(!takenAdd.has(k)) rows.push({ type:'add', msg:adds[k] });
  return rows;
}
// trigram Jaccard；长文本只取头部，纯粹用来判「是不是同一条消息的两个版本」。
const DIFF_SIM_SAMPLE = 4000;
function diffTextSimilarity(a, b){
  const x = String(a || '').slice(0, DIFF_SIM_SAMPLE), y = String(b || '').slice(0, DIFF_SIM_SAMPLE);
  if(x === y) return 1;
  if(x.length < 3 || y.length < 3) return x === y ? 1 : 0;
  const grams = new Set();
  for(let i = 0; i <= x.length - 3; i++) grams.add(x.substr(i, 3));
  let hit = 0;
  const seen = new Set();
  for(let i = 0; i <= y.length - 3; i++){
    const g = y.substr(i, 3);
    if(seen.has(g)) continue;
    seen.add(g);
    if(grams.has(g)) hit++;
  }
  const union = grams.size + seen.size - hit;
  return union > 0 ? hit / union : 0;
}
function msgsToText(msgs){
  return msgs.map(m => {
    const c = m.content;
    if(typeof c === 'string') return c;
    if(!Array.isArray(c)) return j(c);
    return c.map(b => {
      if(!b || typeof b !== 'object') return j(b);
      if(b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') return b.text || '';
      if(b.type === 'thinking') return '[thinking]\\n' + (b.thinking || b.text || '');
      if(b.type === 'tool_use' || b.type === 'function_call') return '[tool_use: ' + (b.name || '') + ']\\n' + j(b.input !== undefined ? b.input : (b.arguments !== undefined ? parseJsonMaybe(b.arguments) : ''));
      if(b.type === 'tool_result' || b.type === 'function_call_output'){
        const rc = b.content !== undefined ? b.content : b.output;
        if(typeof rc === 'string') return '[tool_result]\\n' + rc;
        if(Array.isArray(rc)) return '[tool_result]\\n' + rc.map(x => x && x.type === 'text' ? x.text : j(x)).join('\\n');
        return '[tool_result]\\n' + j(b);
      }
      return j(b);
    }).join('\\n');
  }).join('\\n\\n');
}
function toolDisplayName(t){ return (t && (t.name || (t.function && t.function.name))) || 'unknown'; }
function toolDescription(t){ return (t && (t.description || (t.function && t.function.description))) || ''; }
function renderDiffSection(key, headerHtml, bodyHtml){
  if(!bodyHtml){
    return '<div class="diff-section"><div class="diff-section-header static"><span class="diff-section-title">'+headerHtml+'</span></div></div>';
  }
  const isOpen = Object.prototype.hasOwnProperty.call(diffSectionState, key) ? !!diffSectionState[key] : true;
  return '<details class="diff-section" data-diff-section="'+esc(key)+'"'+(isOpen?' open':'')+'>'
    + '<summary class="diff-section-header"><span class="diff-section-tw">▸</span><span class="diff-section-title">'+headerHtml+'</span></summary>'
    + '<div class="diff-section-body">'+bodyHtml+'</div>'
    + '</details>';
}
function renderStructuralDiff(d){
  let toolsHtml = '';
  let systemHtml = '';
  let messagesHtml = '';
  let paramsHtml = '';
  // ── Messages section ──
  const totalNew = d.newMsgCount, totalRm = d.removedMsgCount, totalMod = d.modifiedMsgCount;
  const msgBadges = [];
  if(totalNew) msgBadges.push('<span class="ds-badge add">+'+totalNew+' '+L('新增','added')+'</span>');
  if(totalRm) msgBadges.push('<span class="ds-badge del">-'+totalRm+' '+L('删除','removed')+'</span>');
  if(totalMod) msgBadges.push('<span class="ds-badge change">'+totalMod+' '+L('修改','changed')+'</span>');
  if(!totalNew && !totalRm && !totalMod) msgBadges.push('<span class="ds-badge same">'+L('未变','same')+'</span>');
  // 按对话顺序渲染，未变段就地折叠成一条横条——原来是「先全部删除、再全部修改、再全部新增」，
  // 既丢了顺序，中间匹配上的消息也会被算进那条写着「开头未变」的横条里。
  let messagesBody = '';
  d.msgRows.forEach((row, index) => {
    if(row.type === 'same'){
      const where = index === 0 ? L('条消息开头未变','unchanged at start')
        : index === d.msgRows.length - 1 ? L('条消息结尾未变','unchanged at end')
        : L('条消息未变','unchanged');
      messagesBody += '<div class="diff-unchanged-bar"><span class="dub-dot"></span><strong>'+row.count+'</strong> '+where+'</div>';
    } else if(row.type === 'del'){
      messagesBody += renderDiffMsg(row.msg, 'del', 'removed');
    } else if(row.type === 'add'){
      messagesBody += renderDiffMsg(row.msg, 'add', 'added');
    } else if(row.type === 'change'){
      messagesBody += renderDiffModifiedMsg(row.old, row.next);
    }
  });
  if(!d.msgRows.length) messagesBody += '<div class="diff-empty">'+L('没有消息','No messages')+'</div>';
  messagesHtml = renderDiffSection('messages', L('Messages','Messages')+' '+msgBadges.join(' '), messagesBody);
  // ── Parameters section ──
  if(d.fieldChanges.length > 0){
    paramsHtml = renderDiffSection(
      'params',
      L('请求参数','Request Params')+' <span class="ds-badge change">'+d.fieldChanges.length+' '+L('修改','changed')+'</span>',
      d.fieldChanges.map(renderParamChange).join('')
    );
  }
  // ── System section ──
  if(d.systemChanged){
    const lenDiff = d.newSystemLen - d.oldSystemLen;
    const lenStr = (lenDiff > 0 ? '+' : '') + lenDiff;
    systemHtml = renderDiffSection(
      'system',
      'System <span class="ds-badge change">'+L('已修改','changed')+' ('+num(d.oldSystemLen)+' → '+num(d.newSystemLen)+', '+lenStr+' '+L('字符','chars')+')</span>',
      renderLineDiff(d.oldSystemText, d.newSystemText)
    );
  } else {
    systemHtml = renderDiffSection('system', 'System <span class="ds-badge same">'+num(d.newSystemLen)+' '+L('字符','chars')+' · '+L('未变','same')+'</span>', '');
  }
  // ── Tools section ──
  if(d.toolsChanged){
    let toolsBody = '';
    d.addedTools.forEach(t => { toolsBody += renderDiffToolDetail(t, 'add', 'added'); });
    d.removedTools.forEach(t => { toolsBody += renderDiffToolDetail(t, 'del', 'removed'); });
    // 同名但定义变了的工具：以前这类改动整段报「未变」，连区块都展不开
    d.changedTools.forEach(c => { toolsBody += renderDiffToolChange(c); });
    const counts = d.oldToolCount === d.newToolCount ? String(d.newToolCount) : d.oldToolCount + ' → ' + d.newToolCount;
    const detail = d.changedTools.length ? ' · ' + d.changedTools.length + ' ' + L('个定义已改','redefined') : '';
    toolsHtml = renderDiffSection('tools', 'Tools <span class="ds-badge change">'+counts+detail+'</span>', toolsBody);
  } else {
    toolsHtml = renderDiffSection('tools', 'Tools <span class="ds-badge same">'+d.newToolCount+' '+L('个','tools')+' · '+L('未变','same')+'</span>', '');
  }
  return toolsHtml + systemHtml + messagesHtml + paramsHtml;
}
function renderDiffMsg(m, kind, label){
  const role = m.role || 'unknown';
  return '<div class="diff-msg-card '+kind+'" data-label="'+label+'">'
    + '<div class="diff-msg-head"><span class="pill '+roleClass(role)+'">'+esc(role.toUpperCase())+'</span><span class="ds-badge '+kind+'">'+label+'</span></div>'
    + '<div class="diff-msg-body">'+diffSbsPair(kind, renderBlocks(normalizeBlocks(m.content)))+'</div>'
    + '</div>';
}
// 整条增删统一进 OLD|NEW 左右框：del → 内容在 OLD 侧、NEW 侧空态；add → 反之。
function diffSbsPair(kind, contentHtml){
  const absent = '<div class="diff-sbs-body">'+L('（不存在）','(absent)')+'</div>';
  const filled = '<div class="diff-sbs-body">'+contentHtml+'</div>';
  const oldSide = kind === 'del'
    ? '<div class="diff-sbs-side del"><div class="diff-sbs-h">OLD</div>'+filled+'</div>'
    : '<div class="diff-sbs-side empty"><div class="diff-sbs-h">OLD</div>'+absent+'</div>';
  const newSide = kind === 'add'
    ? '<div class="diff-sbs-side add"><div class="diff-sbs-h">NEW</div>'+filled+'</div>'
    : '<div class="diff-sbs-side empty"><div class="diff-sbs-h">NEW</div>'+absent+'</div>';
  return '<div class="diff-sbs">'+oldSide+newSide+'</div>';
}
function renderDiffModifiedMsg(oldM, newM){
  const role = oldM.role || 'unknown';
  const oldText = msgsToText([oldM]);
  const newText = msgsToText([newM]);
  return '<div class="diff-msg-card change">'
    + '<div class="diff-msg-head"><span class="pill '+roleClass(role)+'">'+esc(role.toUpperCase()+' CHANGED')+'</span><span class="ds-badge change">changed</span></div>'
    + '<div class="diff-msg-body">'+renderLineDiff(oldText, newText)+'</div>'
    + '</div>';
}
function renderParamChange(f){
  const cls = f.added ? 'add' : f.removed ? 'del' : 'change';
  const label = f.added ? 'added' : f.removed ? 'removed' : 'changed';
  // JSON 值优先走结构化 diff：行 diff 在这里天生对不齐（插一个 key 会改上一行的尾逗号，
  // 而且 x-codex-turn-metadata 那种「JSON 字符串套在 JSON 里」整坨挤在一行）。
  const leaves = structuredLeafChanges(f.oldVal, f.newVal);
  const body = leaves ? renderLeafChanges(leaves) : renderLineDiff(formatDiffValue(f.oldVal), formatDiffValue(f.newVal));
  const count = leaves ? ' <span class="ds-badge same">'+leaves.length+' '+L('处','fields')+'</span>' : '';
  return '<details class="diff-param-change" open><summary><span class="diff-param-key">'+esc(f.key)+'</span><span class="ds-badge '+cls+'">'+label+'</span>'+count+'</summary><div class="diff-param-body">'+body+'</div></details>';
}
// 值本身是 JSON 文本时解析出来（Codex 的 x-codex-turn-metadata 就是这种）。
function parseEmbeddedJson(v){
  if(typeof v !== 'string') return undefined;
  const t = v.trim();
  if(t.length < 2) return undefined;
  const head = t.charAt(0), tail = t.charAt(t.length - 1);
  if(!((head === '{' && tail === '}') || (head === '[' && tail === ']'))) return undefined;
  try { const parsed = JSON.parse(t); return (parsed && typeof parsed === 'object') ? parsed : undefined; }
  catch { return undefined; }
}
function isPlainObject(v){ return !!v && typeof v === 'object' && !Array.isArray(v); }
const DIFF_LEAF_LIMIT = 300;   // 极端大对象不要把 DOM 撑爆
const DIFF_LEAF_DEPTH = 8;
// 只有两边都是（或都能解析成）结构化值时才值得按 key 路径比对；否则返回 null 让调用方退回行 diff。
function structuredLeafChanges(oldVal, newVal){
  const o = isPlainObject(oldVal) || Array.isArray(oldVal) ? oldVal : parseEmbeddedJson(oldVal);
  const n = isPlainObject(newVal) || Array.isArray(newVal) ? newVal : parseEmbeddedJson(newVal);
  if(o === undefined || n === undefined) return null;
  if(isPlainObject(o) !== isPlainObject(n)) return null;
  const out = [];
  collectLeafChanges(o, n, '', out, 0);
  return out.length ? out : null;
}
function collectLeafChanges(oldVal, newVal, path, out, depth){
  if(out.length >= DIFF_LEAF_LIMIT) return;
  if(depth < DIFF_LEAF_DEPTH){
    const eo = parseEmbeddedJson(oldVal), en = parseEmbeddedJson(newVal);
    if(eo !== undefined && en !== undefined){ collectLeafChanges(eo, en, path, out, depth + 1); return; }
    if(isPlainObject(oldVal) && isPlainObject(newVal)){
      const keys = [], seen = new Set();
      for(const k of Object.keys(oldVal)){ keys.push(k); seen.add(k); }
      for(const k of Object.keys(newVal)) if(!seen.has(k)) keys.push(k);
      for(const k of keys) collectLeafChanges(oldVal[k], newVal[k], path ? path + '.' + k : k, out, depth + 1);
      return;
    }
    if(Array.isArray(oldVal) && Array.isArray(newVal)){
      // 数组也先 LCS 对齐再下钻，中间插一个元素不该让后面全部错位
      const ops = diffLcsOps(oldVal.map(diffValueText), newVal.map(diffValueText));
      if(ops){
        let i = 0;
        while(i < ops.length){
          if(ops[i].t === '='){ i++; continue; }
          const dels = [], adds = [];
          while(i < ops.length && ops[i].t !== '='){
            if(ops[i].t === '-') dels.push(ops[i].ai); else adds.push(ops[i].bi);
            i++;
          }
          const paired = Math.min(dels.length, adds.length);
          for(let k = 0; k < paired; k++) collectLeafChanges(oldVal[dels[k]], newVal[adds[k]], path + '[' + dels[k] + ']', out, depth + 1);
          for(let k = paired; k < dels.length; k++) collectLeafChanges(oldVal[dels[k]], undefined, path + '[' + dels[k] + ']', out, depth + 1);
          for(let k = paired; k < adds.length; k++) collectLeafChanges(undefined, newVal[adds[k]], path + '[' + adds[k] + ']', out, depth + 1);
        }
        return;
      }
    }
  }
  if(diffValueEqual(oldVal, newVal)) return;
  out.push({ path: path || '(root)', oldVal, newVal, added: oldVal === undefined, removed: newVal === undefined });
}
function leafText(v){
  if(v === undefined) return '';
  if(typeof v === 'string') return v;
  return diffValueText(v);
}
const DIFF_LEAF_INLINE_MAX = 220;   // 超过这个长度或含换行的叶子改回行 diff，否则一行读不了
function renderLeafChanges(leaves){
  const shown = leaves.slice(0, DIFF_LEAF_LIMIT);
  let html = '<div class="diff-kv">'
    + '<div class="diff-kv-h">'+L('字段','FIELD')+'</div><div class="diff-kv-h old">OLD</div><div class="diff-kv-h new">NEW</div>';
  for(const leaf of shown){
    const o = leafText(leaf.oldVal), n = leafText(leaf.newVal);
    const path = '<div class="diff-kv-path">'+esc(leaf.path)+'</div>';
    if(o.length > DIFF_LEAF_INLINE_MAX || n.length > DIFF_LEAF_INLINE_MAX || o.indexOf('\\n') >= 0 || n.indexOf('\\n') >= 0){
      html += '<div class="diff-kv-longpath">'+esc(leaf.path)+'</div><div class="diff-kv-long">'+renderLineDiff(o, n)+'</div>';
      continue;
    }
    if(leaf.added){
      html += path + '<div class="diff-kv-cell empty">'+L('（不存在）','(absent)')+'</div><div class="diff-kv-cell add">'+esc(n)+'</div>';
    } else if(leaf.removed){
      html += path + '<div class="diff-kv-cell del">'+esc(o)+'</div><div class="diff-kv-cell empty">'+L('（不存在）','(absent)')+'</div>';
    } else {
      let cp = 0;
      while(cp < o.length && cp < n.length && o[cp] === n[cp]) cp++;
      let cs = 0;
      while(cs < o.length - cp && cs < n.length - cp && o[o.length-1-cs] === n[n.length-1-cs]) cs++;
      html += path
        + '<div class="diff-kv-cell del">'+charHighlight(o, cp, o.length-cs, 'sbs-hi-del')+'</div>'
        + '<div class="diff-kv-cell add">'+charHighlight(n, cp, n.length-cs, 'sbs-hi-add')+'</div>';
    }
  }
  if(leaves.length > shown.length) html += '<div class="diff-kv-more">'+L('… 还有 ','… ')+(leaves.length - shown.length)+L(' 处变更未显示',' more changes not shown')+'</div>';
  html += '</div>';
  return html;
}
function renderDiffToolDetail(tool, cls, label){
  const name = toolDisplayName(tool);
  const desc = toolDescription(tool);
  const inner = (desc ? '<div class="diff-tool-desc">'+esc(desc)+'</div>' : '')
    + '<pre class="diff-tool-json">'+esc(j(tool))+'</pre>';
  return '<details class="diff-tool-detail"><summary><span class="diff-tool-name">'+esc(name)+'</span><span class="ds-badge '+cls+'">'+label+'</span></summary><div class="diff-tool-body">'
    + diffSbsPair(cls, inner)
    + '</div></details>';
}
// 同名工具的定义变化：按 key 路径比对，直接指出是 description 改了还是 schema 改了。
function renderDiffToolChange(change){
  const leaves = structuredLeafChanges(change.old, change.next);
  const body = leaves ? renderLeafChanges(leaves) : renderLineDiff(formatDiffValue(change.old), formatDiffValue(change.next));
  const count = leaves ? '<span class="ds-badge same">'+leaves.length+' '+L('处','fields')+'</span>' : '';
  return '<details class="diff-tool-detail"><summary><span class="diff-tool-name">'+esc(change.name)+'</span><span class="ds-badge change">changed</span>'+count+'</summary><div class="diff-tool-body">'
    + body
    + '</div></details>';
}
function formatDiffValue(v){
  if(v === undefined) return '';
  if(typeof v === 'string'){
    const trimmed = v.trim();
    if((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))){
      try { return j(canonicalizeDiffValue(JSON.parse(trimmed))); } catch { return v; }
    }
    return v;
  }
  return j(canonicalizeDiffValue(v));
}
// ── Diff 内核 ───────────────────────────────────────────────────────────────
// 这里原来是「削公共前缀 + 削公共后缀 + 中间按位置 zip」。两个后果：
//   1. 中间插入一行，后面所有行整体错位，连内容完全相同的行也会标成改动；
//   2. 整段只产出一个 hunk——3000 行 system prompt 只改两个词会渲染出 2981 行红绿。
// 改成 Myers/LCS 对齐 + 多 hunk + 折叠上下文（与 git -U3 同口径）。
const DIFF_CTX_LINES = 3;    // 每个 hunk 上下保留的未变行数
const DIFF_LCS_MAX_D = 400;  // Myers 编辑距离上限；两边差得太多时 diff 本身已不可读，退回位置对齐
// Myers O(N·D) 差分。返回 [{t:'=',ai,bi}|{t:'-',ai}|{t:'+',bi}]；编辑距离超限返回 null。
// V 按 d 分层存（第 d 层只有 d+1 个可达 k），总内存 O(D²) 个 int，D=400 约 320KB。
function diffLcsOps(a, b){
  const N = a.length, M = b.length;
  if(!N && !M) return [];
  const max = Math.min(N + M, DIFF_LCS_MAX_D);
  const trace = [];
  let prev = null, found = -1;
  for(let d = 0; d <= max; d++){
    const cur = new Int32Array(d + 1);
    for(let k = -d, i = 0; k <= d; k += 2, i++){
      let x;
      if(d === 0) x = 0;
      else {
        // prev 是第 d-1 层：k-1 的下标 (k+d-2)/2，k+1 的下标 (k+d)/2；越界用 -1 兜底
        const left = (k - 1 >= -(d - 1)) ? prev[(k + d - 2) / 2] : -1;
        const right = (k + 1 <= d - 1) ? prev[(k + d) / 2] : -1;
        x = left < right ? right : left + 1;
      }
      let y = x - k;
      while(x < N && y < M && a[x] === b[y]){ x++; y++; }
      cur[i] = x;
      if(x >= N && y >= M){ found = d; break; }
    }
    trace.push(cur);
    prev = cur;
    if(found >= 0) break;
  }
  if(found < 0) return null;
  const ops = [];
  let x = N, y = M;
  for(let d = found; d > 0; d--){
    const layer = trace[d - 1], k = x - y;
    const left = (k - 1 >= -(d - 1)) ? layer[(k + d - 2) / 2] : -1;
    const right = (k + 1 <= d - 1) ? layer[(k + d) / 2] : -1;
    const down = left < right;
    const px = down ? right : left, pk = down ? k + 1 : k - 1, py = px - pk;
    while(x > px && y > py){ x--; y--; ops.push({ t:'=', ai:x, bi:y }); }
    if(down){ y--; ops.push({ t:'+', bi:y }); }
    else { x--; ops.push({ t:'-', ai:x }); }
  }
  while(x > 0){ x--; y--; ops.push({ t:'=', ai:x, bi:y }); }
  return ops.reverse();
}
function lineDiffPairs(oldText, newText){
  const ol = String(oldText === undefined || oldText === null ? '' : oldText).split('\\n');
  const nl = String(newText === undefined || newText === null ? '' : newText).split('\\n');
  // 先削公共前后缀，Myers 只需覆盖真正变化的区域——长 prompt 的编辑距离因此保持很小
  let pre = 0;
  while(pre < ol.length && pre < nl.length && ol[pre] === nl[pre]) pre++;
  let suf = 0;
  while(suf < ol.length - pre && suf < nl.length - pre && ol[ol.length-1-suf] === nl[nl.length-1-suf]) suf++;
  const midOld = ol.slice(pre, ol.length - suf), midNew = nl.slice(pre, nl.length - suf);
  const ops = diffLcsOps(midOld, midNew);
  // 摊平成带真实行号的 op 序列（含被削掉的前后缀），再统一切 hunk
  const flat = [];
  for(let i = 0; i < pre; i++) flat.push({ t:'=', ai:i, bi:i });
  if(ops){
    for(const op of ops){
      if(op.t === '=') flat.push({ t:'=', ai:pre+op.ai, bi:pre+op.bi });
      else if(op.t === '-') flat.push({ t:'-', ai:pre+op.ai });
      else flat.push({ t:'+', bi:pre+op.bi });
    }
  } else {
    // 编辑距离超限：两边几乎没有共同行，整段按增删呈现，只保证不卡死
    for(let i = 0; i < midOld.length; i++) flat.push({ t:'-', ai:pre+i });
    for(let i = 0; i < midNew.length; i++) flat.push({ t:'+', bi:pre+i });
  }
  for(let i = 0; i < suf; i++) flat.push({ t:'=', ai:ol.length-suf+i, bi:nl.length-suf+i });
  return diffHunkRows(flat, ol, nl);
}
// 切 hunk：变化处上下各留 DIFF_CTX_LINES 行，其余未变行折起来。
function diffHunkRows(flat, ol, nl){
  const keep = new Array(flat.length).fill(false);
  for(let i = 0; i < flat.length; i++){
    if(flat[i].t === '=') continue;
    const lo = Math.max(0, i - DIFF_CTX_LINES), hi = Math.min(flat.length - 1, i + DIFF_CTX_LINES);
    for(let k = lo; k <= hi; k++) keep[k] = true;
  }
  const out = [];
  let i = 0;
  while(i < flat.length){
    if(!keep[i]){
      const from = flat[i];
      let n = 0;
      while(i < flat.length && !keep[i]){ n++; i++; }
      out.push({ type:'fold', count:n, oldLine:from.ai + 1, newLine:from.bi + 1 });
      continue;
    }
    if(flat[i].t === '='){
      out.push({ type:'ctx', text:ol[flat[i].ai], oldLine:flat[i].ai + 1, newLine:flat[i].bi + 1 });
      i++;
      continue;
    }
    // 一段连续变化：hunk 内按位置配对——能锚定的行 LCS 已经锚定成 ctx 了
    const dels = [], adds = [];
    while(i < flat.length && flat[i].t !== '='){
      if(flat[i].t === '-') dels.push(flat[i].ai); else adds.push(flat[i].bi);
      i++;
    }
    const paired = Math.min(dels.length, adds.length);
    for(let k = 0; k < paired; k++) out.push({ type:'change', oldText:ol[dels[k]], newText:nl[adds[k]], oldLine:dels[k]+1, newLine:adds[k]+1 });
    for(let k = paired; k < dels.length; k++) out.push({ type:'del', text:ol[dels[k]], oldLine:dels[k]+1 });
    for(let k = paired; k < adds.length; k++) out.push({ type:'add', text:nl[adds[k]], newLine:adds[k]+1 });
  }
  return out;
}
function charHighlight(text, hiStart, hiEnd, hiClass){
  if(hiStart >= hiEnd || hiStart >= text.length) return esc(text);
  return esc(text.substring(0, hiStart))
    + '<span class="'+hiClass+'">'+esc(text.substring(hiStart, hiEnd))+'</span>'
    + esc(text.substring(hiEnd));
}
function renderLineDiff(oldText, newText){
  if(!oldText && !newText) return '<div class="sbs-empty">'+L('空','Empty')+'</div>';
  const lines = lineDiffPairs(oldText, newText);
  const ln = (side, cls, n) => '<div class="sbs-ln '+side+(cls?' '+cls:'')+'">'+(n ? n : '')+'</div>';
  let html = '<div class="sbs-diff">'
    + '<div class="sbs-header old">OLD</div><div class="sbs-header new">NEW</div>';
  for(const row of lines){
    if(row.type === 'fold'){
      html += '<div class="sbs-fold">'+L('… 省略 ','… ')+row.count+L(' 行未变（旧 ',' unchanged lines (old ')+row.oldLine+L(' / 新 ',' / new ')+row.newLine+L('）…',') …')+'</div>';
    } else if(row.type === 'ctx'){
      html += ln('old','',row.oldLine)+'<div class="sbs-cell ctx">'+esc(row.text)+'</div>'
        + ln('new','',row.newLine)+'<div class="sbs-cell ctx">'+esc(row.text)+'</div>';
    } else if(row.type === 'change'){
      const o = row.oldText, n = row.newText;
      let cp = 0;
      while(cp < o.length && cp < n.length && o[cp] === n[cp]) cp++;
      let cs = 0;
      while(cs < o.length - cp && cs < n.length - cp && o[o.length-1-cs] === n[n.length-1-cs]) cs++;
      html += ln('old','del',row.oldLine)+'<div class="sbs-cell del">'+charHighlight(o, cp, o.length-cs, 'sbs-hi-del')+'</div>'
        + ln('new','add',row.newLine)+'<div class="sbs-cell add">'+charHighlight(n, cp, n.length-cs, 'sbs-hi-add')+'</div>';
    } else if(row.type === 'del'){
      html += ln('old','del',row.oldLine)+'<div class="sbs-cell del">'+esc(row.text)+'</div>'
        + ln('new','empty','')+'<div class="sbs-cell empty"></div>';
    } else if(row.type === 'add'){
      html += ln('old','empty','')+'<div class="sbs-cell empty"></div>'
        + ln('new','add',row.newLine)+'<div class="sbs-cell add">'+esc(row.text)+'</div>';
    }
  }
  html += '</div>';
  return html;
}
function openSearch(){ searchReturnFocus = document.activeElement; el('searchOv').classList.add('on'); el('globalSearch').focus(); renderGlobalSearch(); }
function closeSearch(){ el('searchOv').classList.remove('on'); if(searchReturnFocus && typeof searchReturnFocus.focus === 'function') searchReturnFocus.focus(); searchReturnFocus = null; }
function scheduleGlobalSearch(){
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderGlobalSearch, 80);
}
function renderGlobalSearch(){
  const q = el('globalSearch').value.trim().toLowerCase();
  if(!q){ el('searchBody').innerHTML = '<div class="empty">'+L('在当前会话已加载的请求中搜索 prompt / messages / tools / response / headers / upstream。','Search prompt, messages, tools, response, headers, and upstream in the requests loaded for this session.')+'</div>'; return; }
  const hits = [];
  const list = traces();
  for(const t of list){
    const parts = traceSearchParts(t);
    for(const pair of parts){
      const hay = String(pair[1] || ''); const pos = hay.toLowerCase().indexOf(q);
      if(pos >= 0) hits.push({id:t.id, where:traceLabel(t)+' · '+pair[0], snip:hay.slice(Math.max(0,pos-70),pos+q.length+100)});
      if(hits.length >= SEARCH_RESULT_LIMIT) break;
    }
    if(hits.length >= SEARCH_RESULT_LIMIT) break;
  }
  const capped = hits.length >= SEARCH_RESULT_LIMIT ? '<div class="empty">'+L('只显示前 ','Showing first ')+SEARCH_RESULT_LIMIT+L(' 个命中，请继续细化关键词',' matches. Refine the keyword to narrow results')+'</div>' : '';
  el('searchBody').innerHTML = hits.map(h => '<div class="search-result" role="button" tabindex="0" data-id="'+esc(h.id)+'"><div class="where">'+esc(h.where)+'</div><div>'+highlight(h.snip,q)+'</div></div>').join('') + capped || '<div class="empty">'+L('无命中','No matches')+'</div>';
}
function highlight(text,q){ const safe=esc(text); if(!q) return safe; return safe.replace(new RegExp(escReg(q),'ig'), m => '<mark>'+m+'</mark>'); }
function escReg(s){ return s.replace(/[.*+?^\\x24{}()|[\\]\\\\]/g,'\\\\$&'); }
document.addEventListener('click', e => {
  if(e.target.closest('[data-col-resize]')){ e.preventDefault(); e.stopPropagation(); return; }
  if(dashColDidResize){ dashColDidResize = false; e.preventDefault(); e.stopPropagation(); return; }
  if(e.target.closest('#detail')) followLatest = false;
  if(e.target.closest('#langToggle')){ uiLang = uiLang === 'zh' ? 'en' : 'zh'; writeLang(); render(); if(el('pricingOv').classList.contains('on')) openPricing(); if(el('searchOv').classList.contains('on')) renderGlobalSearch(); return; }
  const retrySession = e.target.closest('[data-retry-session]'); if(retrySession){ void loadSessionTraces(retrySession.dataset.retrySession); return; }
  const nav = e.target.closest('[data-nav]'); if(nav){ if(nav.dataset.nav === 'dashboard') navigateToDashboard(); return; }
  const sfilter = e.target.closest('[data-sfilter]'); if(sfilter){
    state.dashSourceFilter = sfilter.dataset.sfilter;
    if(view === 'dashboard') renderDashboard();
    return;
  }
  const mtoggle = e.target.closest('[data-toggle-matrix]'); if(mtoggle){
    tokenMatrixOpen = !tokenMatrixOpen;
    if(view === 'dashboard') renderDashboard();
    return;
  }
  const pricing = e.target.closest('[data-open-pricing]'); if(pricing){ openPricing(); return; }
  const railLoad = e.target.closest('[data-rail-load]'); if(railLoad){ scheduleRailLoad(railLoad.dataset.railLoad); return; }
  const dashAct = e.target.closest('[data-act]'); if(dashAct){
    const sid = dashAct.dataset.sid;
    if(dashAct.dataset.act === 'open'){ gotoSession(sid); return; }
    if(dashAct.dataset.act === 'delete'){ e.stopPropagation(); void deleteSession(sid); return; }
    if(dashAct.dataset.act === 'toggle-rail'){ setRailMode(isCompactRail() ? 'full' : 'mini'); return; }
  }
  const dashRow = e.target.closest('tr[data-sid]'); if(dashRow){ gotoSession(dashRow.dataset.sid); return; }
  const subHead = e.target.closest('[data-toggle-sub]'); if(subHead){ const grp = subHead.closest('.sagroup'); if(grp){ const key = grp.dataset.sagroup; const open = grp.classList.toggle('open'); subHead.setAttribute('aria-expanded', open ? 'true' : 'false'); if(open) delete subagentCollapsed[key]; else subagentCollapsed[key] = true; syncFoldAllLabel(); } return; }
  if(e.target.closest('[data-act="toggle-all-sub"]')){ toggleAllSubagents(); return; }
  const row = e.target.closest('.row'); if(row){ selectedId=row.dataset.id; const list=traces(); followLatest=!!(list.length && list[list.length-1].id===selectedId); replaceSessionRouteContext(); render(); return; }
  const mt = e.target.closest('[data-toggle-metrics]'); if(mt){ metricsOpen = !metricsOpen; writeMetricsOpen(); mt.classList.toggle('open', metricsOpen); mt.setAttribute('aria-expanded', metricsOpen ? 'true' : 'false'); const cw = mt.parentNode.querySelector('.metrics-cw'); const det = mt.parentNode.querySelector('.metrics-detail'); if(det) det.classList.toggle('open', metricsOpen); if(cw){ cw.classList.toggle('open', metricsOpen); cw.setAttribute('aria-hidden', metricsOpen ? 'false' : 'true'); animateCollapse(cw, metricsOpen); } return; }
  const tab = e.target.closest('[data-mode]'); if(tab){ detailMode = tab.dataset.mode; el('appRoot').setAttribute('data-detmode', detailMode); renderDetail(); return; }
  const fmt = e.target.closest('[data-fmt]'); if(fmt){ traceFormat = fmt.dataset.fmt; renderDetail(); return; }
  const diffOpt = e.target.closest('.diff-opt'); if(diffOpt){ diffSelOpen = false; selectDiffChoice(diffChoiceFromNode(diffOpt)); return; }
  const diffSelBtn = e.target.closest('#diffSelBtn'); if(diffSelBtn){ diffSelOpen = !diffSelOpen; renderDiff(); return; }
  const diffNav = e.target.closest('.diff-nav'); if(diffNav){ if(!diffNav.disabled) stepDiffBase(diffNav.id === 'diffPrev' ? -1 : 1); return; }
  const blockFmt = e.target.closest('[data-bfmt]'); if(blockFmt){ const card = blockFmt.closest('.content-block'); if(card){ const next = blockFmt.dataset.bfmt; card.dataset.bfmt = next; card.querySelectorAll('[data-bfmt]').forEach(b => b.classList.toggle('active', b.dataset.bfmt === next)); card.querySelectorAll('[data-bfmt-pane]').forEach(p => p.style.display = (p.dataset.bfmtPane === next ? '' : 'none')); } return; }
  const sysFmt = e.target.closest('[data-sysfmt]'); if(sysFmt){ const wrap = sysFmt.closest('.sys-wrap'); if(wrap){ const next = sysFmt.dataset.sysfmt; wrap.dataset.sysfmt = next; wrap.querySelectorAll('[data-sysfmt]').forEach(b => b.classList.toggle('active', b.dataset.sysfmt === next)); wrap.querySelectorAll('[data-sysfmt-pane]').forEach(p => p.style.display = (p.dataset.sysfmtPane === next ? '' : 'none')); } return; }
  const secHead = e.target.closest('.sec-h'); if(secHead){ const sec=secHead.closest('.sec'); const key=sec.dataset.sec; const closed = sec.classList.toggle('closed'); secHead.setAttribute('aria-expanded', closed ? 'false' : 'true'); const cw = sec.querySelector(':scope > .cw'); cw.setAttribute('aria-hidden', closed ? 'true' : 'false'); animateCollapse(cw, !closed); sectionState[key]=!closed; writeSectionState(); return; }
  const toolHead = e.target.closest('.tool-head'); if(toolHead){ const tb=toolHead.closest('.tool-block'); const open=tb.classList.toggle('open'); toolHead.setAttribute('aria-expanded', open ? 'true' : 'false'); const cw=tb.querySelector(':scope > .cw'); cw.setAttribute('aria-hidden', open ? 'false' : 'true'); animateCollapse(cw, open); return; }
  const copy = e.target.closest('[data-copy]'); if(copy){ const t=currentTrace(); const kind=copy.dataset.copy; if(kind==='json') copyText(j(t.request && t.request.body || {})); else if(kind==='trace') copyText(j(t)); else if(kind==='curl') copyText(traceToCurl(t)); else if(kind==='prompt') copyText(promptSnapshot(t)); else if(kind==='markdown') downloadText('xwx-trace-'+stableTraceOrdinal(t,'trace')+'.md', markdownTrace(t)); return; }
  if(e.target.closest('#searchOpen')){ openSearch(); return; }
});
document.addEventListener('toggle', e => {
  const logFold = e.target && e.target.closest ? e.target.closest('details[data-log-fold-path]') : null;
  if(logFold){
    const trace = currentTrace();
    if(trace){
      rememberDetailUiState(trace.id,{
        logFolds:{
          [String(logFold.dataset.logFormat || 'json')+'|'+String(logFold.dataset.logFoldPath || '$')]:!!logFold.open
        }
      });
    }
    if(logFold.open && logFold.classList.contains('log-field-fold')) hydrateDeferredLogFold(logFold);
  }
  const section = e.target && e.target.closest ? e.target.closest('details[data-diff-section]') : null;
  if(section) diffSectionState[section.dataset.diffSection] = !!section.open;
}, true);
document.addEventListener('keydown', e => {
  if(el('confirmDeleteOv') && el('confirmDeleteOv').classList.contains('on')) return;
  if(e.target && e.target.closest && e.target.closest('#detail')) followLatest = false;
  const dashRow = e.target && e.target.closest ? e.target.closest('tr[data-sid]') : null;
  const dashControl = e.target && e.target.closest ? e.target.closest('button,a,input,select,textarea') : null;
  if(dashControl && dashControl.matches('[data-act="delete"]') && (e.key === 'Enter' || e.key === ' ')){
    e.preventDefault();
    dashControl.click();
    return;
  }
  if(dashRow && !dashControl && (e.key === 'Enter' || e.key === ' ')){
    e.preventDefault();
    gotoSession(dashRow.dataset.sid);
    return;
  }
  const railRow = e.target && e.target.closest ? e.target.closest('.row[data-id]') : null;
  if(railRow && (e.key === 'Enter' || e.key === ' ')){
    e.preventDefault();
    selectedId = railRow.dataset.id;
    const list = traces();
    followLatest = !!(list.length && list[list.length-1].id === selectedId);
    replaceSessionRouteContext();
    render();
    return;
  }
  const subHead = e.target && e.target.closest ? e.target.closest('[data-toggle-sub]') : null;
  if(subHead && (e.key === 'Enter' || e.key === ' ')){
    e.preventDefault();
    subHead.click();
    return;
  }
  const expandable = e.target && e.target.closest ? e.target.closest('[data-toggle-metrics], [data-toggle-matrix], .sec-h, .tool-head') : null;
  if(expandable && (e.key === 'Enter' || e.key === ' ')){
    e.preventDefault();
    expandable.click();
    return;
  }
  const searchResult = e.target && e.target.closest ? e.target.closest('.search-result[data-id]') : null;
  if(searchResult && (e.key === 'Enter' || e.key === ' ')){
    e.preventDefault();
    selectedId = searchResult.dataset.id;
    followLatest = false;
    replaceSessionRouteContext();
    closeSearch();
    render();
  }
});
el('searchClose').addEventListener('click', closeSearch);
el('pricingClose').addEventListener('click', closePricing);
el('confirmDeleteCancel').addEventListener('click', function(){ closeConfirmDelete(false); });
el('confirmDeleteOk').addEventListener('click', function(){ closeConfirmDelete(true); });
el('confirmDeleteOv').addEventListener('click', function(e){ if(e.target === e.currentTarget) closeConfirmDelete(false); });
// 对照回合下拉：点击选项/触发按钮由主 click 委托处理；点空白处关闭自绘弹层。
document.addEventListener('click', e => { if(diffSelOpen && !(e.target.closest && e.target.closest('.diff-sel-wrap'))){ diffSelOpen = false; renderDiff(); } });
// 点击遮罩空白区域（modal 之外）也关闭弹窗
['searchOv','pricingOv'].forEach(id => el(id).addEventListener('click', e => { if(e.target !== e.currentTarget) return; if(id === 'searchOv') closeSearch(); else closePricing(); }));
el('globalSearch').addEventListener('input', scheduleGlobalSearch);
el('searchBody').addEventListener('click', e => { const r=e.target.closest('.search-result'); if(r){ selectedId=r.dataset.id; followLatest=false; replaceSessionRouteContext(); closeSearch(); render(); } });
document.addEventListener('keydown', e => {
  const confirmDeleteOpen = el('confirmDeleteOv') && el('confirmDeleteOv').classList.contains('on');
  if(confirmDeleteOpen){
    if(e.key === 'Escape'){ e.preventDefault(); closeConfirmDelete(false); }
    else if(e.key === 'Tab') trapModalTab('confirmDeleteOv', e);
    return;
  }
  const searchOpen = el('searchOv').classList.contains('on');
  const pricingOpen = el('pricingOv').classList.contains('on');
  if(searchOpen || pricingOpen){
    if(e.key === 'Escape'){
      e.preventDefault();
      if(searchOpen) closeSearch(); else closePricing();
    } else if(e.key === 'Tab') {
      trapModalTab(searchOpen ? 'searchOv' : 'pricingOv', e);
    }
    return;
  }
  // 对照回合下拉展开时接管方向键/回车/Esc（自绘 listbox 的键盘可达性）。
  if(diffSelOpen && view==='session' && detailMode==='compare'){
    const pop = el('diffPop');
    if(pop){
      const opts = Array.prototype.slice.call(pop.querySelectorAll('.diff-opt'));
      if(e.key==='ArrowDown' || e.key==='ArrowUp'){
        e.preventDefault();
        let i = opts.findIndex(o => o.classList.contains('hl'));
        if(i < 0) i = opts.findIndex(o => o.classList.contains('selected'));
        i = Math.min(opts.length-1, Math.max(0, (i<0?0:i) + (e.key==='ArrowDown'?1:-1)));
        opts.forEach(o => o.classList.remove('hl'));
        if(opts[i]){ opts[i].classList.add('hl'); opts[i].scrollIntoView({block:'nearest'}); }
        return;
      }
      if(e.key==='Enter'){ e.preventDefault(); const hl = pop.querySelector('.diff-opt.hl') || pop.querySelector('.diff-opt.selected'); if(hl){ diffSelOpen=false; selectDiffChoice(diffChoiceFromNode(hl)); } return; }
      if(e.key==='Escape'){ e.preventDefault(); diffSelOpen=false; renderDiff(); return; }
    }
  }
  if((e.key==='ArrowLeft'||e.key==='ArrowRight') && view==='session' && detailMode==='compare'){ e.preventDefault(); stepDiffBase(e.key==='ArrowLeft'?-1:1); return; } if(e.key==='Escape'){ if(view === 'session'){ gotoDashboard(); return; } } if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){ e.preventDefault(); openSearch(); } });
// 窗口尺寸/侧栏宽度变化时，分段控件 thumb 重新对齐 active 按钮（thumb 用绝对像素定位）。
window.addEventListener('resize', () => positionSegThumbsInstant());
// 侧栏列表滚动到底部时追加下一批行（分批渲染）。
el('traceList').addEventListener('scroll', maybeLoadMoreRows, { passive: true });
el('traceList').addEventListener('wheel', maybeLoadMoreRowsFromWheel, { passive: false });
el('detail').addEventListener('scroll', () => { if(view === 'session') followLatest = false; }, { passive: true });
// 侧栏拖拽调宽：full 态可在 RAIL_MIN..RAIL_MAX 之间拖动；拖到 RAIL_MIN 以下落数字栏，不直接隐藏。
// 用迟滞双阈值避免在临界点反复抖动 / 突然被吸走：
//  - full 态向窄拖，宽度需小于 COLLAPSE_AT 才收成数字栏（先压到 RAIL_MIN 再继续拖一段才触发，形成门槛感）。
//  - 数字栏向宽拖，宽度需大于 EXPAND_AT 才展开回 full。
// ⚠️ railWidth 的初值必须与 .app 的 --rail-live-w 初始值一致（同一个数字写在 CSS 和 JS 两处），
// 否则首屏 DOM 宽度与 JS 认为的宽度不符，拖拽第一下会跳。core-smoke 有断言钉住两者相等。
// 316px 是实测值：292px 时折叠态标题会被截断（最长的 Agent 名需要 168px 却只拿到 147px），
// 304px 起不再截断，316 在阈值上留一点余量。
var RAIL_MIN = 232, RAIL_MAX = 460, railWidth = 316;
var RAIL_COLLAPSE_AT = 196, RAIL_EXPAND_AT = 252;
function clampRailWidth(v){ return Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(v))); }
function applyRailWidth(v){
  railWidth = clampRailWidth(v);
  el('appRoot').style.setProperty('--rail-live-w', railWidth + 'px');
  const rz = el('railResizer');
  if(rz){
    rz.setAttribute('aria-valuemin', '56');
    rz.setAttribute('aria-valuemax', String(RAIL_MAX));
    rz.setAttribute('aria-valuenow', String(isCompactRail() ? (railMode() === 'summary' ? 72 : railMode() === 'mini' ? 56 : railMode() === 'ticks' ? 42 : 34) : railWidth));
  }
  positionSegThumbsInstant();
}
// 跨模式切换（full↔数字栏）时短暂恢复宽度过渡，让收起/展开是平滑动画而非瞬间跳变。
function railSnapAnim(){
  var root = el('appRoot');
  root.classList.add('rail-snap');
  clearTimeout(railSnapAnim._t);
  railSnapAnim._t = setTimeout(function(){ root.classList.remove('rail-snap'); }, 220);
}
function setRailFromDrag(v){
  if(isCompactRail()){
    // 当前是数字栏：拖宽要越过 EXPAND_AT 才展开。
    if(v < RAIL_EXPAND_AT) return;
    railSnapAnim();
    setRailMode('full');
    applyRailWidth(v);
    return;
  }
  // 当前是 full：拖窄越过 COLLAPSE_AT 才收成数字栏。
  if(v < RAIL_COLLAPSE_AT){
    railSnapAnim();
    setRailMode('mini');
    applyRailWidth(RAIL_MIN);
    return;
  }
  applyRailWidth(v);
}
(function bindRailResizer(){
  var rz = el('railResizer'); if(!rz) return;
  rz.addEventListener('pointerdown', function(ev){
    var root = el('appRoot');
    var startX = ev.clientX;
    var startW = isCompactRail() ? RAIL_MIN : el('rail').getBoundingClientRect().width;
    root.classList.add('is-resizing');
    try { rz.setPointerCapture(ev.pointerId); } catch(_e){}
    function move(m){ setRailFromDrag(startW + m.clientX - startX); }
    function up(u){ root.classList.remove('is-resizing'); try { rz.releasePointerCapture(u.pointerId); } catch(_e){} document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    ev.preventDefault();
  });
  rz.addEventListener('keydown', function(ev){
    if(ev.key === 'ArrowLeft'){ ev.preventDefault(); if(isCompactRail() || railWidth <= RAIL_MIN){ railSnapAnim(); setRailMode('mini'); applyRailWidth(RAIL_MIN); } else setRailFromDrag(railWidth - 16); }
    if(ev.key === 'ArrowRight'){ ev.preventDefault(); if(isCompactRail()){ railSnapAnim(); setRailMode('full'); applyRailWidth(RAIL_MIN + 16); } else setRailFromDrag(railWidth + 16); }
  });
})();

function applyState(next){
  if(!next || typeof next !== 'object') return;
  // 保留已懒加载的 sessionTraces：/api/state 现在不含 trace（首屏轻量化），
  // 直接覆盖会清空切 session 时 fetch 进来的缓存，导致 refreshState 后详情清空。
  const keepTraces = state.sessionTraces;
  const keepDashSourceFilter = state.dashSourceFilter;
  const keepTraceMeta = sessionTraceMeta;
  state = next;
  if(keepDashSourceFilter) state.dashSourceFilter = keepDashSourceFilter;
  if(keepTraces && Object.keys(keepTraces).length){
    state.sessionTraces = Object.assign({}, state.sessionTraces || {}, keepTraces);
  }
  sessionTraceMeta = keepTraceMeta || {};
  if(!state.sessions.find(s => s.id === selectedSessionId)){
    selectedSessionId = state.currentSessionId || (state.sessions[0] && state.sessions[0].id) || '';
    selectedId = traces().length ? traces()[traces().length - 1].id : undefined;
  }
}
function liveTraceBucketSessionId(trace){
  const physicalSessionId = trace && trace.sessionId;
  if(!physicalSessionId || view !== 'session' || !selectedSessionId || selectedSessionId === physicalSessionId){
    return physicalSessionId;
  }
  const selectedSession = (state.sessions || []).find(s => s.id === selectedSessionId);
  if(!selectedSession || !selectedSession.clientConversationKey || !trace.clientConversationKey){
    return physicalSessionId;
  }
  return selectedSession.clientConversationKey === trace.clientConversationKey
    && sessionSource(selectedSession) === trace.source
    ? selectedSessionId
    : physicalSessionId;
}
function mergeTrace(trace, bucketSessionId){
  if(!trace || !trace.sessionId) return;
  const logicalBucketSessionId = bucketSessionId || trace.sessionId;
  state.sessionTraces = state.sessionTraces || {};
  let bucket = state.sessionTraces[logicalBucketSessionId];
  if(!bucket){ bucket = []; state.sessionTraces[logicalBucketSessionId] = bucket; }
  const at = bucket.findIndex(t => t.id === trace.id);
  const isNew = at < 0;
  const meta = sessionTraceMeta[logicalBucketSessionId];
  // 实时完成事件来自物理 Session，不带展示层 logicalTurn。详情 API 已给当前
  // Conversation 建立了全局总数时，新请求顺延该总数；已有行沿用其稳定逻辑序号。
  if(!trace.logicalTurn){
    const previousLogicalTurn = at >= 0 ? bucket[at] && bucket[at].logicalTurn : undefined;
    if(previousLogicalTurn) trace.logicalTurn = previousLogicalTurn;
    else if(isNew && meta && typeof meta.total === 'number') trace.logicalTurn = meta.total + 1;
  }
  if(at >= 0) bucket[at] = trace; else bucket.push(trace);
  bucket.sort(compareTraceDisplayOrder);
  if(meta){
    const observed = Math.max(
      meta.total || 0,
      meta.offset + bucket.length,
      typeof trace.logicalTurn === 'number' ? trace.logicalTurn : 0,
      typeof trace.turn === 'number' ? trace.turn : 0
    );
    meta.total = observed;
    meta.hasMoreAfter = meta.offset + bucket.length < observed;
  }
  // upsert session summary（含聚合字段：dashboard 拿这个 render）
  state.sessions = state.sessions || [];
  let session = state.sessions.find(s => s.id === trace.sessionId);
  const tok = totalTokens(trace);
  const isErr = traceIsError(trace);
  // 子 agent / 任意辅助回合都不贡献 firstPrompt/firstModel/firstClient，
  // 但仍计入真实请求、Token 与费用。这里必须与 TraceStore 的完整
  // auxiliary union 保持一致；只枚举旧的 title/count/policy 会让实时
  // memory/utility/patch 短暂污染 dashboard，直到下一次 /api/state 刷新。
  const isTitleAux = trace.auxiliary === 'title';
  const isAuxTrace = !!trace.auxiliary;
  const isAux = isAuxTrace || !!trace.subagent;
  const isOrphanSubagentTrace = !!trace.subagent && !isAuxTrace;
  const genTitle = isTitleAux ? generatedTitleOf(trace) : '';
  const physicalBucketCount = bucket.reduce((count, item) =>
    count + (item && item.sessionId === trace.sessionId ? 1 : 0), 0);
  const observedCount = Math.max(physicalBucketCount, typeof trace.turn === 'number' ? trace.turn : 0);
  if(!session){
    const startMs = Date.parse(trace.startedAt || '');
    session = {
      id: trace.sessionId,
      startedAt: trace.startedAt,
      updatedAt: trace.completedAt,
      lastRequestAt: trace.startedAt,
      traceCount: observedCount,
      jsonlPath: '',
      hidden: (isAuxTrace || isOrphanSubagentTrace) ? true : undefined,
      auxiliary: isAuxTrace ? trace.auxiliary : (isOrphanSubagentTrace ? 'subagent' : undefined),
      title: genTitle || undefined,
      firstPrompt: isAux ? undefined : (firstUserPrompt(trace) || undefined),
      totalTokens: tok,
      errorCount: isErr ? 1 : 0,
      lastTurnError: isAux ? undefined : isErr,
      durationMs: Number.isFinite(startMs) ? 0 : undefined,
      firstModel: isAux ? undefined : ((trace.request && trace.request.model) || undefined),
      source: trace.source,
      firstClient: isAux ? undefined : trace.client,
      clientConversationKey: trace.clientConversationKey,
      usageByModel: accumUsageByModel(undefined, trace),
      auxiliaryCounts: trace.auxiliary
        ? { [trace.auxiliary]: 1 }
        : (trace.subagent ? { subagent: 1 } : undefined)
    };
    state.sessions.unshift(session);
  } else {
    const previousStartMs = Date.parse(session.startedAt || '');
    const traceStartMs = Date.parse(trace.startedAt || '');
    const explicitLastRequestMs = Date.parse(session.lastRequestAt || '');
    const previousLastRequestMs = Number.isFinite(explicitLastRequestMs)
      ? explicitLastRequestMs
      : Number.isFinite(previousStartMs) && typeof session.durationMs === 'number' && Number.isFinite(session.durationMs)
        ? previousStartMs + Math.max(0, session.durationMs)
        : previousStartMs;
    const previousUpdatedMs = Date.parse(session.updatedAt || '');
    const traceCompletedMs = Date.parse(trace.completedAt || '');
    const startMs = Number.isFinite(previousStartMs) && Number.isFinite(traceStartMs)
      ? Math.min(previousStartMs, traceStartMs)
      : Number.isFinite(previousStartMs) ? previousStartMs : traceStartMs;
    const lastRequestMs = Number.isFinite(previousLastRequestMs) && Number.isFinite(traceStartMs)
      ? Math.max(previousLastRequestMs, traceStartMs)
      : Number.isFinite(previousLastRequestMs) ? previousLastRequestMs : traceStartMs;
    const updatedMs = Number.isFinite(previousUpdatedMs) && Number.isFinite(traceCompletedMs)
      ? Math.max(previousUpdatedMs, traceCompletedMs)
      : Number.isFinite(traceCompletedMs) ? traceCompletedMs : previousUpdatedMs;
    if(Number.isFinite(startMs)) session.startedAt = new Date(startMs).toISOString();
    if(Number.isFinite(lastRequestMs)) session.lastRequestAt = new Date(lastRequestMs).toISOString();
    if(Number.isFinite(updatedMs)) session.updatedAt = new Date(updatedMs).toISOString();
    session.traceCount = Math.max(session.traceCount || 0, observedCount);
    // Recompute the request span; completion time and LIVE touches are separate.
    if(Number.isFinite(startMs) && Number.isFinite(lastRequestMs)){
      session.durationMs = Math.max(0, lastRequestMs - startMs);
    }
    if(!isAux){ session.hidden = undefined; session.auxiliary = undefined; }
    if(isNew){
      session.totalTokens = (session.totalTokens || 0) + tok;
      if(isErr) session.errorCount = (session.errorCount || 0) + 1;
      session.usageByModel = accumUsageByModel(session.usageByModel, trace);
      if(trace.auxiliary || trace.subagent){
        const kind = trace.auxiliary || 'subagent';
        session.auxiliaryCounts = Object.assign({}, session.auxiliaryCounts || {}, {
          [kind]: ((session.auxiliaryCounts && session.auxiliaryCounts[kind]) || 0) + 1
        });
      }
    }
    // 主回合每次都覆盖 lastTurnError：恢复成功 -> false，再次失败 -> true。aux/subagent 不动它。
    if(!isAux) session.lastTurnError = isErr;
    if(!isAux && !session.firstModel && trace.request && trace.request.model) session.firstModel = trace.request.model;
    if(!session.source && trace.source) session.source = trace.source;
    if(!isAux && !session.firstClient && trace.client) session.firstClient = trace.client;
    if(!session.clientConversationKey && trace.clientConversationKey) session.clientConversationKey = trace.clientConversationKey;
    if(!isAux && !session.firstPrompt){
      const fp = firstUserPrompt(trace);
      if(fp) session.firstPrompt = fp;
    }
    if(genTitle && !session.title) session.title = genTitle;
  }
  state.currentSessionId = trace.sessionId;
  return logicalBucketSessionId;
}
function mergeLiveTrace(trace, wasAtNewest){
  const mergedSessionId = mergeTrace(trace, liveTraceBucketSessionId(trace));
  if(view === 'session' && wasAtNewest && followLatest && selectedSessionId === mergedSessionId){
    selectedId = trace.id;
    replaceSessionRouteContext();
  }
  return mergedSessionId;
}
// 镜像后端 traceStore.accumulateUsageByModel：按模型累进 session.usageByModel。
function accumUsageBands(prev, model, servedModel, trace, usage){
  const price = findModelPriceForUsage(model, servedModel);
  const banded = price && (
    (price.tiers && price.tiers.length)
    || (price.peak && price.peak.peakWindowsUtc && price.peak.peakWindowsUtc.length)
  );
  if(!banded) return prev;
  const promptTokens = usage.inputTotalTokens !== undefined
    ? usage.inputTotalTokens
    : (usage.inputUncachedTokens !== undefined ? usage.inputUncachedTokens : (usage.inputTokens || 0))
      + (usage.cacheReadTokens || 0)
      + (usage.cacheCreationTokens || 0);
  let tier = 0;
  for(let i=0;i<(price.tiers || []).length;i++){
    if(promptTokens >= price.tiers[i].fromInputTokens) tier = i;
  }
  const startedAtMs = Date.parse(trace.startedAt || '');
  const hour = Number.isFinite(startedAtMs) ? new Date(startedAtMs).getUTCHours() : 0;
  const offPeak = !!(price.peak && price.peak.peakWindowsUtc && Number.isFinite(startedAtMs)
    && !price.peak.peakWindowsUtc.some(function(window){ return hour >= window[0] && hour < window[1]; }));
  const shortRule = price.tiers && price.tiers[tier] && price.tiers[tier].shortOutput;
  const shortOutput = !!shortRule && (usage.outputTokens || 0) <= shortRule.atMostTokens;
  return mergeUsageBands(prev,[{
    tier,
    offPeak,
    ...(shortOutput ? { shortOutput:true } : {}),
    input: usage.inputUncachedTokens || 0,
    output: usage.outputTokens || 0,
    cacheRead: usage.cacheReadTokens || 0,
    cacheCreation: usage.cacheCreationTokens || 0,
    ...(usage.cacheCreation5mTokens !== undefined ? { cacheCreation5m:usage.cacheCreation5mTokens || 0 } : {}),
    ...(usage.cacheCreation1hTokens !== undefined ? { cacheCreation1h:usage.cacheCreation1hTokens || 0 } : {})
  }]);
}
function accumUsageByModel(prev, trace){
  const u = usageOf(trace);
  if(!u) return prev;
  const snap = (trace.sse && trace.sse.snapshot) || (trace.response && trace.response.snapshot);
  const model = (trace.request && trace.request.model) || (snap && snap.model);
  if(!model) return prev;
  const servedModel = snap && snap.model && snap.model !== model ? snap.model : undefined;
  const next = Object.assign({}, prev);
  const before = next[model];
  const bands = accumUsageBands(before && before.bands, model, servedModel, trace, u);
  next[model] = {
    version: 2,
    input: ((before && before.input) || 0) + (u.inputUncachedTokens || 0),
    output: ((before && before.output) || 0) + (u.outputTokens || 0),
    cacheRead: ((before && before.cacheRead) || 0) + (u.cacheReadTokens || 0),
    cacheCreation: ((before && before.cacheCreation) || 0) + (u.cacheCreationTokens || 0),
    ...((before && before.cacheCreation5m !== undefined) || u.cacheCreation5mTokens !== undefined
      ? { cacheCreation5m: ((before && before.cacheCreation5m) || 0) + (u.cacheCreation5mTokens || 0) }
      : {}),
    ...((before && before.cacheCreation1h !== undefined) || u.cacheCreation1hTokens !== undefined
      ? { cacheCreation1h: ((before && before.cacheCreation1h) || 0) + (u.cacheCreation1hTokens || 0) }
      : {}),
    total: ((before && before.total) || 0) + totalTokens(trace),
    apiType: (before && before.apiType) || (trace.request && trace.request.apiType),
    incompleteFields: Array.from(new Set([...(before && before.incompleteFields || []),...(u.incompleteFields || [])])),
    ...(bands && bands.length ? { bands } : {}),
    ...((before && before.servedModel) || servedModel ? { servedModel:(before && before.servedModel) || servedModel } : {})
  };
  return next;
}
// 镜像后端 extractGeneratedTitle：从 title 生成请求的响应 snapshot 抽 {"title":"..."} 或纯文本。
function generatedTitleOf(trace){
  const snap = (trace.sse && trace.sse.snapshot) || (trace.response && trace.response.snapshot);
  const blocks = snap && snap.content;
  if(!Array.isArray(blocks)) return '';
  let text = '';
  for(const b of blocks){ if(b && b.type === 'text' && typeof b.text === 'string') text += b.text; }
  text = text.trim();
  if(!text) return '';
  try {
    const parsed = JSON.parse(text);
    if(parsed && typeof parsed === 'object'){
      return (typeof parsed.title === 'string' && parsed.title.trim()) ? parsed.title.trim().slice(0, 120) : '';
    }
  } catch {}
  return text.slice(0, 120);
}
async function refreshState(){
  try {
    const res = await fetch('api/state', { cache:'no-store' });
    if(!res.ok) return false;
    applyState(await res.json());
    render();
    return true;
  } catch { return false; }
}
function setLive(on){ if(liveConnected === on) return; liveConnected = on; renderConnectionStatus(); }
function connectEvents(){
  if(typeof EventSource === 'undefined') return;
  let backoff = 1000;
  let isReconnect = false;
  let activeSrc = null;
  const open = () => {
    const src = new EventSource('events');
    activeSrc = src;
    src.onopen = () => {
      if(activeSrc !== src) return;
      setLive(true);
      backoff = 1000;
      if(isReconnect){ void refreshState(); isReconnect = false; }
    };
    src.onerror = () => {
      if(activeSrc !== src) return;
      setLive(false);
      try { src.close(); } catch {}
      activeSrc = null;
      isReconnect = true;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    src.addEventListener('trace', ev => {
      if(activeSrc !== src) return;
      let trace; try { trace = JSON.parse(ev.data); } catch { return; }
      if(view === 'dashboard'){
        // Dashboard 视图：合并新 trace 只刷新表格，不切换到该会话。
        mergeLiveTrace(trace, false);
        render();
        return;
      }
      // Session 视图：仅当当前会话是该 trace 所属时跟随最新回合。
      const wasAtNewest = (function(){ const list = traces(); return !selectedId || (list.length && list[list.length-1].id === selectedId); })();
      const mergedSessionId = mergeLiveTrace(trace, wasAtNewest);
      const keepLatestVisible = wasAtNewest && followLatest && selectedSessionId === mergedSessionId;
      render();
      // 跟随最新不仅要更新详情和 N/N，也要让侧栏最新卡片保持可见。
      // 用户主动选择历史请求或操作详情后 followLatest=false，不会被这里抢走位置。
      if(keepLatestVisible) revealRailSelection(true);
    });
    src.addEventListener('reset', () => { if(activeSrc === src) void refreshState(); });
    // touch = tapProxy 在请求开始时预识别到目标 session。只更新瞬时 LIVE 时间，
    // 不能改 updatedAt/lastRequestAt，否则历史 session 的耗时会变成“首条请求到现在”。
    src.addEventListener('touch', ev => {
      if(activeSrc !== src) return;
      let payload; try { payload = JSON.parse(ev.data); } catch { return; }
      if(!payload || typeof payload.sessionId !== 'string') return;
      const sess = (state.sessions || []).find(s => s.id === payload.sessionId);
      if(!sess) return;
      sess.liveAt = (typeof payload.ts === 'string' && payload.ts) || new Date().toISOString();
      if(view === 'dashboard') render();
    });
  };
  open();
}

function bootstrapTraceRoute(){
  const sid = routeSessionId();
  const current = history.state || {};
  const existingContext = current[ROUTE_STATE_KEY] === 'session'
    ? current.returnContext
    : current.context;
  if(sid){
    const context = existingContext || captureDashboardContext();
    dashboardReturnContext = context;
    history.replaceState({ [ROUTE_STATE_KEY]: 'dashboard', context }, '', routeHref());
    history.pushState(
      { [ROUTE_STATE_KEY]: 'session', sessionId: sid, returnContext: context },
      '',
      routeHref(sid)
    );
    gotoSession(sid, {
      history: 'none',
      context,
      render: false
    });
    return;
  }
  dashboardReturnContext = existingContext || null;
  history.replaceState(
    { [ROUTE_STATE_KEY]: 'dashboard', context: dashboardReturnContext },
    '',
    routeHref()
  );
}
window.addEventListener('popstate', handleTracePopState);
bootstrapTraceRoute();

if(LIVE_MODE){
  setLive(false);
  refreshState().finally(connectEvents);
} else {
  render();
}
</script>
</body>
</html>`;
}
