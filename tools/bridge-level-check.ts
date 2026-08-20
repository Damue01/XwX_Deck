/**
 * End-to-end check: take the request our own bridge produces for every
 * published effort level and send it to the live gateway. This is the only
 * check that answers "does the level actually make it upstream", because it
 * exercises `responsesToChatCompletions` rather than a hand-written body.
 *
 * Manual diagnostic, never part of `npm test`. Spends real tokens.
 * Run with: node tools/run-bridge-level-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { responsesToChatCompletions } from '../src/main/trace/codexChatBridge';
import { resolveCompatibleServiceReasoningProfile } from '../src/main/trace/compatibleServiceReasoningProfiles';

const NON_CONVERSATIONAL = /(?:embedding|image|ocr)/i;
const CHAT_FAMILY = /^(?:minimax|deepseek|doubao|glm|grok|kimi|qwen|gui-)/i;
const CONCURRENCY = 4;

function loadConnection(): { baseUrl: string; bearerToken: string } {
  for (const dir of ['xwx-deck']) {
    const file = path.join(appDataRoot(), dir, 'settings.json');
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const baseUrl = String(parsed?.compatible?.baseUrl ?? '').replace(/\/+$/, '');
    const bearerToken = String(parsed?.compatible?.bearerToken ?? '');
    if (baseUrl && bearerToken) return { baseUrl, bearerToken };
  }
  throw new Error('No configured 兼容服务 connection found.');
}

function appDataRoot(): string {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function request(
  connection: { baseUrl: string; bearerToken: string },
  method: 'GET' | 'POST',
  suffix: string,
  body?: string
): Promise<{ status: number; text: string }> {
  return new Promise(resolve => {
    const req = https.request(
      new URL(`${connection.baseUrl}${suffix}`),
      {
        method,
        headers: {
          authorization: `Bearer ${connection.bearerToken}`,
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {})
        }
      },
      res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on('error', error => resolve({ status: 0, text: error.message }));
    if (body) req.write(body);
    req.end();
  });
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function main(): Promise<void> {
  const connection = loadConnection();
  const listed = await request(connection, 'GET', '/models');
  const models: string[] = (JSON.parse(listed.text).data ?? [])
    .map((entry: { id?: unknown }) => String(entry.id ?? ''))
    .filter((id: string) => id && CHAT_FAMILY.test(id) && !NON_CONVERSATIONAL.test(id))
    .sort();

  const plan: Array<{ model: string; level: string }> = [];
  for (const model of models) {
    for (const level of resolveCompatibleServiceReasoningProfile(model).levels ?? []) plan.push({ model, level });
  }
  console.log(`gateway: ${connection.baseUrl}`);
  console.log(`models with published levels: ${new Set(plan.map(item => item.model)).size}  requests: ${plan.length}\n`);

  const rows = await mapWithConcurrency(plan, CONCURRENCY, async ({ model, level }) => {
    // Build exactly what the gateway would forward for this picker selection.
    const converted = responsesToChatCompletions(
      { model, input: 'Say ok.', reasoning: { effort: level }, max_output_tokens: 32 },
      { useVerifiedCompatibleServiceReasoningProfile: true }
    ) as Record<string, unknown>;
    const sent = {
      thinking: converted.thinking,
      enable_thinking: converted.enable_thinking,
      reasoning_effort: converted.reasoning_effort
    };
    const result = await request(connection, 'POST', '/chat/completions', JSON.stringify(converted));
    let detail = '';
    if (result.status >= 400 || result.status === 0) {
      try {
        const parsed = JSON.parse(result.text);
        detail = String(parsed?.error?.message ?? parsed?.message ?? result.text);
      } catch { detail = result.text; }
      detail = detail.replace(/\s+/g, ' ').slice(0, 130);
    }
    return { model, level, status: result.status, sent, detail };
  });

  let failures = 0;
  for (const row of rows) {
    const ok = row.status >= 200 && row.status < 300;
    if (!ok) failures += 1;
    const control = JSON.stringify(row.sent).replace(/"(\w+)":/g, '$1:');
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${row.model.padEnd(30)} ${row.level.padEnd(7)} ${String(row.status).padEnd(4)} ${control}${row.detail ? `  ${row.detail}` : ''}`);
  }
  console.log(`\n${rows.length - failures}/${rows.length} published levels are accepted by the gateway as the bridge sends them.`);
  if (failures) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
