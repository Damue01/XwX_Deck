export type ServiceSwitchingClient = 'codex' | 'claude';
export interface ServiceSwitchingPolicy { readonly enabled: boolean; readonly providerIds: readonly string[]; }
export type ServiceSwitchingConfig = Partial<Record<ServiceSwitchingClient, ServiceSwitchingPolicy>>;
export const EMPTY_SERVICE_SWITCHING_POLICY: ServiceSwitchingPolicy = { enabled: false, providerIds: [] };
