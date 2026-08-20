#!/usr/bin/env node
/**
 * Manual diagnostic: discover which reasoning control each 兼容服务 model
 * actually accepts, and whether the published effort levels produce different
 * requests upstream.
 *
 * This is NOT part of `npm test`. It spends real tokens against the configured
 * 兼容服务 account, so it defaults to `--dry-run` and must be pointed at a
 * model set explicitly.
 *
 *   node tools/probe-reasoning-contract.mjs                 # dry run, print bodies
 *   node tools/probe-reasoning-contract.mjs --send          # acceptance probe
 *   node tools/probe-reasoning-contract.mjs --send --levels # + level differentiation
 *   node tools/probe-reasoning-contract.mjs --models kimi-k3,glm-5.2
 *
 * The bearer token is read from the installed app's settings.json and is never
 * printed, logged or written to the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const valueOf = flag => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const DRY_RUN = !has('--send');
const WITH_LEVELS = has('--levels');

// Candidate control shapes. Each probe sends exactly one shape so a 400 names
// the offending field instead of leaving an ambiguous combination.
// Acceptance (HTTP status) is the only reliable signal here: reasoning-token
// counts on a single sample are dominated by variance and must not be used to
// decide whether a level is honoured.
const VARIANTS = [
  { id: 'effort:none', body: { reasoning_effort: 'none' } },
  { id: 'effort:minimal', body: { reasoning_effort: 'minimal' } },
  { id: 'effort:low', body: { reasoning_effort: 'low' } },
  { id: 'effort:medium', body: { reasoning_effort: 'medium' } },
  { id: 'effort:high', body: { reasoning_effort: 'high' } },
  { id: 'effort:xhigh', body: { reasoning_effort: 'xhigh' } },
  { id: 'effort:max', body: { reasoning_effort: 'max' } },
  { id: 'thinking:enabled', body: { thinking: { type: 'enabled' } } },
  { id: 'thinking:disabled', body: { thinking: { type: 'disabled' } } },
  { id: 'thinking:auto', body: { thinking: { type: 'auto' } } },
  { id: 'thinking:adaptive', body: { thinking: { type: 'adaptive' } } },
  { id: 'enable_thinking:false', body: { enable_thinking: false } }
];

/** Model families routed through the Chat Completions bridge. */
const CHAT_FAMILY = /^(?:minimax|deepseek|doubao|glm|grok|kimi|qwen|gui-)/i;
/** Never conversational: embeddings, image generation, OCR. */
const NON_CONVERSATIONAL = /(?:embedding|image|ocr)/i;

const CONCURRENCY = 4;

// Models where the published table is currently unverified or disputed.
const DEFAULT_MODELS = [
  'kimi-k3',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'glm-5.2',
  'glm-5.3',
  'qwen3.8-max',
  'qwen3.7-max',
  'MiniMax-M3',
  'doubao-seed-2-1-pro',
  'grok-4.3',
  'grok-4.5',
  'grok-4.6',
  'deepseek-v4-pro'
];

function loadConnection() {
  const appData = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  const roots = [
    path.join(appData, 'xwx-deck', 'settings.json')
  ];
  for (const file of roots) {
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const baseUrl = String(parsed?.compatible?.baseUrl ?? '').replace(/\/+$/, '');
    const bearerToken = String(parsed?.compatible?.bearerToken ?? '');
    if (baseUrl && bearerToken) return { baseUrl, bearerToken, file };
  }
  throw new Error('No configured 兼容服务 connection found in settings.json.');
}

function post(connection, body) {
  const payload = JSON.stringify(body);
  return new Promise(resolve => {
    const started = Date.now();
    const req = https.request(
      new URL(`${connection.baseUrl}/chat/completions`),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${connection.bearerToken}`
        }
      },
      res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, ms: Date.now() - started }));
      }
    );
    req.on('error', error => resolve({ status: 0, text: `TRANSPORT ${error.message}`, ms: Date.now() - started }));
    req.end(payload);
  });
}

function get(connection, pathSuffix) {
  return new Promise((resolve, reject) => {
    https.get(
      new URL(`${connection.baseUrl}${pathSuffix}`),
      { headers: { authorization: `Bearer ${connection.bearerToken}` } },
      res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve(text));
      }
    ).on('error', reject);
  });
}

/** Every chat-bridge model the gateway currently serves. */
async function discoverChatModels(connection) {
  const parsed = JSON.parse(await get(connection, '/models'));
  return (parsed.data ?? [])
    .map(entry => String(entry.id ?? ''))
    .filter(id => id && CHAT_FAMILY.test(id) && !NON_CONVERSATIONAL.test(id))
    .sort();
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

/** Trivial prompt: keep generation short so an acceptance probe stays cheap. */
function acceptanceBody(model, variant) {
  return { model, messages: [{ role: 'user', content: 'Say ok.' }], max_tokens: 32, ...variant };
}

/**
 * A fixed multi-step task so reasoning volume is comparable across levels.
 * Differentiation is judged on reported reasoning tokens, not on the answer.
 */
function levelBody(model, effort) {
  return {
    model,
    messages: [{
      role: 'user',
      content: 'A bag has 3 red, 4 blue and 5 green balls. Two are drawn without replacement. '
        + 'What is the probability both are the same colour? Give the reduced fraction only.'
    }],
    max_tokens: 2048,
    reasoning_effort: effort
  };
}

function summarize(result) {
  if (result.status === 0) return { verdict: 'TRANSPORT', detail: result.text.slice(0, 120) };
  let parsed;
  try { parsed = JSON.parse(result.text); } catch { parsed = undefined; }
  if (result.status >= 400) {
    const message = parsed?.error?.message ?? parsed?.message ?? result.text;
    return { verdict: `HTTP ${result.status}`, detail: String(message).slice(0, 200) };
  }
  const usage = parsed?.usage ?? {};
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
    ?? usage.reasoning_tokens
    ?? undefined;
  const message = parsed?.choices?.[0]?.message ?? {};
  const hasReasoningText = typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0;
  return {
    verdict: 'ACCEPTED',
    reasoningTokens,
    hasReasoningText,
    completionTokens: usage.completion_tokens,
    detail: reasoningTokens !== undefined
      ? `reasoning_tokens=${reasoningTokens}`
      : hasReasoningText
        ? `reasoning_content=${message.reasoning_content.length} chars`
        : 'no reasoning evidence reported'
  };
}

async function main() {
  const connection = loadConnection();
  const models = has('--all')
    ? await discoverChatModels(connection)
    : (valueOf('--models')?.split(',').map(value => value.trim()).filter(Boolean)) ?? DEFAULT_MODELS;
  const plan = [];
  for (const model of models) for (const variant of VARIANTS) plan.push({ model, variant });

  console.log(`connection: ${connection.baseUrl} (token read from ${path.basename(path.dirname(connection.file))}/settings.json, not printed)`);
  console.log(`models: ${models.length}  variants: ${VARIANTS.length}  acceptance requests: ${plan.length}`);
  if (WITH_LEVELS) console.log('level differentiation: up to 4 extra requests per model that accepts reasoning_effort');

  if (DRY_RUN) {
    console.log('\n--- DRY RUN (nothing sent). Example bodies:\n');
    for (const variant of VARIANTS) {
      console.log(`${variant.id.padEnd(22)} ${JSON.stringify(acceptanceBody(models[0], variant.body))}`);
    }
    console.log(`\nlevel probe body    ${JSON.stringify(levelBody(models[0], 'low'))}`);
    console.log(`\nmodels: ${models.join(', ')}`);
    console.log('\nRe-run with --send to execute.');
    return;
  }

  const accepted = new Map();
  console.log('\n=== acceptance (only HTTP status is reliable evidence) ===');
  const rows = await mapWithConcurrency(plan, CONCURRENCY, async ({ model, variant }) => {
    const summary = summarize(await post(connection, acceptanceBody(model, variant.body)));
    return { model, variant, summary };
  });
  for (const { model, variant, summary } of rows) {
    if (summary.verdict === 'ACCEPTED') {
      if (!accepted.has(model)) accepted.set(model, []);
      accepted.get(model).push(variant.id);
    }
    console.log(`${model.padEnd(30)} ${variant.id.padEnd(22)} ${summary.verdict.padEnd(10)} ${summary.detail}`);
  }

  console.log('\n=== per-model accepted control shapes ===');
  for (const model of models) {
    const ok = accepted.get(model) ?? [];
    const efforts = ok.filter(id => id.startsWith('effort:')).map(id => id.slice(7));
    const toggles = ok.filter(id => !id.startsWith('effort:'));
    console.log(`${model.padEnd(30)} effort=[${efforts.join(',')}]  toggle=[${toggles.join(',')}]`);
  }

  if (!WITH_LEVELS) return;
  console.log('\n=== level differentiation (reasoning tokens per effort) ===');
  for (const [model, variants] of accepted) {
    if (!variants.some(id => id.startsWith('effort:'))) {
      console.log(`${model.padEnd(22)} skipped: reasoning_effort not accepted`);
      continue;
    }
    const observed = [];
    for (const effort of ['low', 'medium', 'high', 'max']) {
      const summary = summarize(await post(connection, levelBody(model, effort)));
      observed.push(`${effort}=${summary.verdict === 'ACCEPTED' ? (summary.reasoningTokens ?? '?') : summary.verdict}`);
    }
    console.log(`${model.padEnd(22)} ${observed.join('  ')}`);
  }
  console.log('\nIdentical reasoning-token counts across levels indicate the level is not honoured upstream.');
  console.log('A single sample is weak evidence; re-run before changing a published level list.');
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
