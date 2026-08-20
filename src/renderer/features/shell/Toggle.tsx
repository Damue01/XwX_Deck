import * as React from 'react';
import { Switch } from '@/components/ui/switch';

interface Props {
  readonly id?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly ariaLabel?: string;
  readonly title?: string;
  readonly onToggle: () => void;
}

/**
 * COSS Switch wrapper. Base UI's Switch only sets aria-checked, so we also
 * mirror aria-pressed (the packaged smoke test reads aria-pressed) and expose
 * the id/label/title the rest of the app relies on.
 */
export function Toggle({ id, checked, disabled, busy, ariaLabel, title, onToggle }: Props): React.ReactElement {
  return (
    <Switch
      id={id}
      nativeButton
      render={<button type="button" />}
      checked={checked}
      disabled={disabled || busy}
      aria-pressed={checked}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      title={title}
      onCheckedChange={() => onToggle()}
    />
  );
}
