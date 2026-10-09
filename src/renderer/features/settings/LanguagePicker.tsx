import * as React from 'react';
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { LANGUAGES, isLanguage, t, type Language } from '@/lib/i18n';

/** A quiet current-language value with the same accessible menu as model selection. */
export function LanguagePicker({ value, busy, onChange }: {
  readonly value: Language;
  readonly busy: boolean;
  readonly onChange: (language: Language) => void;
}): React.ReactElement {
  const selected = LANGUAGES.find(item => item.id === value)!;
  return <Select.Root value={value} disabled={busy} onValueChange={next => { if (isLanguage(next)) onChange(next); }}>
    <Select.Trigger id="applicationLanguage" className="language-value" aria-label={`${t('语言')}: ${selected.name}`} aria-busy={busy}>
      <span lang={value}>{selected.name}</span><Select.Icon><ChevronDown size={12} aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal><Select.Positioner className="xwx-choice-positioner" side="bottom" align="end" sideOffset={6} alignItemWithTrigger={false} collisionPadding={{ top: 41, right: 5, bottom: 5, left: 5 }}>
      <Select.Popup className="xwx-combobox-popup xwx-choice-popup language-menu"><Select.List>
        {LANGUAGES.map(item => <Select.Item className="xwx-combobox-item xwx-choice-item" key={item.id} value={item.id}>
          <Select.ItemIndicator className="xwx-choice-indicator"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
          <Select.ItemText className="xwx-choice-text"><span lang={item.id}>{item.name}</span></Select.ItemText>
        </Select.Item>)}
      </Select.List></Select.Popup>
    </Select.Positioner></Select.Portal>
  </Select.Root>;
}
