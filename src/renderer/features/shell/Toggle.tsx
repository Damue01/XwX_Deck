import * as React from 'react';
import { Switch } from '@/components/ui/switch';

interface Props {
  readonly id?: string;
  readonly className?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly ariaLabel?: string;
  readonly title?: string;
  /** Optional glyph rendered inside the thumb. */
  readonly thumb?: React.ReactNode;
  readonly track?: React.ReactNode;
  readonly onToggle: () => void | Promise<void>;
}

/**
 * COSS Switch wrapper. Base UI's Switch only sets aria-checked, so we also
 * mirror aria-pressed (the packaged smoke test reads aria-pressed) and expose
 * the id/label/title the rest of the app relies on.
 */
export function Toggle({ id, className, checked, disabled, busy, ariaLabel, title, thumb, track, onToggle }: Props): React.ReactElement {
  const [intent, setIntent] = React.useState<boolean | null>(null);
  const request = React.useRef(0);
  const wasBusy = React.useRef(false);
  React.useLayoutEffect(() => {
    if (busy) wasBusy.current = true;
    else if (wasBusy.current) {
      wasBusy.current = false;
      setIntent(null);
    }
  }, [busy]);
  const displayed = busy && intent !== null ? intent : checked;
  return (
    <Switch
      id={id}
      className={className}
      nativeButton
      render={<button type="button" />}
      checked={displayed}
      disabled={disabled || busy}
      aria-pressed={displayed}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      title={title}
      thumb={thumb}
      track={track}
      onCheckedChange={next => {
        const generation = ++request.current;
        setIntent(next);
        const result = onToggle();
        const complete = () => { if (generation === request.current) setIntent(null); };
        if (result) void result.then(complete, complete);
      }}
    />
  );
}
