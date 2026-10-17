// One token-charge implementation for the retained backend and the Viewer.
;(function install(root, factory) {
  const estimateTraceCost = factory();
  if (typeof module === 'object' && module.exports) module.exports = { estimateTraceCost };
  else root.XwXEstimateTraceCost = estimateTraceCost;
})(typeof window === 'object' ? window : globalThis, function () {
function estimateTraceCost(u, price){
  const M = 1000000;
  // Version 1 rows only carry a mutually exclusive input bucket when the capture
  // was Anthropic Messages; a version 1 Responses row stored provider-native
  // total input and can no longer be split.
  const exclusiveInput = u.version === 2
    || (u.apiType ? u.apiType === 'messages' : price.protocol === 'anthropic');
  if(!exclusiveInput) return undefined;
  const policy = price.cacheWrite != null
    ? 'listed'
    : (price.cacheWritePolicy || ((price.providerId === 'deepseek' || price.providerId === 'xai') ? 'input' : (price.providerId === 'google' ? 'storage' : 'unknown')));
  if((u.invalidFields || []).length) return undefined;
  if(u.incompleteFields && u.incompleteFields.some(function(field){
    if(field === 'total') return false;
    if(field === 'cacheWrite' && price.cacheWritePolicy === 'free' && price.cacheWritePolicySource === 'official' && (!(price.tiers && price.tiers.length) || u.inputTotalComplete === true)) return false;
    if(field === 'input' || field === 'output' || u.inputTotalComplete !== true) return true;
    return (price.tiers && price.tiers.length ? price.tiers : [price]).some(function(rate){
      if(field === 'cacheRead') return (rate.cacheRead == null ? price.cacheRead : rate.cacheRead) !== rate.input;
      const write = rate.cacheWrite == null ? (price.cacheWrite == null ? (policy === 'input' ? rate.input : policy === 'free' ? 0 : undefined) : price.cacheWrite) : rate.cacheWrite;
      return write !== rate.input;
    });
  })) return undefined;
  // Token-hour cache storage cannot be derived from token counts.
  if(price.cacheStoragePerHour != null && u.cacheCreation > 0) return undefined;
  const banded = (price.tiers && price.tiers.length) || (price.peak && price.peak.peakWindowsUtc && price.peak.peakWindowsUtc.length);
  function rateFor(tier, offPeak, shortOutput){
    const band = price.tiers && price.tiers[tier];
    const scale = offPeak && price.peak ? price.peak.offPeakMultiplier : 1;
    const pick = v => (v == null ? undefined : v*scale);
    // Volcengine discounts the output rate for short replies inside a band; the
    // band records which side of that condition the request fell on.
    const baseOutput = shortOutput && band && band.shortOutput
      ? band.shortOutput.output
      : (band && band.output != null ? band.output : price.output);
    return {
      input: ((band && band.input != null ? band.input : price.input))*scale,
      output: baseOutput*scale,
      cacheRead: pick(band && band.cacheRead != null ? band.cacheRead : price.cacheRead),
      cacheWrite1h: pick(band && band.cacheWrite1h != null ? band.cacheWrite1h : price.cacheWrite1h),
      cacheWrite: pick(band && band.cacheWrite != null ? band.cacheWrite : price.cacheWrite),
      reasoning: pick(band && band.reasoning != null ? band.reasoning : price.reasoning)
    };
  }
  function charge(c, rates){
    if(c.cacheRead > 0 && rates.cacheRead == null) return undefined;
    const write5m = Math.min(c.cacheCreation, c.cacheCreation5m || 0);
    const after5m = Math.max(0, c.cacheCreation - write5m);
    const write1h = Math.min(after5m, c.cacheCreation1h || 0);
    const writeOther = Math.max(0, c.cacheCreation - write5m - write1h);
    const hasTtlBreakdown = c.cacheCreation5m !== undefined || c.cacheCreation1h !== undefined;
    if(price.protocol === 'anthropic' && c.cacheCreation > 0 && (!hasTtlBreakdown || writeOther > 0)) return undefined;
    const writePrice = rates.cacheWrite != null ? rates.cacheWrite : (policy === 'input' ? rates.input : (policy === 'free' ? 0 : undefined));
    const write1hPrice = rates.cacheWrite1h != null ? rates.cacheWrite1h : (price.protocol === 'anthropic' ? rates.input*2 : undefined);
    if((write5m > 0 || writeOther > 0) && writePrice == null) return undefined;
    if(write1h > 0 && write1hPrice == null) return undefined;
    const reasoningRate = rates.reasoning == null ? rates.output : rates.reasoning;
    if(reasoningRate !== rates.output && c.output > 0 && (c.reasoning == null || c.reasoningComplete === false || c.reasoning > c.output)) return undefined;
    const outputCost = c.output*rates.output + (c.reasoning || 0)*(reasoningRate-rates.output);
    return (c.input*rates.input + c.cacheRead*(rates.cacheRead || 0) + write5m*(writePrice || 0) + write1h*(write1hPrice || 0) + writeOther*(writePrice || 0) + outputCost)/M;
  }
  if(banded){
    // Length- and time-tiered rates are chosen per request. Without the per-band
    // split recorded at capture time there is no honest single rate for a total.
    if(!u.bands || !u.bands.length) return undefined;
    // Bands that do not add up to their usage would bill only the part they
    // cover and present the shortfall as a total; that happens whenever an
    // aggregate mixes banded usage with usage captured before banding existed.
    let bi = 0, bo = 0, br = 0, bc = 0;
    for(const band of u.bands){ bi += band.input; bo += band.output; br += band.cacheRead; bc += band.cacheCreation; }
    if(bi !== u.input || bo !== u.output || br !== u.cacheRead || bc !== u.cacheCreation) return undefined;
    let sum = 0;
    for(const band of u.bands){
      const part = charge(band, rateFor(band.tier, band.offPeak, band.shortOutput));
      if(part === undefined) return undefined;
      sum += part;
    }
    return sum;
  }
  return charge(u, { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite, cacheWrite1h:price.cacheWrite1h, reasoning: price.reasoning });
}

return estimateTraceCost;
});
