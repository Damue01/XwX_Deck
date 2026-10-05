export const DEFAULT_UPDATE_SERVER = 'https://github.com/Damue01/XwX_Deck/releases/latest/download';
export const DEFAULT_METADATA_PUSH_SERVER = '';

export function updateServerUrl(): string {
  return String(
    process.env.XWX_DECK_UPDATE_SERVER_URL
    || DEFAULT_UPDATE_SERVER
  ).replace(/\/+$/, '');
}

export function metadataPushUrl(): string {
  return String(
    process.env.XWX_DECK_METADATA_PUSH_URL
    || (DEFAULT_METADATA_PUSH_SERVER ? `${DEFAULT_METADATA_PUSH_SERVER}/events` : '')
  ).replace(/\/+$/, '');
}
