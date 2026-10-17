import type * as React from 'react';
import { RefreshCw } from 'lucide-react';

/** Shared busy/disabled feedback for icon-only refresh actions. */
export function RefreshButton({ busy, label, size = 16, disabled, className = 'configuration-close', ...props }: Omit<React.ComponentProps<'button'>, 'children' | 'aria-busy'> & {
  busy: boolean;
  label: string;
  size?: number;
}): React.ReactElement {
  return <button {...props} type="button" className={className} aria-label={label} title={props.title ?? label} aria-busy={busy} disabled={disabled || busy}>
    <RefreshCw size={size} className={busy ? 'configuration-refresh-spinner' : undefined} aria-hidden="true" />
  </button>;
}
