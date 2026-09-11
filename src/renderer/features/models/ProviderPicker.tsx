import * as React from 'react';
import { Combobox, ComboboxInput, ComboboxPopup, ComboboxList, ComboboxItem } from '@/components/ui/combobox';
import type { ProviderSnapshot, ProviderClient } from '../../../shared/providers';
import { supportsProviderClient } from '../../../shared/providers';

export function ProviderPicker({ registry, client, disabled, onChange }: {
  registry: ProviderSnapshot | null; client: ProviderClient; disabled?: boolean;
  onChange: (id: string | null) => void;
}): React.ReactElement {
  const items = React.useMemo(() => [
    { id: '', label: '官方订阅' },
    ...(registry?.connections ?? []).filter(p => supportsProviderClient(p, client)).map(p => ({ id: p.id, label: p.displayName }))
  ], [registry, client]);
  return <div className="xwx-combobox">
    <Combobox items={items} value={items.find(p => p.id === (registry?.active[client] ?? '')) ?? items[0]}
      itemToStringLabel={p => p.label} isItemEqualToValue={(a, b) => a.id === b.id}
      onValueChange={p => { if (p) onChange(p.id || null); }} disabled={disabled || !registry}>
      <ComboboxInput size="sm" aria-label={`${client === 'codex' ? 'ChatGPT' : 'Claude'} 服务连接`} />
      <ComboboxPopup className="xwx-combobox-popup"><ComboboxList>
        {(item: { id: string; label: string }) => <ComboboxItem key={item.id} value={item} className="xwx-combobox-item">{item.label}</ComboboxItem>}
      </ComboboxList></ComboboxPopup>
    </Combobox>
  </div>;
}
