import { enrichModelCatalog } from '../src/main/app/modelCapabilities';

/**
 * Ad-hoc diagnostic: what does the capability merge actually conclude for a
 * 兼容服务-only model id? Run with tools/run-capability-probe.mjs.
 */
async function main(): Promise<void> {
  const entries = [
    'gpt-5.5',
    'gpt-5.2-codex',
    'gpt-5.6-sol',
    'qwen3-max',
    'doubao-seed-1-6-flash',
    'doubao-seed-2-1-pro',
    'doubao-seed-character',
    'kimi-k3-external'
  ].map(id => ({
    id,
    vendor: 'probe',
    protocols: (id.startsWith('gpt-') ? ['openai-responses'] : ['chat-completions']) as string[],
    clients: ['codex'] as string[]
  }));

  // No network: isolate what the built-in registry and official overrides
  // conclude on their own.
  const enriched = await enrichModelCatalog(entries as never, (async () => {
    throw new Error('offline probe');
  }) as never);
  for (const item of enriched as Array<Record<string, unknown>>) {
    console.log(
      String(item.id).padEnd(22),
      'reasoning=' + String(item.reasoning),
      'levels=' + JSON.stringify(item.reasoningLevels ?? null),
      'default=' + String(item.defaultReasoningLevel ?? '—'),
      'src=' + JSON.stringify((item.capabilitySources as Record<string, unknown> | undefined)?.reasoning ?? null)
    );
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
