import * as React from 'react';
import { Tooltip } from '@base-ui/react/tooltip';

/** Keeps secondary instructions on the label, available on hover and focus. */
export function HelpLabel({ children, help }: { children: React.ReactNode; help: string }): React.ReactElement {
  const helpId = React.useId();
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    };
    document.addEventListener('keydown', dismiss, true);
    return () => document.removeEventListener('keydown', dismiss, true);
  }, [open]);
  return <Tooltip.Root open={open} onOpenChange={setOpen}>
    <Tooltip.Trigger render={<span tabIndex={0} />} className="help-label" aria-describedby={helpId} delay={350}>{children}</Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Positioner className="help-label-positioner" side="top" align="start" sideOffset={8} collisionPadding={12}>
      <Tooltip.Popup id={helpId} role="tooltip" className="help-label-popup">{help}</Tooltip.Popup>
    </Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root>;
}
