// Smoke tests must observe a clean, deterministic client environment. A
// developer who actually uses XwX Deck has ANTHROPIC_BASE_URL, ANTHROPIC_*,
// CLAUDE_CONFIG_DIR and CODEX_HOME exported in their shell (that is the whole
// point of the product). Those variables win over settings.json/config.toml in
// the detection logic, so leaking them into a smoke child turns a hermetic
// "taken" takeover into a real "skipped" environment-override and fails a build
// that is otherwise fine. Strip the client-identity variables here; callers add
// their own isolated CODEX_HOME / XWX_DECK_CLIENT_HOME afterwards.

const EXACT_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'XWX_DECK_CLIENT_HOME'
]);

// ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, etc.
const PREFIX_KEYS = ['ANTHROPIC_DEFAULT_'];

/**
 * Returns a copy of `source` with the ambient client-identity variables
 * removed, so a spawned smoke process starts from a neutral baseline.
 */
export function sanitizeClientEnv(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (EXACT_KEYS.has(key) || PREFIX_KEYS.some(prefix => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  return env;
}
