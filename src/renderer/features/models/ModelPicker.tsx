import * as React from 'react';
import type { ModelCatalogEntry } from '@/bridge/types';
import { Badge } from '@/components/ui/badge';
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

/**
 * A short annotation carried by a single row. Capability facts belong to the
 * model, so they are shown next to the model instead of behind a dialog that
 * interrupts an unrelated operation.
 */
export interface ModelPickerNote {
  /** Badge text rendered at the end of the row. */
  readonly label: string;
  /** Full explanation, surfaced as the row title. */
  readonly hint: string;
}

interface Props {
  readonly id?: string;
  readonly value: string;
  readonly catalog: readonly ModelCatalogEntry[];
  readonly onChange: (modelId: string) => void;
  readonly disabled?: boolean;
  /** Persist an explicitly emptied input for optional model selections. */
  readonly allowEmpty?: boolean;
  readonly allowCustomValue?: (modelId: string) => boolean;
  /**
   * Annotates a row without blocking it. A model that needs something enabled
   * stays selectable on purpose: choosing it is what offers to enable that
   * thing, so greying it out would leave the user with no way forward.
   */
  readonly noteFor?: (modelId: string) => ModelPickerNote | undefined;
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
  allowEmpty,
  allowCustomValue,
  noteFor,
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
          if (eventDetails.reason === 'input-change') {
            setQuery(next);
            if (allowEmpty && value && !next.trim()) onChange('');
          }
        }}
        onOpenChange={open => { if (!open) setQuery(''); }}
        disabled={disabled}
      >
        <ComboboxInput id={id} size="sm" placeholder="搜索或输入模型名…" />
        <ComboboxPopup className="xwx-combobox-popup">
          <ComboboxList>
            {filtered.map(mid => {
              const note = noteFor?.(mid);
              return (
                <ComboboxItem key={mid} value={mid} className="xwx-combobox-item" title={note?.hint}>
                  <span className="model-choice-content">
                    <span className="model-option-id">{mid}</span>
                    {note ? (
                      <Badge size="sm" variant="secondary" className="model-note-badge ml-auto font-sans">
                        {note.label}
                      </Badge>
                    ) : null}
                  </span>
                </ComboboxItem>
              );
            })}
            {showCustom && (
              <ComboboxItem value={query.trim()} className="xwx-combobox-item">使用 “{query.trim()}”</ComboboxItem>
            )}
            <ComboboxEmpty>没有匹配的模型</ComboboxEmpty>
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
