import type {
  ProviderAdapter,
  ProviderConnection,
  ProviderValidationResult
} from '../../shared/providers';
import { resolveCompatibleServiceCodexProtocol } from './codexProtocolPolicy';
import { findOfficialModelRecord } from './officialModelRegistry';

type WireProtocol = Exclude<ProviderAdapter, 'auto'>;
type ProbeKind =
  | 'accepted'
  | 'authentication-error'
  | 'model-error'
  | 'reachable'
  | 'endpoint-missing'
  | 'unavailable';

interface ValidationTarget {
  readonly baseUrl: string;
  readonly protocol: WireProtocol;
  readonly endpoint: string;
}

export interface ProviderValidationPlan {
  readonly primary: ValidationTarget;
  readonly suggestion?: ValidationTarget;
}

const ENDPOINT_PATH: Readonly<Record<WireProtocol, string>> = {
  responses: '/responses',
  'chat-completions': '/chat/completions',
  'anthropic-messages': '/messages'
};

const EMBEDDED_ENDPOINT = /\/(responses(?:\/compact)?|chat\/completions|messages)(?:\/v1)?\/?$/i;
const MODEL_ERROR = /(?:model|endpoint[ _-]?id).*(?:not found|does not exist|invalid|unavailable|permission)|(?:模型|推理接入点).*(?:不存在|无效|不可用|权限)/i;
const ENDPOINT_ERROR = /invalidaction|invalid action|unknown action|no route|route not found|unsupported path|不存在的接口/i;

export async function validateProviderConnection(
  provider: ProviderConnection,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<ProviderValidationResult> {
  const plan = buildProviderValidationPlan(provider);
  const primary = await probe(plan.primary, provider, fetcher, signal);
  if ((primary === 'endpoint-missing' || primary === 'model-error') && plan.suggestion) {
    const suggested = await probe(plan.suggestion, provider, fetcher, signal);
    if (suggested === 'accepted' || suggested === 'reachable' || suggested === 'model-error') {
      return {
        status: 'suggestion',
        providerId: provider.id,
        providerName: provider.displayName,
        suggestedBaseUrl: plan.suggestion.baseUrl,
        suggestedAdapter: plan.suggestion.protocol,
        suggestionReason: 'base-url'
      };
    }
    return resultForProbe(provider, suggested);
  }

  if ((primary === 'endpoint-missing' || primary === 'model-error') && provider.adapter === 'auto') {
    const alternate = alternateOpenAiTarget(plan.primary);
    if (alternate) {
      const alternateResult = await probe(alternate, provider, fetcher, signal);
      if (alternateResult === 'accepted' || alternateResult === 'reachable') {
        return {
          status: 'suggestion',
          providerId: provider.id,
          providerName: provider.displayName,
          suggestedBaseUrl: alternate.baseUrl,
          suggestedAdapter: alternate.protocol,
          suggestionReason: 'protocol'
        };
      }
      if (primary === 'endpoint-missing' && alternateResult === 'model-error') {
        return resultForProbe(provider, alternateResult);
      }
    }
  }

  return resultForProbe(provider, primary);
}

function alternateOpenAiTarget(target: ValidationTarget): ValidationTarget | undefined {
  const protocol = target.protocol === 'responses'
    ? 'chat-completions'
    : target.protocol === 'chat-completions'
      ? 'responses'
      : undefined;
  return protocol ? validationTarget(target.baseUrl, protocol) : undefined;
}

export function buildProviderValidationPlan(provider: ProviderConnection): ProviderValidationPlan {
  const protocol = resolveProtocol(provider);
  const primary = validationTarget(provider.baseUrl, protocol);
  const parsed = new URL(provider.baseUrl);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const match = pathname.match(EMBEDDED_ENDPOINT);
  if (!match || match.index === undefined) return { primary };

  const inferred = protocolFromEndpoint(match[1]);
  parsed.pathname = pathname.slice(0, match.index).replace(/\/+$/, '') || '/';
  const correctedBaseUrl = parsed.toString().replace(/\/+$/, '');
  const suggestion = validationTarget(correctedBaseUrl, inferred);
  return suggestion.endpoint === primary.endpoint ? { primary } : { primary, suggestion };
}

function resolveProtocol(provider: ProviderConnection): WireProtocol {
  if (provider.adapter !== 'auto') return provider.adapter;
  const official = findOfficialModelRecord(provider.codexModel)?.codexRecommendedProtocol;
  if (official) return official;
  if (provider.providerPreset === 'volcengine-ark') return provider.codexApiFormat;
  return resolveCompatibleServiceCodexProtocol(provider.codexModel || 'unknown-model');
}

function protocolFromEndpoint(value: string): WireProtocol {
  const normalized = value.toLowerCase();
  if (normalized.startsWith('chat/')) return 'chat-completions';
  if (normalized === 'messages') return 'anthropic-messages';
  return 'responses';
}

function validationTarget(baseUrl: string, protocol: WireProtocol): ValidationTarget {
  const normalized = baseUrl.replace(/\/+$/, '');
  return { baseUrl: normalized, protocol, endpoint: `${normalized}${ENDPOINT_PATH[protocol]}` };
}

async function probe(
  target: ValidationTarget,
  provider: ProviderConnection,
  fetcher: typeof fetch,
  signal?: AbortSignal
): Promise<ProbeKind> {
  try {
    const response = await fetcher(target.endpoint, {
      method: 'POST',
      headers: target.protocol === 'anthropic-messages'
        ? {
            'content-type': 'application/json',
            'x-api-key': provider.bearerToken,
            'anthropic-version': '2023-06-01'
          }
        : {
            'content-type': 'application/json',
            authorization: `Bearer ${provider.bearerToken}`
          },
      body: JSON.stringify(probeBody(target.protocol, provider.codexModel)),
      redirect: 'manual',
      signal
    });
    const body = (await response.text()).slice(0, 16_384);
    if (response.ok) return 'accepted';
    if (response.status === 401 || response.status === 403) return 'authentication-error';
    if (response.status === 429) return 'reachable';
    if ((response.status === 400 || response.status === 404 || response.status === 422) && MODEL_ERROR.test(body)) return 'model-error';
    if (response.status === 404 || response.status === 405 || ENDPOINT_ERROR.test(body)) return 'endpoint-missing';
    if (response.status === 400 || response.status === 409 || response.status === 422) return 'reachable';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function probeBody(protocol: WireProtocol, model: string): Record<string, unknown> {
  const checkedModel = model.trim() || 'xwx-deck-connection-check';
  if (protocol === 'responses') {
    return { model: checkedModel, input: 'Reply with OK.', max_output_tokens: 1, stream: false };
  }
  return {
    model: checkedModel,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    max_tokens: 1,
    ...(protocol === 'chat-completions' ? { stream: false } : {})
  };
}

function resultForProbe(provider: ProviderConnection, kind: ProbeKind): ProviderValidationResult {
  const status = kind === 'accepted'
    ? 'valid'
    : kind === 'endpoint-missing'
      ? 'unavailable'
      : kind;
  return { status, providerId: provider.id, providerName: provider.displayName };
}
