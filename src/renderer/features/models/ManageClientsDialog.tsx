import type * as React from 'react';
import { AddConfigurationDialog } from '../settings/AddConfigurationDialog';
import type { DownloadClientId } from '../../../shared/clientDownloads';

export function ManageClientsDialog({ open, onOpenChange, finalFocus, onSelect }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: React.RefObject<HTMLButtonElement | null>;
  onSelect: (client: DownloadClientId) => void;
}): React.ReactElement {
  return <AddConfigurationDialog open={open} onOpenChange={onOpenChange} finalFocus={finalFocus}
    clientsOnly manageClients initialTab="clients" onOpenClient={onSelect}
    busy={false} selected={null} onSelect={() => undefined} onBack={() => undefined} editor={null} />;
}
