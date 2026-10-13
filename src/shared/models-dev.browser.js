// Model identity and standard reference prices from one models.dev snapshot.
;(function install(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XwXModelsDev = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const owners = new Set(['anthropic','openai','deepseek','google','xai','moonshotai','alibaba','zhipuai','minimax','volcengine','xiaomi','mistral','cohere','ai21','inception','longcat','stepfun','bailing','tencent','meta']);
  const ownerId = id => ({zai:'zhipuai','bytedance-seed':'volcengine',meituan:'longcat','moonshotai-cn':'moonshotai','alibaba-cn':'alibaba','google-vertex':'google'}[id] || id);
  const norm = id => String(id || '').trim().replace(/^models\//i, '').toLowerCase();
  const bare = id => norm(id).split('/').pop();
  const key = id => bare(id).replace(/[^a-z0-9]/g, '');
  function undated(id) {
    const value = norm(id), match = /[-_](\d{6}|20\d{6})$/.exec(value);
    if (!match) return value;
    const digits = match[1], year = digits.length === 6 ? 2000 + Number(digits.slice(0,2)) : Number(digits.slice(0,4));
    const month = Number(digits.slice(-4,-2)), day = Number(digits.slice(-2));
    const date = new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month-1 && date.getUTCDate() === day ? value.slice(0,match.index) : value;
  }
  function findModelReference(model, rows) {
    const id = norm(model);
    if (!id) return undefined;
    const names = row => [row.modelId || row.tokens?.[0], row.canonicalModelId, ...(row.aliases || [])].filter(Boolean).map(norm);
    for (let level = 0; level < 4; level++) {
      const matches = rows.filter(row => !( !row.canonicalModelId && String(row.modelId || row.tokens?.[0] || '').includes('/') && !id.includes('/') ) && (level === 0 ? [norm(row.modelId || row.tokens?.[0]),norm(row.canonicalModelId)] : names(row)).some(name => level <= 1 ? (name === id || (!id.includes('/') && bare(name) === id)) : level === 2 ? key(name) === key(id) : key(undated(name)) === key(undated(id)) && (undated(name) !== name || undated(id) !== id)));
      if (!matches.length) continue;
      const best = Math.min(...matches.map(row => row.referencePriority || 0));
      const preferred = matches.filter(row => (row.referencePriority || 0) === best);
      const canonical = new Set(preferred.map(row => norm(row.canonicalModelId || row.modelId || row.tokens?.[0])));

      if (canonical.size !== 1) return undefined;
      return preferred[0];
    }
    return undefined;
  }
  function modelReferenceIdentity(provider,id,canonical) {
    const target = norm(canonical || ownerId(provider)+'/'+id);
    const owner = ownerId(target.split('/')[0]);
    const priority = !canonical && !owners.has(ownerId(provider)) ? 99 : ownerId(provider) === owner ? 0 : /^(amazon-bedrock|aws-bedrock|bedrock)$/.test(provider) ? 1 : /^(azure|azure-cognitive-services)$/.test(provider) ? 2 : 99;
    return {canonicalModelId:target, aliases:[target,bare(target)],referencePriority:priority};
  }
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  function rates(cost) {
    if (!cost || !finite(cost.input) || !finite(cost.output)) return undefined;
    const out = { input:cost.input, output:cost.output };
    for (const [field,source] of Object.entries({cacheRead:'cache_read',cacheWrite:'cache_write',cacheWrite1h:'cache_write_1h',reasoning:'reasoning',inputAudio:'input_audio',outputAudio:'output_audio'})) if (finite(cost[source])) out[field]=cost[source];
    return out;
  }
  function parseModelsDevReferencePrices(data) {
    const entries = [], ids = new Map();
    for (const [provider,p] of Object.entries(data || {})) for (const [id,model] of Object.entries(p.models || {})) {
      const canonical = norm(model.canonical_model_id || (owners.has(ownerId(provider)) ? ownerId(provider)+'/'+id : ''));
      entries.push({ provider,id,model,canonical });
      if (canonical) { if (!ids.has(norm(id))) ids.set(norm(id),new Set()); ids.get(norm(id)).add(canonical); }
    }
    const groups = new Map();
    for (const entry of entries) {
      if (!entry.canonical && ids.get(norm(entry.id))?.size === 1) entry.canonical = [...ids.get(norm(entry.id))][0];
      if (!entry.canonical) continue;
      if (!groups.has(entry.canonical)) groups.set(entry.canonical,[]);
      groups.get(entry.canonical).push(entry);
    }
    const rules = [];
    for (const [canonical,group] of groups) {
      const owner = ownerId(canonical.split('/')[0]);
      const priority = p => ownerId(p) === owner ? 0 : /^(amazon-bedrock|aws-bedrock|bedrock)$/.test(p) ? 1 : /^(azure|azure-cognitive-services)$/.test(p) ? 2 : 99;
      const entry = group.filter(e => priority(e.provider)<99 && rates(e.model.cost)).sort((a,b) => priority(a.provider)-priority(b.provider) || Number(a.provider!==owner)-Number(b.provider!==owner) || a.id.localeCompare(b.id))[0];
      if (!entry) continue;
      const price = rates(entry.model.cost);
      if (Array.isArray(entry.model.cost.tiers) && entry.model.cost.tiers.length) {
        const tiers=[{fromInputTokens:0,...price}];let valid=true;
        for(const raw of entry.model.cost.tiers){const r=rates(raw);if(!r || raw.tier?.type!=='context' || !Number.isSafeInteger(raw.tier.size) || raw.tier.size<=0){valid=false;break;}tiers.push({fromInputTokens:raw.tier.size+1,...r});}
        tiers.sort((a,b)=>a.fromInputTokens-b.fromInputTokens);
        if(!valid || tiers.some((t,i)=>i && t.fromInputTokens===tiers[i-1].fromInputTokens)) continue;
        price.tiers=tiers;
      }
      // Keep provider aliases as identity evidence, never as alternative prices.
      rules.push({...price,tokens:[norm(entry.id)],modelId:norm(entry.id),canonicalModelId:canonical,aliases:[...new Set([canonical,canonical.split('/').pop(),...group.map(e=>norm(e.id))])],match:'exact',protocol:owner==='anthropic'?'anthropic':'openai',providerId:entry.provider,source:'models.dev',referencePriority:priority(entry.provider),referenceOnly:true});
    }
    return rules.sort((a,b)=>a.canonicalModelId.localeCompare(b.canonicalModelId));
  }
  return { modelReferenceIdentity, findModelReference, parseModelsDevReferencePrices, modelIdentityKey:key, modelIdentityWithoutDate:undated };
});
