// Edition-neutral browser helper. V2 input is the uncached bucket for every protocol.
;(function installTraceCacheRate() {
  window.XwXTraceCacheRate = function cacheHitRate(sessions) {
    let read = 0, input = 0;
    for (const session of sessions) {
      const buckets = Object.values(session.usageByModel || {});
      if (!buckets.length && (session.traceCount > 0 || session.totalTokens > 0)) return null;
      for (const usage of buckets) {
        if (!usage || usage.version !== 2) return null;
        const hasTotal = typeof usage.inputTotal === 'number' && usage.inputTotalComplete === true;
        if ((usage.incompleteFields || []).some(field => field === 'cacheRead' || (!hasTotal && ['input', 'cacheWrite'].includes(field)))) return null;
        const values = [usage.input, usage.cacheRead, usage.cacheCreation];
        if (!values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
        read += usage.cacheRead;
        const denominator = hasTotal ? usage.inputTotal : usage.input + usage.cacheRead + usage.cacheCreation;
        if (!Number.isFinite(denominator) || denominator < usage.cacheRead) return null;
        input += denominator;
      }
    }
    return input > 0 && Number.isFinite(input) && Number.isFinite(read) ? read / input : null;
  };
})();
