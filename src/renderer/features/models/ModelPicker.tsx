import * as React from 'react';
import type { ModelCatalogEntry } from '@/bridge/types';
import {
  Combobox,
  ComboboxInput,
  ComboboxPopup,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from '@/components/ui/combobox';

const VENDOR_ORDER = ['Anthropic', 'DeepSeek', 'Google', 'Kimi', 'MiniMax', 'OpenAI', 'xAI', '阿里百炼', '火山方舟', '智谱', '已配置', '其他'];

function vendorRank(vendor: string): number {
  const i = VENDOR_ORDER.indexOf(vendor);
  return i === -1 ? VENDOR_ORDER.length : i;
}

interface Props {
  readonly id?: string;
  readonly value: string;
  readonly catalog: readonly ModelCatalogEntry[];
  readonly onChange: (modelId: string) => void;
  readonly disabled?: boolean;
  readonly allowCustomValue?: (modelId: string) => boolean;
  /** data attribute passthrough for parity with original markup */
  readonly dataAttr?: Record<string, string>;
}

/**
 * Model selector built on the COSS Combobox interaction core, restyled to the
 * XwX paper aesthetic (see `.xwx-combobox-*` overrides in styles.css).
 * Search + free-text custom model entry preserved; list shows model id only.
 */
export function ModelPicker({
  id,
  value,
  catalog,
  onChange,
  disabled,
  allowCustomValue,
  dataAttr
}: Props): React.ReactElement {
  const [query, setQuery] = React.useState('');

  const sorted = React.useMemo(
    () => [...catalog]
      .sort((a, b) => vendorRank(a.vendor) - vendorRank(b.vendor) || a.id.localeCompare(b.id))
      .map(model => model.id),
    [catalog],
  );

  const lower = query.trim().toLowerCase();
  const filtered = lower ? sorted.filter(id => id.toLowerCase().includes(lower)) : sorted;
  const customValue = query.trim();
  const showCustom = !!customValue
    && !filtered.some(id => id.toLowerCase() === lower)
    && (allowCustomValue?.(customValue) ?? true);
  const items = showCustom ? [...filtered, query.trim()] : filtered;

  return (
    <div {...dataAttr} data-value={value} className="xwx-combobox">
      <Combobox<string>
        items={items}
        value={value}
        onValueChange={next => { const v = (next ?? '').trim(); if (v) onChange(v); }}
        onInputValueChange={(next, eventDetails) => {
          if (eventDetails.reason === 'input-change') setQuery(next);
        }}
        onOpenChange={open => { if (!open) setQuery(''); }}
        disabled={disabled}
      >
        <ComboboxInput id={id} size="sm" placeholder="搜索或输入模型名…" />
        <ComboboxPopup className="xwx-combobox-popup">
          <ComboboxList>
            {filtered.map(mid => (
              <ComboboxItem key={mid} value={mid} className="xwx-combobox-item">
                <span>{mid}</span>
              </ComboboxItem>
            ))}
            {showCustom && (
              <ComboboxItem value={query.trim()} className="xwx-combobox-item">使用 “{query.trim()}”</ComboboxItem>
            )}
            <ComboboxEmpty>没有匹配的模型，可直接输入自定义名</ComboboxEmpty>
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
