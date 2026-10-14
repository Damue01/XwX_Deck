// Shared by the retained TypeScript backend and the embedded Trace viewer.
// Rust consumes the same contract corpus. Optional Chat/Messages counters use
// schema defaults; required Responses counters and invalid values stay unknown.
;(function install(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = { normalizeTraceUsage: factory() };
  else root.XwXNormalizeTraceUsage = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const number = (...values) => {
    const valid = values.map(value => typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value) : value)
      .filter(value => Number.isSafeInteger(value) && value >= 0);
    return valid.find(value => value > 0) ?? valid[0];
  };
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  const positive = (first, mirror) => first > 0 ? first : mirror ?? first;
  return function normalize(raw, protocol, inclusiveOverride, request) {
    const u = object(raw);
    if (!u) return undefined;
    const details = object(u.prompt_tokens_details) || object(u.input_tokens_details) || object(u.input_token_details) || {};
    const outputDetails = object(u.completion_tokens_details) || object(u.output_tokens_details) || object(u.output_token_details) || {};
    const creation = object(u.cache_creation) || {};
    let input = number(u.input_tokens, u.prompt_tokens, u.input, u.prompt);
    let output = number(u.output_tokens, u.completion_tokens, u.output, u.completion);
    let five = number(creation.ephemeral_5m_input_tokens, details.cache_write_5m_tokens, u.claude_cache_creation_5_m_tokens);
    let hour = number(creation.ephemeral_1h_input_tokens, details.cache_write_1h_tokens, u.claude_cache_creation_1_h_tokens);
    const split = five !== undefined && hour !== undefined ? number(five + hour) : undefined;
    const topWrite = number(u.cache_creation_input_tokens, u.cache_creation_tokens, u.cacheCreationTokens, creation.input_tokens, creation.tokens, split);
    const detailWrite = number(details.cache_creation_tokens, details.cache_creation_input_tokens, details.cache_write_tokens);
    const additive = inclusiveOverride !== undefined ? !inclusiveOverride
      : ['messages', 'anthropic-messages'].includes(protocol) || u.cache_creation_input_tokens !== undefined || u.cache_creation_tokens !== undefined || !!object(u.cache_creation);
    const inclusive = !additive && (inclusiveOverride === true || ['responses','chat-completions','openai-responses','openai-chat-completions'].includes(protocol));
    const detailRead = number(details.cached_tokens, details.cache_read_tokens, details.cache_read_input_tokens);
    const topRead = number(u.cache_read_input_tokens, u.cache_read_tokens, u.cacheReadTokens, u.prompt_cache_hit_tokens, u.cached_tokens);
    let read = additive ? positive(topRead, detailRead) : positive(detailRead, topRead);
    let write = additive ? positive(topWrite, detailWrite) : positive(detailWrite, topWrite);
    const supplied = values => values.some(v => v !== undefined && v !== null);
    const optional = ['chat-completions','openai-chat-completions','messages','anthropic-messages'].includes(protocol) && (input !== undefined || output !== undefined);
    // Qwen Responses carries complete Chat-shaped per-call billing details.
    // Only this validated schema gives an omitted write counter a zero default.
    const parts = u.x_details;
    const chatBillingDetails = ['responses','openai-responses'].includes(protocol)
      && [input,output,read].every(Number.isSafeInteger) && Array.isArray(parts) && parts.length > 0
      && parts.every(part => part && part.x_billing_type === 'response_api'
        && Number.isSafeInteger(part.input_tokens) && part.input_tokens >= 0
        && Number.isSafeInteger(part.output_tokens) && part.output_tokens >= 0
        && Number.isSafeInteger(part.prompt_tokens_details?.cached_tokens) && part.prompt_tokens_details.cached_tokens >= 0
        && ['cache_write_tokens','cache_creation_tokens','cache_creation_input_tokens','cacheCreationTokens','cache_creation','cache_write_5m_tokens','cache_write_1h_tokens','claude_cache_creation_5_m_tokens','claude_cache_creation_1_h_tokens'].every(key => !(key in part) && !(key in part.prompt_tokens_details)))
      && parts.reduce((sum,p) => sum+p.input_tokens,0) === input
      && parts.reduce((sum,p) => sum+p.output_tokens,0) === output
      && parts.reduce((sum,p) => sum+p.prompt_tokens_details.cached_tokens,0) === read;
    const defaults = [], derived = [];
    if(optional && read === undefined && !supplied([details.cached_tokens,details.cache_read_tokens,details.cache_read_input_tokens,u.cache_read_input_tokens,u.cache_read_tokens,u.cacheReadTokens,u.prompt_cache_hit_tokens,u.cached_tokens])) { read=0; defaults.push('cacheRead'); }
    if((optional || chatBillingDetails) && write === undefined && !supplied([u.cache_creation_input_tokens,u.cache_creation_tokens,u.cacheCreationTokens,creation.input_tokens,creation.tokens,details.cache_creation_tokens,details.cache_creation_input_tokens,details.cache_write_tokens,creation.ephemeral_5m_input_tokens,creation.ephemeral_1h_input_tokens,details.cache_write_5m_tokens,details.cache_write_1h_tokens,u.claude_cache_creation_5_m_tokens,u.claude_cache_creation_1_h_tokens])) { write=0; defaults.push('cacheWrite'); }
    if (write !== undefined) {
      if (five === undefined && hour !== undefined) five = number(write - hour);
      if (hour === undefined && five !== undefined) hour = number(write - five);
    }
    const hourRequested = value => value && typeof value === 'object' && (value.cache_control?.ttl === '1h' || Object.values(value).some(hourRequested));
    if(additive && write > 0 && five === undefined && hour === undefined && object(request) && !hourRequested(request)) {
      five=write; hour=0; derived.push('cacheWriteTtl');
    }
    const cache = number((read ?? 0) + (write ?? 0));
    const reportedTotal = number(u.total_tokens, u.total);
    if(reportedTotal !== undefined && read !== undefined && write !== undefined){
      if(input === undefined && output !== undefined && !supplied([u.input_tokens,u.prompt_tokens,u.input,u.prompt])) { input=number(reportedTotal-output-(additive?cache:0)); if(input !== undefined) derived.push('input'); }
      if(output === undefined && input !== undefined && !supplied([u.output_tokens,u.completion_tokens,u.output,u.completion])) { output=number(reportedTotal-input-(additive?cache:0)); if(output !== undefined) derived.push('output'); }
    }
    const uncached = additive ? input : inclusive && input !== undefined && cache !== undefined ? number(input - cache) : undefined;
    const inputTotal = additive ? input !== undefined && cache !== undefined ? number(input + cache) : undefined : inclusive ? input : undefined;
    const total = reportedTotal ?? (inputTotal !== undefined && output !== undefined ? number(inputTotal + output) : undefined);
    const missing = [];
    if (uncached === undefined) missing.push('input');
    if (read === undefined) missing.push('cacheRead');
    if (write === undefined) missing.push('cacheWrite');
    if (output === undefined) missing.push('output');
    if (total === undefined) missing.push('total');
    const result = { inputTokens: input, inputUncachedTokens: uncached, inputTotalTokens: inputTotal, outputTokens: output,
      cacheReadTokens: read, cacheCreationTokens: write, cacheCreation5mTokens: five, cacheCreation1hTokens: hour,
      reasoningTokens: number(u.reasoning_tokens, outputDetails.reasoning_tokens, outputDetails.reasoning, outputDetails.thinking_tokens, u.thinking_tokens),
      totalTokens: total, inputIncludesCache: additive ? false : inclusive ? true : undefined, incompleteFields: missing.length ? missing : undefined,
      optionalDefaults: defaults.length ? defaults : undefined, derivedFields: derived.length ? derived : undefined };
    if (five !== undefined && hour !== undefined && write !== undefined && number(five + hour) !== write) result.invalidFields = ['cacheWriteTtl'];
    return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
  };
});
