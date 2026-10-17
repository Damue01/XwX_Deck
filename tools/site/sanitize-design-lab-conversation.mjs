// Explicit, local-only extraction. Never called by the public website build.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
  return pairs;
}, []));
for (const key of ['trace', 'index', 'conversation', 'output']) assert.ok(args[key], `Missing --${key}`);
const output = resolve(args.output);
assert.ok(output.includes('/test-results/'), 'Sanitized conversation must stay in ignored local test-results');
const index = JSON.parse(await readFile(args.index, 'utf8'));
const selected = index.sessions.find(s => s.clientConversationKey === `codex-cli:${args.conversation}`);
assert.ok(selected, 'Requested conversation not found');
const lines = (await readFile(args.trace, 'utf8')).trim().split('\n');
const originals = lines.map(line => JSON.parse(line));
assert.ok(originals.length && originals.every(t => t.sessionId === selected.id && t.clientConversationKey === selected.clientConversationKey), 'Input must contain only the authorized conversation');

const aliases = new Map();
const alias = value => {
  if (!aliases.has(value)) aliases.set(value, `redacted-id-${aliases.size + 1}`);
  return aliases.get(value);
};
const personal = [...new Set([userInfo().username, hostname(), hostname().split('.')[0], ...originals.map(t => t.provider?.name)])].filter(s => s && s.length > 2);
const privateKey = /^(?:headers|client_metadata|metadata|encrypted_content|access_token|refresh_token|id_token|api_key|apiKey|bearerToken|authorization|cookie|set-cookie|account_id|accountId|email|connectionId|clientConversationKey|prompt_cache_key|safety_identifier|user|jsonlPath|catalogIdentity)$/i;
function text(value) {
  // Personal project history is unrelated to the authorized weather example.
  if (value.startsWith('## Memory') || value.includes('MEMORY_SUMMARY BEGINS')) return '[个人记忆与无关项目资料已移除]';
  let result = value
    .replace(/\/(?:Users|home)\/[^\s/<>"'\\]+/g, '/Users/demo')
    .replace(/([A-Z]:\\+Users\\+)[^\\\s"<>]+/gi, '$1demo')
    .replace(/remote-control:[A-Za-z0-9_:-]+/g, 'remote-control:example-host')
    .replace(/公司电脑|家里电脑/g, '示例设备')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, 'user@example.invalid')
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已移除]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[密钥已移除]')
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '[凭据已移除]')
    .replace(/gAAAA[A-Za-z0-9_+=/-]{80,}/g, '[加密内容已移除]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, alias)
    .replace(/\b(?:acct|account|resp|rs|msg|fc|ws|toolu|call)_[A-Za-z0-9_-]{12,}\b/g, alias);
  for (const name of personal) result = result.split(name).join('demo');
  return result;
}
function sanitize(value, key = '') {
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [name, child] of Object.entries(value)) {
      if (privateKey.test(name)) continue;
      if (name === 'rawBody' || name === 'data' && typeof child === 'string') {
        // Re-serialize JSON/SSE through the same sanitizer; no opaque raw bypass.
        if (typeof child === 'string' && /^(?:event|data):/.test(child.trimStart())) {
          clean[name] = child.split('\n').map(line => line.startsWith('data: ') ? 'data: ' + cleanJson(line.slice(6)) : text(line)).join('\n');
        } else clean[name] = typeof child === 'string' ? cleanJson(child) : sanitize(child);
      } else clean[name] = sanitize(child, name);
    }
    return clean;
  }
  if (typeof value === 'string') return key === 'arguments' ? cleanJson(value) : text(value);
  return value;
}
function cleanJson(value) {
  try { return JSON.stringify(sanitize(JSON.parse(value))); } catch { return text(value); }
}
const traces = originals.map((original, i) => ({ ...sanitize(original), provider: { id: 'example-chatgpt', name: 'ChatGPT' }, id: `example-request-${i + 1}`, sessionId: 'example-weather', client: 'codex' }));
const session = { ...sanitize(selected), id: 'example-weather', title: '纽约与上海的天气查询', hidden: false };
assert.equal(session.traceCount, traces.length);
const fixture = {
  provenance: {
    kind: 'sanitized-real-conversation', requestCount: traces.length,
    capturedAt: traces.at(-1).completedAt, localOnly: true,
    redacted: ['个人记忆及无关项目资料', '设备名与用户名', '请求头与账户标识', '凭据与加密内容', '可追踪的原始 ID'],
    preserved: ['请求与上游请求的分别记录', '天气问题和回复', '联网搜索与工具结果', '通用本地环境', '原始用量、耗时与冻结的参考费用'],
    evidence: originals.map((t, i) => ({ requestId: traces[i].id, sourceTraceSha256: createHash('sha256').update(lines[i]).digest('hex'), inputTokens: t.usage.inputTotalTokens, outputTokens: t.usage.outputTokens, totalTokens: t.usage.totalTokens, durationMs: t.durationMs, referenceCostUsd: t.costSnapshot.knownCostUsd }))
  },
  state: { active: false, rootPath: '本地真实对话脱敏示例', currentSessionId: session.id, sessions: [session], traces }
};
const encoded = JSON.stringify(fixture);
for (const original of personal) assert.ok(!encoded.includes(original), 'Personal identifier remained');
assert.ok(!encoded.includes(args.conversation), 'Original thread ID remained');
assert.ok(!/\/(?:Users|home)\/(?!demo(?:\/|\b))[^/\s]+/.test(encoded), 'Private home path remained');
assert.ok(!encoded.includes('MEMORY_SUMMARY BEGINS'), 'Unrelated personal memory remained');
assert.ok(!/gAAAA[A-Za-z0-9_+=/-]{80,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/.test(encoded), 'Opaque credential material remained');
function audit(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!privateKey.test(key), `Private field remained: ${key}`);
    audit(child);
    if (typeof child === 'string') {
      try { audit(JSON.parse(child)); } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
    }
  }
}
audit(fixture);
for (let i = 0; i < traces.length; i++) {
  assert.deepEqual(traces[i].usage, originals[i].usage);
  assert.deepEqual(traces[i].costSnapshot, originals[i].costSnapshot);
  assert.equal(traces[i].durationMs, originals[i].durationMs);
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, encoded + '\n', { mode: 0o600 });
console.log(`[design-lab] sanitized ${traces.length} actual requests; usage/timing/reference costs preserved; local fixture only`);
