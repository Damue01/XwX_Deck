import * as React from 'react';
import { Trash2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import { showErrorToast } from '@/lib/toast';
import { useConfirm, type ConfirmOptions } from './confirm-dialog';

/** One deletion control and confirmation flow for saved configurations. */
export function ConfigurationDeleteAction({ confirmation, onDelete, beforeConfirm, disabled, id }: {
  confirmation: ConfirmOptions;
  onDelete: () => Promise<void>;
  beforeConfirm?: () => boolean;
  disabled?: boolean;
  id?: string;
}): React.ReactElement {
  const confirm = useConfirm();
  const pending = React.useRef(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = React.useState(false);
  const remove = async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    try {
      if (beforeConfirm && !beforeConfirm()) return;
      if (!await confirm({ ...confirmation, returnFocus: trigger, confirmText: t('删除'), tone: 'danger' })) return;
      setBusy(true);
      await onDelete();
    } catch (error) { showErrorToast(t('删除配置失败'), error); }
    finally { pending.current = false; setBusy(false); }
  };
  return <button ref={trigger} id={id} type="button" className="provider-text-action configuration-destructive"
    disabled={disabled || busy} aria-busy={busy} onClick={() => void remove()}>
    <Trash2 size={16} aria-hidden="true" />
    {t(busy ? '删除中…' : '删除配置')}
  </button>;
}
