import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { enrichModelCatalogCacheFirst } from '../src/main/app/modelCapabilities';
import { CodexModelCatalogManager } from '../src/main/trace/codexModelCatalogManager';
import type { ModelCatalogEntry } from '../src/main/app/modelCatalog';

/**
 * Generate the Codex catalog the next build would write, into a throwaway
 * CODEX_HOME, and print every row's effort ladder. Reviewing this beats
 * shipping a package and discovering an empty picker afterwards.
 *
 * Run with tools/run-catalog-preview.mjs. Reads the configured 兼容服务
 * connection; the bearer token is never printed.
 */

function connection(): { baseUrl: string; bearerToken: string } {
  for (const dir of ['xwx-deck']) {
    const file = path.join(appDataRoot(), dir, 'settings.json');
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const baseUrl = String(parsed?.compatible?.baseUrl ?? '').replace(/\/+$/, '');
      const bearerToken = String(parsed?.compatible?.bearerToken ?? '');
      if (baseUrl && bearerToken) return { baseUrl, bearerToken };
    } catch { /* try the next candidate */ }
  }
  throw new Error('No configured 兼容服务 connection found.');
}

function appDataRoot(): string {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function listModels(conn: { baseUrl: string; bearerToken: string }, suffix: string): Promise<string[]> {
  return new Promise(resolve => {
    https.get(
      new URL(`${conn.baseUrl}${suffix}`),
      { headers: { authorization: `Bearer ${conn.bearerToken}` } },
      res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(text);
            const rows = parsed.data ?? parsed.models ?? [];
            resolve(rows.map((row: { id?: unknown; name?: unknown }) => String(row.id ?? row.name ?? '')).filter(Boolean));
          } catch { resolve([]); }
        });
      }
    ).on('error', () => resolve([]));
  });
}

async function main(): Promise<void> {
  const conn = connection();
  const chat = await listModels(conn, '/models');
  const anthropicBase = conn.baseUrl.replace(/\/v1$/, '/anthropic/v1');
  const anthropic = await listModels({ ...conn, baseUrl: anthropicBase }, '/models');

  const byId = new Map<string, ModelCatalogEntry>();
  for (const id of chat) {
    byId.set(id, { id, vendor: '其他', protocols: ['chat-completions'], clients: ['codex'] } as ModelCatalogEntry);
  }
  for (const id of anthropic) {
    const existing = byId.get(id);
    byId.set(id, {
      id,
      vendor: '其他',
      protocols: [...(existing?.protocols ?? []), 'anthropic-messages'],
      clients: ['codex', 'claude']
    } as ModelCatalogEntry);
  }
  console.log(`discovered ${chat.length} chat + ${anthropic.length} anthropic = ${byId.size} unique ids`);

  // Use the app's own last-successful capability snapshot. Forcing offline
  // would drop the models.dev/LiteLLM `reasoning` flags and understate the
  // picker coverage, which is not what the shipped build will produce.
  const cachePath = path.join(appDataRoot(), 'xwx-deck', 'model-capabilities-cache.json');
  const enriched = await enrichModelCatalogCacheFirst([...byId.values()], async () => {
    throw new Error('offline preview: relying on the cached capability snapshot');
  }, cachePath);

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-preview-'));
  process.env.CODEX_HOME = home;
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider = "openai"\n', 'utf8');
  const result = await new CodexModelCatalogManager().sync(enriched);
  const written = JSON.parse(await fs.readFile(result, 'utf8')) as {
    models: Array<Record<string, unknown>>;
  };

  const rows = written.models.map(row => ({
    slug: String(row.slug),
    levels: ((row.supported_reasoning_levels ?? []) as Array<{ effort: string }>).map(level => level.effort),
    fallback: row.default_reasoning_level as string | undefined,
    summary: row.supports_reasoning_summary_parameter
  }));
  const width = Math.max(...rows.map(row => row.slug.length));
  for (const row of rows.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const flag = row.levels.length ? '   ' : '  !';
    console.log(`${flag} ${row.slug.padEnd(width)}  default=${String(row.fallback ?? '—').padEnd(7)} summary=${String(row.summary).padEnd(5)} [${row.levels.join(',')}]`);
  }
  const empty = rows.filter(row => !row.levels.length);
  console.log(`\n${rows.length - empty.length}/${rows.length} rows expose an effort picker.`);
  console.log(`no picker (${empty.length}): ${empty.map(row => row.slug).join(', ')}`);
  console.log(`\npreview written to ${result}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
