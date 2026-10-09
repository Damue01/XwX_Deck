import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import type { ModelCatalogEntry } from '@/bridge/types';
import { Badge } from '@/components/ui/badge';
import { ChoiceSelect } from '@/components/ui/choice-select';
import { Check, X } from 'lucide-react';

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

/** Catalog selection stays read-only; manual model entry is an explicit action. */
export function ModelPicker({ id, value, catalog, onChange, disabled, allowEmpty, allowCustomValue, noteFor, dataAttr }: Props): React.ReactElement {
  useLanguage();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const trigger = React.useRef<HTMLDivElement | null>(null);
  const editor = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => editor.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editing]);
  const sorted = React.useMemo(() => [...catalog]
    .sort((a, b) => vendorRank(a.vendor) - vendorRank(b.vendor) || a.id.localeCompare(b.id))
    .map(model => model.id), [catalog]);
  const choices = [...new Set(value && !sorted.includes(value) ? [value, ...sorted] : sorted)];
  let customId = '__xwx_custom_model__';
  while (choices.includes(customId)) customId += '_';
  const finish = () => {
    setEditing(false);
    requestAnimationFrame(() => trigger.current?.querySelector<HTMLButtonElement>('button')?.focus());
  };
  const next = draft.trim();
  const valid = next ? (allowCustomValue?.(next) ?? true) : !!allowEmpty;
  const items = choices.map(mid => {
    const note = noteFor?.(mid);
    return { id: mid, hint: note?.hint, label: <span className="model-choice-content"><span className="model-option-id">{mid}</span>{note && <Badge size="sm" variant="secondary" className="model-note-badge ml-auto font-sans">{note.label}</Badge>}</span> };
  });
  return <div {...dataAttr} data-value={value} className="xwx-combobox" ref={trigger}>
    {editing ? <form className="model-custom-entry" onSubmit={event => { event.preventDefault(); if (valid) { onChange(next); finish(); } }}>
      <input ref={editor} id={id} className="txt-input mono" aria-label={t("模型名称")} value={draft} onChange={event => setDraft(event.target.value)} autoFocus disabled={disabled} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); } }} />
      <button type="submit" className="provider-text-action" aria-label={t("保存模型名称")} disabled={disabled || !valid}><Check size={15} /></button>
      <button type="button" className="provider-text-action" aria-label={t("取消输入模型名称")} onClick={finish}><X size={15} /></button>
    </form> : <ChoiceSelect id={id} label={t("选择模型")} value={value || null} items={[
      ...(allowEmpty ? [{ id: '', label: t('使用默认模型') }] : []), ...items,
      { id: customId, label: t('输入模型名称…') }
    ]} placeholder={t("选择模型")} disabled={disabled} onChange={mid => {
      if (mid === customId) { setDraft(value); setEditing(true); }
      else onChange(mid);
    }} />}
  </div>;
}
