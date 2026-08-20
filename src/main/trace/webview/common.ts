import webviewCommonSource from './common.browser.js?raw';

/**
 * Return the browser helper as source text without passing it through the
 * main-process minifier. Serialising a compiled function with `toString()` is
 * unsafe: esbuild's keep-names transform may leave references to bundle-only
 * helper identifiers inside the serialised function.
 */
export function webviewCommonScript(): string {
  return webviewCommonSource;
}
