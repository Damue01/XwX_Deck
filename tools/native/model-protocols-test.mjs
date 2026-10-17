import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalOfficialModelId, normalizeProtocolTable, mergeOfficialModels } from '../build/official-models.mjs';

const root = resolve(import.meta.dirname, '../..');
const table = JSON.parse(await readFile(resolve(root, 'assets/model-protocols.json'), 'utf8'));
const normalized = normalizeProtocolTable(table);
assert.equal(normalized.models.length, 40);
const protocols = id => normalized.models.find(row => row.modelId === id)?.protocols ?? [];
assert.deepEqual(protocols('qwen3.8-max'), ['openai-responses', 'chat-completions', 'anthropic-messages']);
assert.deepEqual(protocols('qwen3-coder-plus'), ['chat-completions']);
assert.deepEqual(protocols('qwen3.8-omni-flash'), ['openai-responses', 'chat-completions']);
assert.deepEqual(protocols('kimi-k2.7-code'), ['chat-completions', 'anthropic-messages']);
assert.deepEqual(protocols('MiniMax-M3'), ['openai-responses', 'chat-completions', 'anthropic-messages']);
assert.equal(canonicalOfficialModelId('qwen3.7-max-2026-05-20'), canonicalOfficialModelId('qwen3.7-max'));
assert.equal(canonicalOfficialModelId('deepseek-v4-pro-ga-260813'), canonicalOfficialModelId('deepseek-v4-pro'));

const existing = {
  modelId: 'deepseek-flash',
  vendor: 'DeepSeek',
  verifiedAt: '2026-01-01',
  sources: [],
  capability: { contextWindow: 999, reasoning: true },
  protocols: ['chat-completions'],
  claudeOneMillionRoles: [],
  codexRecommendedProtocol: 'chat-completions'
};
const merged = mergeOfficialModels([existing], table);
const flash = merged.find(row => row.modelId === 'deepseek-flash');
assert.deepEqual(flash.protocols, ['openai-responses', 'chat-completions', 'anthropic-messages']);
assert.equal(flash.capability.contextWindow, 999, 'existing curated capability must win');
assert.ok(flash.sources.length > 0, 'official source links must be retained');
assert.ok(merged.some(row => row.modelId === 'qwen3.8-max' && row.capability.contextWindow === 1_000_000));
const existingK26 = {
  modelId: 'kimi-k2.6',
  vendor: 'Kimi',
  verifiedAt: '2026-01-01',
  sources: [],
  capability: { inputModalities: ['text', 'image'] },
  protocols: ['chat-completions', 'anthropic-messages'],
  claudeOneMillionRoles: [],
  codexRecommendedProtocol: 'chat-completions'
};
const mergedK26 = mergeOfficialModels([existingK26], table).find(row => row.modelId === 'kimi-k2.6');
assert.deepEqual(mergedK26.capability.inputModalities, ['text', 'image', 'video'], 'modalities union must fill a missing video capability');

assert.throws(() => normalizeProtocolTable({ ...table, models: [{ ...table.models[0], protocols: ['invented'] }] }), /unknown protocol/);
assert.throws(() => normalizeProtocolTable({
  ...table,
  sources: { ...table.sources, bad: { label: 'bad', url: 'https://example.com/model' } },
  models: [{ ...table.models[0], sourceIds: ['bad'] }]
}), /approved official documentation host/);
assert.throws(() => normalizeProtocolTable({
  ...table,
  models: [table.models[0], { ...table.models[0], modelId: table.models[0].modelId.toUpperCase() }]
}), /duplicate canonical model identity/);

console.log('PASS model protocol table: 40 verified rows, explicit protocols, source allowlist, merge precedence and duplicate rejection');
