import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { t, useLanguage } from '@/lib/i18n';

/** Shared Key field: one reveal control on WebViews with or without a native eye. */
export function SecretInput({ active, value, className = '', ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> & {
  active: boolean;
  value: string;
}): React.ReactElement {
  useLanguage();
  const [revealed, setRevealed] = React.useState(false);
  const hasValue = value.length > 0;
  React.useEffect(() => { if (!active || !hasValue) setRevealed(false); }, [active, hasValue]);
  const visible = active && hasValue && revealed;
  return <div className="secret-input" data-has-value={hasValue || undefined}>
    <input {...props} className={`txt-input ${className}`} value={value} type={visible ? 'text' : 'password'} />
    {hasValue && <button type="button" className="secret-input-visibility" disabled={props.disabled}
      aria-label={t(visible ? '隐藏 Key' : '显示 Key')} aria-pressed={visible} aria-controls={props.id}
      title={t(visible ? '隐藏 Key' : '显示 Key')}
      onMouseDown={event => event.preventDefault()} onClick={() => setRevealed(current => !current)}>
      <Eye size={16} className="secret-eye-show" aria-hidden="true" /><EyeOff size={16} className="secret-eye-hide" aria-hidden="true" />
    </button>}
  </div>;
}
