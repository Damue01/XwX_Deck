import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { Select } from '@base-ui/react/select';
import { Check, ChevronsUpDown } from 'lucide-react';

export interface ChoiceItem { readonly id: string; readonly label: React.ReactNode; readonly hint?: string; }

/** Button-based selection: never focuses an editable search field. */
export function ChoiceSelect({ id, label, value, items, placeholder = t('请选择'), disabled, onChange }: {
  id?: string; label?: string; value: string | null; items: readonly ChoiceItem[];
  placeholder?: string; disabled?: boolean; onChange: (id: string) => void;
}): React.ReactElement {
  useLanguage();
  const selected = items.find(item => item.id === value);
  return <Select.Root value={value} onValueChange={next => { if (next !== null) onChange(next); }} disabled={disabled}>
    <Select.Trigger id={id} className="xwx-choice-trigger" aria-label={label}>
      <span className="xwx-choice-value">{selected?.label ?? placeholder}</span><Select.Icon><ChevronsUpDown size={15} aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal><Select.Positioner className="xwx-choice-positioner" side="bottom" align="end" sideOffset={4} alignItemWithTrigger={false} collisionPadding={{ top: 41, right: 5, bottom: 5, left: 5 }}>
      <Select.Popup className="xwx-combobox-popup xwx-choice-popup"><Select.List>
        {items.map(item => <Select.Item className="xwx-combobox-item xwx-choice-item" value={item.id} key={item.id} title={item.hint}>
          <Select.ItemIndicator className="xwx-choice-indicator"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
          <Select.ItemText className="xwx-choice-text">{item.label}</Select.ItemText>
        </Select.Item>)}
        {!items.length && <div className="xwx-choice-empty">{t("暂无已添加的服务")}</div>}
      </Select.List></Select.Popup>
    </Select.Positioner></Select.Portal>
  </Select.Root>;
}
