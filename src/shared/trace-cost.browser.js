// Keep a complete charge distinct from a subtotal. The caller supplies the
// existing billing engine, so tiers and time bands retain the same semantics.
;(function install(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = { traceCostBreakdown: factory() };
  else root.XwXTraceCostBreakdown = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  return function breakdown(usage, price, estimate) {
    const full = estimate(usage, price);
    if (full !== undefined) return { cost: full, complete: true };
    const missing = new Set(usage.incompleteFields || []);
    const invalid = new Set(usage.invalidFields || []);
    if ([...invalid].some(field => !['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWriteTtl', 'total'].includes(field))) return { complete: false };
    let cost, known = 0;
    const project = (counters, keys) => {
      const result = { ...counters, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: undefined, cacheCreation1h: undefined, reasoning: 0, reasoningComplete: true };
      for (const key of keys) result[key] = counters[key];
      if (keys.includes('output')) { result.reasoning = counters.reasoning; result.reasoningComplete = counters.reasoningComplete; }
      return result;
    };
    function add(keys) {
      const part = { ...project(usage, keys), incompleteFields: [], invalidFields: [] };
      if (usage.bands) part.bands = usage.bands.map(band => project(band, keys));
      const value = estimate(part, price);
      if (value !== undefined) { known++; cost = (cost || 0) + value; }
      return value !== undefined;
    }
    const valid = field => !missing.has(field) && !invalid.has(field);
    const inputKeys = ['input', 'cacheRead', 'cacheCreation', 'cacheCreation5m', 'cacheCreation1h'];
    const inputGroup = { ...project(usage, inputKeys),
      incompleteFields: [...missing].filter(field => !['output', 'total'].includes(field)),
      invalidFields: [...invalid].filter(field => !['output', 'total'].includes(field)) };
    if (usage.bands) inputGroup.bands = usage.bands.map(band => project(band, inputKeys));
    const inputCost = estimate(inputGroup, price);
    if (inputCost !== undefined) {
      cost = inputCost; known++;
      if (valid('output')) add(['output']);
      return { cost, complete: false };
    }
    // Inclusive input is a remainder: a missing cache counter also makes that
    // remainder uncertain. Additive Messages input is independent of cache.
    if (valid('input') && (usage.apiType === 'messages' || (!missing.has('cacheRead') && !missing.has('cacheWrite')))) add(['input']);
    if (valid('output')) add(['output']);
    if (valid('cacheRead')) add(['cacheRead']);
    if (valid('cacheWrite') && !invalid.has('cacheWriteTtl')) {
      if (!add(['cacheCreation', 'cacheCreation5m', 'cacheCreation1h'])) {
        // An unknown TTL remainder does not invalidate a documented split.
        for (const key of ['cacheCreation5m', 'cacheCreation1h']) {
          if (!(usage[key] > 0) || (usage.cacheCreation5m || 0) + (usage.cacheCreation1h || 0) > usage.cacheCreation) continue;
          const split = { ...usage, cacheCreation: usage[key], [key]: usage[key] };
          if (usage.bands) split.bands = usage.bands.map(band => ({ ...band, cacheCreation: band[key] || 0 }));
          const result = estimate({ ...split, input: 0, output: 0, cacheRead: 0,
            cacheCreation5m: key === 'cacheCreation5m' ? usage[key] : 0,
            cacheCreation1h: key === 'cacheCreation1h' ? usage[key] : 0,
            bands: split.bands?.map(band => ({ ...project(band, [key]), cacheCreation: band[key] || 0 })),
            incompleteFields: [], invalidFields: [] }, price);
          if (result !== undefined) { known++; cost = (cost || 0) + result; }
        }
      }
    }
    return { cost: known ? cost : undefined, complete: false };
  };
});
