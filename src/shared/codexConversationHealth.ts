export type CodexConversationHealthStatus = 'healthy' | 'warning' | 'error';

export type CodexConversationWorkspaceKind = 'project' | 'directory' | 'none';

export type CodexConversationIssueCode =
  | 'database_unavailable'
  | 'sqlite_integrity_failed'
  | 'scan_incomplete'
  | 'duplicate_index'
  | 'missing_rollout_path'
  | 'rollout_file_missing'
  | 'recovery_candidate'
  | 'multiple_rollout_candidates'
  | 'empty_session_file'
  | 'invalid_session_meta'
  | 'thread_id_mismatch'
  | 'provider_mismatch'
  | 'provider_not_configured'
  | 'archive_location_mismatch'
  | 'orphan_rollout';

export interface CodexConversationIssue {
  readonly code: CodexConversationIssueCode;
  readonly severity: 'warning' | 'error';
  readonly title: string;
  readonly detail: string;
}

export interface CodexConversationField {
  readonly key: string;
  readonly value: string;
}

export type CodexRolloutLocation =
  | 'sessions'
  | 'archived_sessions'
  | 'other'
  | 'missing';

export interface CodexConversationHealthRow {
  readonly threadId: string;
  readonly title: string;
  readonly preview: string;
  readonly workspaceKind: CodexConversationWorkspaceKind;
  readonly workspaceName: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly projectRoots: readonly string[];
  readonly cwd?: string;
  readonly indexed: boolean;
  readonly databasePaths: readonly string[];
  readonly rolloutPath?: string;
  readonly resolvedPath?: string;
  readonly candidatePaths: readonly string[];
  readonly fileExists: boolean;
  readonly fileSize?: number;
  readonly fileModifiedAt?: string;
  readonly location: CodexRolloutLocation;
  readonly archived?: boolean;
  readonly archivedAt?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly sqliteProvider?: string;
  readonly sessionProvider?: string;
  readonly sessionId?: string;
  readonly sqliteFields: readonly CodexConversationField[];
  readonly sessionFields: readonly CodexConversationField[];
  readonly status: CodexConversationHealthStatus;
  readonly issues: readonly CodexConversationIssue[];
}

export interface CodexConversationDatabaseHealth {
  readonly path: string;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly quickCheck?: string;
  readonly threadCount?: number;
  readonly walPresent: boolean;
  readonly walBytes?: number;
  readonly error?: string;
}

export interface CodexConversationHealthReport {
  readonly generatedAt: string;
  readonly codexHome: string;
  readonly configPath: string;
  readonly activeProvider: string;
  readonly configuredProviders: readonly string[];
  readonly databases: readonly CodexConversationDatabaseHealth[];
  readonly scanScope: 'index-and-session-meta';
  readonly scanComplete: boolean;
  readonly scanIssues: readonly CodexConversationIssue[];
  readonly truncated: boolean;
  readonly summary: {
    readonly indexedThreads: number;
    readonly discoveredRollouts: number;
    readonly healthy: number;
    readonly warnings: number;
    readonly errors: number;
    readonly orphanRollouts: number;
    readonly missingRollouts: number;
  };
  readonly conversations: readonly CodexConversationHealthRow[];
}

export type CodexConversationFilter = 'all' | 'issues' | 'healthy';
export type CodexConversationSortKey = 'title' | 'status' | 'updated';
export type CodexConversationSortDirection = 'asc' | 'desc';

export interface CodexConversationHealthSummaryRow {
  readonly threadId: string;
  readonly title: string;
  readonly status: CodexConversationHealthStatus;
  readonly primaryIssueTitle: string;
  readonly issueCount: number;
  readonly updatedAt?: string;
  readonly fileModifiedAt?: string;
}

export interface CodexConversationScanPerformance {
  readonly durationMs: number;
  readonly reusedRollouts: number;
  readonly inspectedRollouts: number;
  readonly reusedDatabases: number;
  readonly inspectedDatabases: number;
}

export interface CodexConversationPageRequest {
  readonly requestId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly query: string;
  readonly filter: CodexConversationFilter;
  readonly sortKey: CodexConversationSortKey;
  readonly sortDirection: CodexConversationSortDirection;
  readonly refresh?: boolean;
}

export interface CodexConversationPageResponse {
  readonly requestId: string;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly codexHome: string;
  readonly configPath: string;
  readonly activeProvider: string;
  readonly configuredProviders: readonly string[];
  readonly databases: readonly CodexConversationDatabaseHealth[];
  readonly scanScope: CodexConversationHealthReport['scanScope'];
  readonly scanComplete: boolean;
  readonly scanIssues: readonly CodexConversationIssue[];
  readonly truncated: boolean;
  readonly summary: CodexConversationHealthReport['summary'];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly rows: readonly CodexConversationHealthSummaryRow[];
  readonly performance: CodexConversationScanPerformance;
}

export interface CodexConversationDetailRequest {
  readonly snapshotId: string;
  readonly threadId: string;
}
