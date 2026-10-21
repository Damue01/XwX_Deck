import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { Select } from '@base-ui/react/select';
import { Check, ChevronsUpDown } from 'lucide-react';

export interface ChoiceItem { readonly id: string; readonly label: React.ReactNode; readonly hint?: string; readonly disabled?: boolean; }

/** Button-based selection: never focuses an editable search field. */
export function ChoiceSelect({ id, label, value, items, selectedLabel, placeholder = t('请选择'), disabled, onChange, menuClassName = '', variant = 'field', onOpen, emptyLabel = t('暂无已添加的服务') }: {
  id?: string; label?: string; value: string | null; items: readonly ChoiceItem[];
  placeholder?: string; disabled?: boolean; onChange: (id: string) => void;
  menuClassName?: string;
  selectedLabel?: React.ReactNode;
  variant?: 'field' | 'inline';
  onOpen?: () => void;
  emptyLabel?: string;
}): React.ReactElement {
  useLanguage();
  const [open, setOpen] = React.useState(false);
  const actions = React.useRef<Select.Root.Actions | null>(null);
  React.useEffect(() => {
    // Closing must release focus and pointer capture even in an inactive WebKit window.
    if (!open) actions.current?.unmount();
  }, [open]);
  const selected = items.find(item => item.id === value);
  return <Select.Root open={open} onOpenChange={next => { setOpen(next); if (next) onOpen?.(); }} actionsRef={actions} value={value} onValueChange={next => { if (next !== null) onChange(next); }} disabled={disabled}>
    <Select.Trigger id={id} className={`xwx-choice-trigger${variant === 'inline' ? ' xwx-choice-inline-trigger' : ''}`} aria-label={label} title={selected?.hint}>
      <span className="xwx-choice-value">{selectedLabel ?? selected?.label ?? placeholder}</span><Select.Icon className="xwx-choice-icon"><ChevronsUpDown className="size-4" aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal><Select.Positioner className={`xwx-choice-positioner ${menuClassName}${variant === 'inline' ? ' xwx-choice-inline-positioner' : ''}`} side="bottom" align="end" alignOffset={variant === 'inline' ? -9 : 0} sideOffset={variant === 'inline' ? 3 : 4} alignItemWithTrigger={false} collisionPadding={{ top: 41, right: 5, bottom: 5, left: 5 }}>
      <Select.Popup className="xwx-combobox-popup xwx-choice-popup"><Select.List>
        {items.map(item => <Select.Item className="xwx-combobox-item xwx-choice-item" value={item.id} key={item.id} title={item.hint ?? (variant === 'inline' && typeof item.label === 'string' ? item.label : undefined)} disabled={item.disabled}>
          <Select.ItemIndicator className="xwx-choice-indicator"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
          <Select.ItemText className="xwx-choice-text">{item.label}</Select.ItemText>
        </Select.Item>)}
        {!items.length && <div className="xwx-choice-empty">{emptyLabel}</div>}
      </Select.List></Select.Popup>
    </Select.Positioner></Select.Portal>
  </Select.Root>;
}
