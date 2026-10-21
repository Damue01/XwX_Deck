export const storageKeys = {theme:'xwx-deck.theme',language:'xwx-deck.language',sidebar:'xwx-deck.sidebar',onboarding:'xwx-deck.onboardingSeen',onboardingProgress:'xwx-deck.onboardingProgress.v1'} as const;
export const historyProviderLabels: Readonly<Record<string,string>> = {xwx_deck:'XwX Deck'};
export type EditionProviderAdapter = never;
export type EditionProviderClient = never;
export interface EditionProviderFields {}
export const providerClients = ['codex','claude'] as const;
export const automaticAdapters: readonly string[] = ['auto'];
export function legacyProviderId(_provider: EditionProviderFields): string { return 'xwx_deck'; }
export function initialConnections(): import('./providers').ProviderConnection[] { return []; }

export type EditionDirectoryKind = never;
export function legacyCatalogProtocol(provider: {adapter?:string}|undefined, entry:import('./model-catalog').ModelCatalogEntry):import('./codex-protocol-policy').CodexProtocol|undefined {return undefined;}

export const editionProviderPresets=[] as const;
export const editionDefaultProviderPreset='deepseek';
