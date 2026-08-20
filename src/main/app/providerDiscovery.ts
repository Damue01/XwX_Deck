export type ProviderAuthFamily =
  | 'bearer'
  | 'anthropic-api-key'
  | 'google-api-key'
  | 'azure-api-key'
  | 'oauth'
  | 'aws-sigv4'
  | 'custom-headers';

export type ProviderProtocolFamily =
  | 'openai-responses'
  | 'chat-completions'
  | 'anthropic-messages'
  | 'gemini-native';

export interface ProviderCompatibilityDimensions {
  readonly authentication: readonly ProviderAuthFamily[];
  readonly protocols: readonly ProviderProtocolFamily[];
  readonly supportsFullEndpointUrl: boolean;
  readonly supportsVersionedBaseUrl: boolean;
  readonly supportsCustomModelUrl: boolean;
}

/**
 * Internal compatibility contract. The UI intentionally does not expose these
 * switches; adapters resolve them from the URL, model directory and responses.
 */
export const PROVIDER_COMPATIBILITY_DIMENSIONS: ProviderCompatibilityDimensions = {
  authentication: [
    'bearer',
    'anthropic-api-key',
    'google-api-key',
    'azure-api-key',
    'oauth',
    'aws-sigv4',
    'custom-headers'
  ],
  protocols: [
    'openai-responses',
    'chat-completions',
    'anthropic-messages',
    'gemini-native'
  ],
  supportsFullEndpointUrl: true,
  supportsVersionedBaseUrl: true,
  supportsCustomModelUrl: true
};

const COMPATIBILITY_SUFFIXES = [
  '/api/claudecode',
  '/api/anthropic',
  '/apps/anthropic',
  '/api/coding',
  '/claudecode',
  '/anthropic',
  '/step_plan',
  '/coding',
  '/claude'
] as const;

const FULL_ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/responses/compact',
  '/responses',
  '/messages',
  '/models'
] as const;

/**
 * Generate read-only model-list candidates from one user-entered URL.
 *
 * The order is intentional:
 * 1. preserve an existing version root (`/v1`, `/api/.../v4`) and add `/models`;
 * 2. derive `/v1/models` from a full request endpoint;
 * 3. try the conventional `/v1/models`;
 * 4. strip common Anthropic/coding compatibility suffixes and retry from root.
 */
export function buildProviderModelUrlCandidates(value: string): string[] {
  const url = parseProviderUrl(value);
  if (!url) return [];
  const origin = url.origin;
  const pathname = normalizePath(url.pathname);
  const candidates: string[] = [];

  const fullEndpointRoot = stripFullEndpoint(pathname);
  if (fullEndpointRoot !== undefined) {
    const versionRoot = stripAfterVersionSegment(fullEndpointRoot);
    if (versionRoot) candidates.push(`${origin}${versionRoot}/models`);
    else candidates.push(`${origin}${normalizePath(fullEndpointRoot)}/v1/models`);
  } else if (endsWithVersionSegment(pathname)) {
    candidates.push(`${origin}${pathname}/models`);
    if (!/\/v1$/i.test(pathname)) candidates.push(`${origin}${pathname}/v1/models`);
  } else {
    candidates.push(`${origin}${pathname}/v1/models`);
    candidates.push(`${origin}${pathname}/models`);
  }

  const strippedCompatibilityRoot = stripCompatibilitySuffix(pathname);
  if (strippedCompatibilityRoot !== undefined) {
    const root = normalizePath(strippedCompatibilityRoot);
    candidates.push(`${origin}${root}/v1/models`);
    candidates.push(`${origin}${root}/models`);
  }

  return uniqueUrls(candidates);
}

export function providerUrlEndsWithVersionRoot(value: string): boolean {
  const url = parseProviderUrl(value);
  return !!url && endsWithVersionSegment(normalizePath(url.pathname));
}

function parseProviderUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\/+$/, '');
  return normalized && normalized !== '/' ? normalized : '';
}

function endsWithVersionSegment(pathname: string): boolean {
  const segment = pathname.split('/').filter(Boolean).at(-1) ?? '';
  return /^v\d+(?:beta\d*)?$/i.test(segment);
}

function stripAfterVersionSegment(pathname: string): string | undefined {
  const segments = pathname.split('/').filter(Boolean);
  let versionIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (/^v\d+(?:beta\d*)?$/i.test(segments[index])) {
      versionIndex = index;
      break;
    }
  }
  return versionIndex >= 0 ? `/${segments.slice(0, versionIndex + 1).join('/')}` : undefined;
}

function stripFullEndpoint(pathname: string): string | undefined {
  const lower = pathname.toLowerCase();
  const suffix = FULL_ENDPOINT_SUFFIXES.find(candidate => lower.endsWith(candidate));
  return suffix ? pathname.slice(0, pathname.length - suffix.length) : undefined;
}

function stripCompatibilitySuffix(pathname: string): string | undefined {
  const lower = pathname.toLowerCase();
  const suffix = COMPATIBILITY_SUFFIXES.find(candidate => lower.endsWith(candidate));
  return suffix ? pathname.slice(0, pathname.length - suffix.length) : undefined;
}

function uniqueUrls(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/([^:]\/)\/+/g, '$1');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}
