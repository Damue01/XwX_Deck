import { t, getLanguage, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { ChoiceSelect } from '@/components/ui/choice-select';
import type { ProviderSnapshot, ProviderClient } from '../../../shared/providers';
import { groupSubscriptionConnections, subscriptionPlatformForAccount, subscriptionServiceNames } from '@/lib/subscriptionServices';
import { supportsProviderClient } from '../../../shared/providers';

export function ProviderPicker({ registry, client, clientLabel, disabled, value, onChange }: {
  registry: ProviderSnapshot | null; client: ProviderClient; disabled?: boolean;
  value?: string | null; clientLabel?: string;
  onChange: (id: string | null) => void;
}): React.ReactElement {
  useLanguage();
  const selectedId = (value !== undefined ? value : registry?.active[client]) ?? '';
  const external = selectedId === '__external__';
  const officialConnection = registry?.connections.find(p => p.id === selectedId && p.subscriptionAccountId?.startsWith('official-chatgpt'));
  const lastOfficialId = React.useRef<string | undefined>(undefined);
  React.useEffect(() => { if (officialConnection) lastOfficialId.current = officialConnection.id; }, [officialConnection]);
  const items = React.useMemo(() => {
    const providers = (registry?.connections ?? []).filter(p => supportsProviderClient(p, client));
    const channels = groupSubscriptionConnections(providers, selectedId, true);
    const rememberedOfficial = officialConnection ?? providers.find(p => p.id === lastOfficialId.current && p.subscriptionAccountId?.startsWith('official-chatgpt'));
    const grouped = channels.map(channel => {
      const p = channel.subscriptionAccountId?.startsWith('official-chatgpt') && rememberedOfficial ? rememberedOfficial : channel;
      return ({
      id: p.id,
      label: p.subscriptionAccountId ? t(subscriptionPlatformForAccount(p.subscriptionAccountId) === 'chatgpt' ? p.subscriptionAccountId.startsWith('official-chatgpt') ? 'ChatGPT 官方登录' : 'ChatGPT API 授权' : subscriptionServiceNames[subscriptionPlatformForAccount(p.subscriptionAccountId)]) : p.displayName
    }); });
    return [
    ...(external ? [{ id: '__external__', label: t('外部配置') }] : []),
    ...grouped
  ]; }, [registry, client, external, selectedId, officialConnection, getLanguage()]);
  const label = clientLabel ?? (client === 'codex' ? 'ChatGPT' : 'Claude');
  const knownItem = items.find(item => item.id === selectedId);
  return <div className="xwx-combobox provider-choice" data-missing={registry && selectedId && !knownItem ? '' : undefined}>
    <ChoiceSelect items={items} value={selectedId || null} label={t("{0} 使用的模型服务", label)}
      placeholder={selectedId ? t('所选服务已移除') : t('选择模型服务')}
      onChange={id => { if (id !== '__external__') onChange(id === '__official__' ? null : id); }} disabled={disabled || !registry} />
  </div>;
}
