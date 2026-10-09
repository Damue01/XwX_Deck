import { t, getLanguage, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { ChoiceSelect } from '@/components/ui/choice-select';
import type { ProviderSnapshot, ProviderClient } from '../../../shared/providers';
import { supportsProviderClient } from '../../../shared/providers';

const subscriptionPlatform = (id: string) => id.startsWith('cursor-') ? 'cursor' : id.startsWith('claude-subscription-') ? 'claude' : id.startsWith('copilot-') ? 'copilot' : id.startsWith('grok-') ? 'grok' : 'chatgpt';
const subscriptionNames = { chatgpt: 'ChatGPT 订阅', claude: 'Claude 订阅', copilot: 'GitHub Copilot 订阅', grok: 'Grok 订阅', cursor: 'Cursor 订阅' };
export function ProviderPicker({ registry, client, disabled, value, onChange }: {
  registry: ProviderSnapshot | null; client: ProviderClient; disabled?: boolean;
  value?: string | null;
  onChange: (id: string | null) => void;
}): React.ReactElement {
  useLanguage();
  const selectedId = (value !== undefined ? value : registry?.active[client]) ?? '';
  const external = selectedId === '__external__';
  const items = React.useMemo(() => {
    const seen = new Set<string>();
    const providers = (registry?.connections ?? []).filter(p => supportsProviderClient(p, client));
    const grouped = providers.filter(p => {
      if (!p.subscriptionAccountId) return true;
      const platform = subscriptionPlatform(p.subscriptionAccountId);
      const selected = providers.find(item => item.id === selectedId && item.subscriptionAccountId && subscriptionPlatform(item.subscriptionAccountId) === platform);
      if (selected && p.id !== selected.id) return false;
      if (seen.has(platform)) return false;
      seen.add(platform); return true;
    }).map(p => ({ id: p.id, label: p.subscriptionAccountId ? subscriptionNames[subscriptionPlatform(p.subscriptionAccountId)] : p.displayName }));
    return [
    ...(external ? [{ id: '__external__', label: t('外部配置') }] : []),
    ...grouped
  ]; }, [registry, client, external, selectedId, getLanguage()]);
  const clientLabel = client === 'codex' ? 'ChatGPT' : 'Claude';
  const knownItem = items.find(item => item.id === selectedId);
  return <div className="xwx-combobox provider-choice" data-missing={registry && selectedId && !knownItem ? '' : undefined}>
    <ChoiceSelect items={items} value={selectedId || null} label={t("{0} 使用的模型服务", clientLabel)}
      placeholder={selectedId ? t('所选服务已移除') : t('选择模型服务')}
      onChange={id => { if (id !== '__external__') onChange(id); }} disabled={disabled || !registry} />
  </div>;
}
