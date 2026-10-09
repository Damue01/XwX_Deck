import * as React from 'react';
import { Check, RefreshCw, Search } from 'lucide-react';
import { t, useLanguage } from '@/lib/i18n';
import { useBridge } from '@/bridge/store';
import { showToast } from '@/lib/toast';
import { modelCatalogFailureMessage } from '../../../shared/modelCatalogError';
import type { ProviderConnection, ProviderValidationResult } from '../../../shared/providers';
import type { ModelCatalogEntry } from '@/bridge/types';

function validationMessage(result: ProviderValidationResult): string {
  switch (result.status) {
    case 'valid': return t('模型请求通过');
    case 'authentication-error': return t('密钥无效或权限不足');
    case 'model-error': return t('此模型不可用');
    case 'reachable': return t('接口可达，尚未验证模型请求');
    case 'suggestion': return t('请核对接口地址和协议，配置未更改');
    default: return t('连接测试未通过，请检查地址或网络后重试');
  }
}

/** Catalog reads are automatic. Model requests remain explicit and never change routing. */
export function ProviderConnectionChecks({ provider, disabled, draftChanged }: {
  provider: ProviderConnection; disabled: boolean; draftChanged: boolean;
}): React.ReactElement {
  useLanguage();
  const { api } = useBridge();
  const [models, setModels] = React.useState<readonly ModelCatalogEntry[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [catalogError, setCatalogError] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [pendingModel, setPendingModel] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, ProviderValidationResult>>({});
  const catalogGeneration = React.useRef(0);
  const testGeneration = React.useRef(0);
  const testLock = React.useRef(false);
  const catalogLock = React.useRef(false);
  const loadModels = React.useCallback(async () => {
    if (catalogLock.current) return;
    const generation = ++catalogGeneration.current;
    catalogLock.current = true; setLoading(true); setCatalogError('');
    try {
      const result = await api.fetchProviderModels({ providerId: provider.id, refresh: true });
      if (generation === catalogGeneration.current) setModels([...new Map(result.map(model => [model.id, model])).values()]);
    } catch (error) {
      if (generation === catalogGeneration.current) setCatalogError(modelCatalogFailureMessage(error));
    } finally {
      if (generation === catalogGeneration.current) { catalogLock.current = false; setLoading(false); }
    }
  }, [api, provider.id, provider.baseUrl, provider.bearerToken, provider.adapter]);
  React.useEffect(() => {
    catalogLock.current = false;
    testLock.current = false; setPendingModel(null); setResults({}); setModels(null); setQuery('');
    void loadModels();
    return () => { catalogGeneration.current++; testGeneration.current++; };
  }, [loadModels, provider.codexModel]);
  async function test(model: string) {
    if (disabled || testLock.current) return;
    if (draftChanged) { showToast(t('请先保存修改，再进行测试'), 'info'); return; }
    const generation = ++testGeneration.current;
    testLock.current = true; setPendingModel(model);
    try {
      const result = await api.validateProvider({ providerId: provider.id, model });
      if (generation !== testGeneration.current || result.status === 'stale') return;
      setResults(previous => ({ ...previous, [model]: result }));
    } catch {
      if (generation === testGeneration.current) setResults(previous => ({ ...previous, [model]: { status: 'unavailable', providerId: provider.id, providerName: provider.displayName } }));
    } finally {
      if (generation === testGeneration.current) { testLock.current = false; setPendingModel(null); }
    }
  }
  const ids = models?.map(model => model.id) ?? [];
  const defaultModel = provider.codexModel || provider.claudeModels.sonnet;
  const retainedModel = defaultModel && !ids.includes(defaultModel) ? defaultModel : null;
  const allModels = retainedModel ? [retainedModel, ...ids] : ids;
  const filterEnabled = allModels.length > 12;
  const effectiveQuery = filterEnabled ? query.trim().toLocaleLowerCase() : '';
  const filteredModels = allModels.filter(id => id.toLocaleLowerCase().includes(effectiveQuery));
  return <section id="provider-models-panel" className="provider-models-panel" role="tabpanel" aria-labelledby="provider-models-tab">
    <div className="provider-models-toolbar">
      <span className="provider-models-count" role="status">{loading && !models ? t('正在读取…') : models ? t('{0} 个模型', ids.length) : t('模型列表')}</span>
      <button id="provider-read-models" type="button" className="configuration-close" aria-label={t('刷新模型列表')} title={t('刷新模型列表')} aria-busy={loading} disabled={disabled || loading} onClick={() => void loadModels()}><RefreshCw size={15} className={loading ? 'configuration-refresh-spinner' : undefined} aria-hidden="true" /></button>
    </div>
    {catalogError && <p className="provider-models-notice" role="status">{catalogError}</p>}
    {filterEnabled && <label className="provider-models-filter"><Search size={15} aria-hidden="true" /><input type="search" aria-label={t('筛选模型')} placeholder={t('筛选模型')} value={query} onChange={event => setQuery(event.target.value)} /></label>}
    <ul className="provider-models-list" aria-label={t('模型列表')} aria-busy={loading}>
      {filteredModels.map(model => {
        const result = results[model];
        const valid = result?.status === 'valid';
        return <li key={model} className="provider-model-row">
          <div className="provider-model-identity"><span className="provider-model-name">{model}</span>{model === retainedModel && !loading && <span className="provider-model-retained">{t('不在目录')}</span>}{result && !valid && <span className="provider-model-error" role="status">{validationMessage(result)}</span>}</div>
          <div className="provider-model-action">{valid && <span className="provider-model-passed" role="status" title={t('模型请求通过')}><Check size={14} aria-hidden="true" />{t('可用')}</span>}<button type="button" className="provider-text-action" aria-label={t('测试模型 {0}', model)} title={t('测试模型不会改变默认模型')} disabled={disabled || pendingModel !== null} onClick={() => void test(model)}>{t(pendingModel === model ? '测试中…' : '测试')}</button></div>
        </li>;
      })}
      {!loading && !filteredModels.length && <li className="provider-models-empty">{effectiveQuery ? t('没有匹配的模型') : catalogError ? null : t('此服务未公开模型列表')}</li>}
    </ul>
  </section>;
}
