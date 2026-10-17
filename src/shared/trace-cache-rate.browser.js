// Accumulate eligible request pairs, never a partial numerator/denominator.
;(function installTraceCacheRate() {
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  const empty = () => ({ inputTokens:0, cacheReadTokens:0, knownRequests:0, excludedRequests:0 });
  function pair(u) {
    if (!u || u.version !== 2 || !valid(u.cacheRead)) return null;
    const totalKnown = valid(u.inputTotal) && u.inputTotalComplete === true;
    if ((u.incompleteFields || []).includes('cacheRead')) return null;
    if ((u.invalidFields || []).some(f => f === 'cacheRead' || f === 'input')) return null;
    if (!totalKnown && ((u.incompleteFields || []).some(f => ['input','cacheWrite'].includes(f))
      || ![u.input,u.cacheCreation].every(valid))) return null;
    const inputTokens = totalKnown ? u.inputTotal : u.input+u.cacheRead+u.cacheCreation;
    return valid(inputTokens) && inputTokens >= u.cacheRead ? { inputTokens, cacheReadTokens:u.cacheRead } : null;
  }
  function accumulate(previous, usage) {
    const result = { ...empty(), ...previous };
    const p = pair({ version:2, input:usage?.inputUncachedTokens, inputTotal:usage?.inputTotalTokens,
      inputTotalComplete:usage?.inputTotalTokens !== undefined && (usage?.inputIncludesCache === true
        || !(usage?.incompleteFields || []).some(f => ['cacheRead','cacheWrite'].includes(f))),
      cacheRead:usage?.cacheReadTokens, cacheCreation:usage?.cacheCreationTokens,
      incompleteFields:usage?.incompleteFields, invalidFields:usage?.invalidFields });
    if (p) { result.inputTokens += p.inputTokens; result.cacheReadTokens += p.cacheReadTokens; result.knownRequests++; }
    else result.excludedRequests++;
    return result;
  }
  function details(sessions) {
    const result = empty();
    for (const session of sessions) {
      let stats = session.cacheHitUsage;
      if (!stats || !['inputTokens','cacheReadTokens','knownRequests','excludedRequests'].every(k => valid(stats[k]))
        || stats.inputTokens < stats.cacheReadTokens) {
        stats = empty();
        const buckets = Object.values(session.usageByModel || {}), pairs = buckets.map(pair);
        const count = session.traceCount || (session.totalTokens > 0 ? 1 : 0);
        // Old summaries cannot separate unknown requests inside a bucket. The
        // native read-only migration supplies pairs from original records.
        if (buckets.length && pairs.every(Boolean)) {
          for (const p of pairs) { stats.inputTokens += p.inputTokens; stats.cacheReadTokens += p.cacheReadTokens; }
          stats.knownRequests = count;
        } else stats.excludedRequests = count;
      }
      for (const k of Object.keys(result)) result[k] += stats[k];
    }
    return { ...result, rate:result.inputTokens > 0 && valid(result.inputTokens) && valid(result.cacheReadTokens)
      ? result.cacheReadTokens/result.inputTokens : null };
  }
  const rate = sessions => details(sessions).rate;
  rate.details = details;
  rate.accumulate = accumulate;
  window.XwXTraceCacheRate = rate;
})();
