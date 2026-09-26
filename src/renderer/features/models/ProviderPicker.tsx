import * as React from 'react';
import { Combobox, ComboboxInput, ComboboxPopup, ComboboxList, ComboboxItem } from '@/components/ui/combobox';
import type { ProviderSnapshot, ProviderClient } from '../../../shared/providers';
import { supportsProviderClient } from '../../../shared/providers';

export function ProviderPicker({ registry, client, disabled, value, onChange }: {
  registry: ProviderSnapshot | null; client: ProviderClient; disabled?: boolean;
  value?: string | null;
  onChange: (id: string | null) => void;
}): React.ReactElement {
  const selectedId = (value !== undefined ? value : registry?.active[client]) ?? '';
  const external = selectedId === '__external__';
  const items = React.useMemo(() => [
    ...(external ? [{ id: '__external__', label: '外部配置' }] : []),
    { id: '', label: '官方订阅' },
    ...(registry?.connections ?? []).filter(p => supportsProviderClient(p, client)).map(p => ({ id: p.id, label: p.displayName }))
  ], [registry, client, external]);
  const clientLabel = client === 'codex' ? 'ChatGPT' : 'Claude';
  const selectedItem = items.find(item => item.id === selectedId)
    ?? { id: selectedId, label: '所选服务已移除' };
  return <div className="xwx-combobox">
    <Combobox items={items} value={selectedItem}
      itemToStringLabel={p => p.label} isItemEqualToValue={(a, b) => a.id === b.id}
      onValueChange={p => { if (p && p.id !== '__external__') onChange(p.id || null); }} disabled={disabled || !registry}>
      <ComboboxInput size="sm" aria-label={`${clientLabel} 使用的模型服务`} />
      <ComboboxPopup className="xwx-combobox-popup"><ComboboxList>
        {(item: { id: string; label: string }) => <ComboboxItem key={item.id} value={item} className="xwx-combobox-item">{item.label}</ComboboxItem>}
      </ComboboxList></ComboboxPopup>
    </Combobox>
  </div>;
}
