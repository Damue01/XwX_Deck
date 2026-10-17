import type * as React from 'react';
import { ChevronRight } from 'lucide-react';

type Identity = { label: string; email?: string };

export function AccountIdentity({ label, email }: Identity): React.ReactElement {
  return <span className="subscription-account-identity"><strong title={label}>{label}</strong>{email && email !== label && <span title={email}>{email}</span>}</span>;
}

export function AccountDisclosure({ account, expanded, controls, onToggle }: {
  account: Identity; expanded: boolean; controls: string; onToggle: () => void;
}): React.ReactElement {
  return <button type="button" className="account-disclosure" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
    <AccountIdentity {...account} /><ChevronRight className="disclosure-chevron" aria-hidden="true" />
  </button>;
}
