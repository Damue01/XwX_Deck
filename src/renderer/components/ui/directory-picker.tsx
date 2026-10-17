import * as React from 'react';
import { t } from '@/lib/i18n';

/** Native directory selection uses the same field for source and destination. */
export function DirectoryPicker({ path, placeholder = '点击选择目录', busy, template, className = '', ...props }:
  Omit<React.ComponentPropsWithoutRef<'button'>, 'children'> & {
    path: string;
    placeholder?: string;
    busy?: boolean;
    template?: boolean;
  }): React.ReactElement {
  return <button type="button" {...props} className={`dir-input ${className}`} title={path || t(placeholder)} aria-busy={busy}>
    <span className={`dir-input-text${!path ? ' placeholder' : template ? ' workspace-template' : ''}`}>
      {busy ? t('选择中…') : path || t(placeholder)}
    </span>
  </button>;
}
