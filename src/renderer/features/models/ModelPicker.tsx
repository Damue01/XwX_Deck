import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import type { ModelCatalogEntry } from '@/bridge/types';
import { Badge } from '@/components/ui/badge';
import { ChoiceSelect } from '@/components/ui/choice-select';
import { isUnavailableModel, isNonConversationalModel } from '../../../shared/modelAvailability';

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
  /**
   * Annotates a row without blocking it. A model that needs something enabled
   * stays selectable on purpose: choosing it is what offers to enable that
   * thing, so greying it out would leave the user with no way forward.
   */
  readonly noteFor?: (modelId: string) => ModelPickerNote | undefined;
  /** data attribute passthrough for parity with original markup */
  readonly dataAttr?: Record<string, string>;
}

/** Select from discovered models while retaining an explicitly saved selection. */
export function ModelPicker({ id, value, catalog, onChange, disabled, allowEmpty, noteFor, dataAttr }: Props): React.ReactElement {
  useLanguage();
  const sorted = React.useMemo(() => [...catalog]
    .filter(model => !isUnavailableModel(model) && !isNonConversationalModel(model))
    .sort((a, b) => vendorRank(a.vendor) - vendorRank(b.vendor) || a.id.localeCompare(b.id))
    .map(model => model.id), [catalog]);
  const unavailable = catalog.some(model => model.id === value && isUnavailableModel(model));
  const nonConversational = isNonConversationalModel(catalog.find(model => model.id === value) ?? { id: value });
  const choices = [...new Set(value && !unavailable && !nonConversational && !sorted.includes(value) ? [value, ...sorted] : sorted)];
  const items = choices.map(mid => {
    const note = noteFor?.(mid);
    return { id: mid, hint: note?.hint, label: <span className="model-choice-content"><span className="model-option-id">{mid}</span>{note && <Badge size="sm" variant="secondary" className="model-note-badge ml-auto font-sans">{note.label}</Badge>}</span> };
  });
  return <div {...dataAttr} data-value={value} className="xwx-combobox">
    <ChoiceSelect id={id} label={t("选择模型")} menuClassName="model-choice-positioner" value={value || null} selectedLabel={unavailable ? <span className="model-choice-content"><span className="model-option-id">{value}</span><Badge size="sm" variant="secondary" className="model-note-badge ml-auto font-sans">{t('已下线')}</Badge></span> : nonConversational ? <span className="model-option-id">{value}</span> : undefined} items={[
      ...(allowEmpty ? [{ id: '', label: t('使用默认模型') }] : []), ...items
    ]} placeholder={t("选择模型")} disabled={disabled} onChange={onChange} />
  </div>;
}
