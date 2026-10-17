import * as React from 'react';

/** Quotas start closed in every service. Only an explicit account click opens them. */
export function useAccountExpansion(group: string | null, accounts: readonly { readonly id: string }[]) {
  const [expanded, setExpanded] = React.useState<Record<string, string | null>>({});
  const selected = group ? expanded[group] ?? null : null;
  const expandedId = accounts.some(account => account.id === selected) ? selected : null;
  React.useEffect(() => {
    if (group && selected && expandedId === null) setExpanded(current => ({ ...current, [group]: null }));
  }, [group, selected, expandedId]);
  const toggleAccount = (id: string) => {
    if (group) setExpanded(current => ({ ...current, [group]: current[group] === id ? null : id }));
  };
  return { expandedId, toggleAccount };
}
