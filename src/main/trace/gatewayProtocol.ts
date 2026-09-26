declare const __XWX_GATEWAY_BUILD_ID__: string | undefined;

/**
 * Bump this value whenever a packaged manager must not keep executing an
 * already-running Gateway helper from an older application build.
 *
 * The runtime JSON schema has its own `version`; this protocol version guards
 * control/API compatibility, while GATEWAY_HELPER_BUILD_ID ensures a new
 * package never keeps executing helper code from another runtime build.
 */
// Bump for helper control/schema compatibility changes. Runtime behavior is
// additionally pinned to the source fingerprint below, so same-protocol
// helpers from another package build are also replaced safely.
export const GATEWAY_HELPER_PROTOCOL_VERSION = 14;
const injectedGatewayBuildId = typeof __XWX_GATEWAY_BUILD_ID__ === 'string'
  ? __XWX_GATEWAY_BUILD_ID__.trim().toLowerCase()
  : '';
export const GATEWAY_HELPER_BUILD_ID = /^[0-9a-f]{64}$/.test(injectedGatewayBuildId)
  ? injectedGatewayBuildId
  : `development-v${GATEWAY_HELPER_PROTOCOL_VERSION}`;

export interface GatewayTraceRetention {
  /** Zero means unlimited. */
  readonly maxSessions: number;
  /** Zero means unlimited. */
  readonly maxStorageBytes: number;
  /** Persist token/cost aggregates without detailed request/response traces. */
  readonly usageOnly?: boolean;
}

export type GatewayCapturedClient = 'claude-cli' | 'codex-cli';
