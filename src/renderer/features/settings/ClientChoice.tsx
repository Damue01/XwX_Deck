import type { ComponentProps } from 'react';
import { CLIENT_DOWNLOADS, clientCatalogLabel } from '../../../shared/clientDownloads';
import { ProviderIcon } from './ProviderIcon';

type Props = Omit<ComponentProps<'button'>, 'children'> & {
  client: typeof CLIENT_DOWNLOADS[number];
  configured: boolean;
  selected: boolean;
};

export function ClientChoice({ client, configured, selected, ...props }: Props) {
  return <button {...props} type="button" className="configuration-choice configuration-client-choice" data-unconfigured={!configured || undefined} aria-pressed={selected}>
    <ProviderIcon kind={client.icon} /><span>{clientCatalogLabel(client)}</span>
  </button>;
}
