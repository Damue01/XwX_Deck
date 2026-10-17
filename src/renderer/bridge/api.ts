import type { XwXDeckApi } from './types';
import { createPreviewApi } from './previewApi';

declare global {
  interface Window {
    xwxDeck?: XwXDeckApi;
  }
}

let _api: XwXDeckApi | undefined;

export function getApi(): XwXDeckApi {
  if (!_api) {
    if (window.xwxDeck) _api = window.xwxDeck;
    else if (window.location.protocol === 'http:' || window.location.protocol === 'https:') _api = createPreviewApi();
    else throw new Error('XwX Deck preload bridge is unavailable.');
  }
  return _api;
}

export function isDesktop(): boolean {
  return !!window.xwxDeck;
}
