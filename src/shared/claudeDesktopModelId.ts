/** Desktop accepts this ID as-is, so it can connect without Deck's alias map. */
export function isClaudeDesktopCompatibleModelId(modelId: string): boolean {
  const value = modelId.trim().toLowerCase();
  // Desktop 2.2553.1.0 rejects these vendor tokens even inside a name that
  // starts with "claude-". This is a client-side heuristic, not an API contract.
  if (/ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/.test(value)) {
    return false;
  }
  return /^claude-(?:haiku|sonnet|opus|fable|mythos)(?:[-.@:]|$)/.test(value)
    || /(?:^|[./])anthropic\.claude-(?:haiku|sonnet|opus|fable|mythos)(?:[-.@:]|$)/.test(value);
}
