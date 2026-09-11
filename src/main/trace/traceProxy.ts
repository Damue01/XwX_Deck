import { TapClientRoute, TapRoute, TapTraceRecord } from './types';
import { ViewerHandler } from './tapProxy';
import type { GatewayCapturedClient } from './gatewayProtocol';
import type { GatewayTraceRetention } from './gatewayProtocol';

export interface TraceProxy {
  setRecordingEnabled(enabled: boolean): void;
  isRecordingEnabled(): boolean;
  markCodexProviderTransition(source: 'official' | 'compatible' | `provider:${string}`, target: 'official' | 'compatible' | `provider:${string}`): Promise<void>;
  adoptCodexProviderOnStartup(target: 'official' | 'compatible' | `provider:${string}`): Promise<boolean>;
  repairCodexHistoryForProvider(target: 'official' | 'compatible' | `provider:${string}`): Promise<{
    changedFiles: number;
    removedItems: number;
    removedUnencryptedReasoningItems?: number;
    normalizedMessageIds?: number;
    backupRoot?: string;
  }>;
  restoreLegacyOfficialHistory(): Promise<{
    changedFiles: number;
    restoredItems: number;
    backupRoot?: string;
  }>;
  setViewerHandler(handler: ViewerHandler | undefined): void;
  broadcastTrace(trace: TapTraceRecord): void;
  broadcastReset(): void;
  start(): Promise<string>;
  stop(): Promise<void>;
  forceStop(): Promise<void>;
  activeRequestCount(): number;
  pendingContinuationCount(): number;
  capturedClientIds(): readonly GatewayCapturedClient[];
  refreshShutdownActivity(): Promise<void>;
  abandonCodexContinuations(): void;
  prepareForShutdown(options?: { timeoutMs?: number; quietPeriodMs?: number }): Promise<boolean>;
  forcePrepareForShutdown(): Promise<void>;
  cancelPreparedShutdown(): void;
  localBaseUrl(): string | undefined;
  isListening(): boolean;
  setRoutes(routes: readonly TapRoute[], fallbackBaseUrl: string | undefined, fallbackProxyUrl?: string): void;
  setClientRoutes(routes: readonly TapClientRoute[]): void;
  hasClientRoute(source: TapClientRoute['source'], path: string): boolean;
  synchronize?(): Promise<void>;
  enforceTraceRetention?(): Promise<GatewayTraceRetention | undefined>;
  clearHistory?(): Promise<void>;
  readonly background?: boolean;
}
