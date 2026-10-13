import modelsDevSource from '../../shared/models-dev.browser.js?raw';
import tracePricingSource from '../../shared/trace-pricing.browser.js?raw';
import formatBytesSource from '../../shared/format-bytes.browser.js?raw';
import webviewCommonSource from './common.browser.js?raw';
import traceCacheRateSource from '../../shared/trace-cache-rate.browser.js?raw';
import traceUsageSource from '../../shared/trace-usage.browser.js?raw';
import traceCostSource from '../../shared/trace-cost.browser.js?raw';

/**
 * Return the browser helper as source text without passing it through the
 * main-process minifier. Serialising a compiled function with `toString()` is
 * unsafe: esbuild's keep-names transform may leave references to bundle-only
 * helper identifiers inside the serialised function.
 */
export function webviewCommonScript(): string {
  return modelsDevSource + '\n' + tracePricingSource + '\n' + formatBytesSource + '\n' + traceUsageSource + '\n' + traceCostSource + '\n' + traceCacheRateSource + '\n' + webviewCommonSource;
}
