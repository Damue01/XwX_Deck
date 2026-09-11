import type {
  CodexConversationDetailRequest,
  CodexConversationHealthReport,
  CodexConversationHealthRow,
  CodexConversationHealthSummaryRow,
  CodexConversationPageRequest,
  CodexConversationPageResponse,
  CodexConversationScanPerformance
} from '../../shared/codexConversationHealth';
import {
  CodexConversationDoctor,
  CodexConversationScanCache,
  CodexConversationScanCancelledError
} from './codexConversationDoctor';

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const statusOrder = { error: 0, warning: 1, healthy: 2 } as const;

export class CodexConversationQueryEngine {
  private readonly scanCache = new CodexConversationScanCache();
  private snapshot: CodexConversationHealthReport | undefined;
  private snapshotId = '';
  private snapshotRows = new Map<string, CodexConversationHealthRow>();
  private lastPerformance: CodexConversationScanPerformance = {
    durationMs: 0,
    reusedRollouts: 0,
    inspectedRollouts: 0,
    reusedDatabases: 0,
    inspectedDatabases: 0
  };
  private revision = 0;

  async query(
    request: CodexConversationPageRequest,
    isCancelled: () => boolean = () => false
  ): Promise<CodexConversationPageResponse> {
    if (isCancelled()) throw new CodexConversationScanCancelledError();
    if (!this.snapshot || request.refresh) {
      const doctor = new CodexConversationDoctor({ cache: this.scanCache, isCancelled });
      const next = await doctor.diagnose();
      if (isCancelled()) throw new CodexConversationScanCancelledError();
      this.snapshot = next;
      this.lastPerformance = doctor.performance();
      this.revision += 1;
      this.snapshotId = `${next.generatedAt}:${this.revision}`;
      this.snapshotRows = new Map(next.conversations.map(row => [row.threadId, row]));
    }

    const current = this.snapshot;
    const pageSize = Math.max(20, Math.min(200, Math.floor(request.pageSize) || 120));
    const rows = filterAndSort(current.conversations, request);
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.max(0, Math.min(pageCount - 1, Math.floor(request.page) || 0));
    const offset = page * pageSize;
    return {
      requestId: request.requestId,
      snapshotId: this.snapshotId,
      generatedAt: current.generatedAt,
      codexHome: current.codexHome,
      configPath: current.configPath,
      activeProvider: current.activeProvider,
      configuredProviders: current.configuredProviders,
      databases: current.databases,
      scanScope: current.scanScope,
      scanComplete: current.scanComplete,
      scanIssues: current.scanIssues,
      truncated: current.truncated,
      summary: current.summary,
      page,
      pageSize,
      total: rows.length,
      rows: rows.slice(offset, offset + pageSize).map(summaryRow),
      performance: this.lastPerformance
    };
  }

  detail(request: CodexConversationDetailRequest): CodexConversationHealthRow {
    if (!this.snapshot || request.snapshotId !== this.snapshotId) {
      throw new Error('诊断结果已更新，请重新加载当前页。');
    }
    const row = this.snapshotRows.get(request.threadId);
    if (!row) throw new Error('未找到该对话的诊断详情。');
    return row;
  }
}

function filterAndSort(
  rows: readonly CodexConversationHealthRow[],
  request: CodexConversationPageRequest
): CodexConversationHealthRow[] {
  const needle = request.query.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => {
    if (request.filter === 'issues' && row.status === 'healthy') return false;
    if (request.filter === 'healthy' && row.status !== 'healthy') return false;
    if (!needle) return true;
    return [
      row.threadId,
      row.title,
      row.preview,
      row.cwd,
      row.sqliteProvider,
      row.sessionProvider,
      row.rolloutPath,
      row.resolvedPath,
      ...row.databasePaths,
      ...row.candidatePaths,
      ...row.issues.flatMap(issue => [issue.title, issue.detail])
    ].some(value => String(value || '').toLocaleLowerCase().includes(needle));
  });
  const direction = request.sortDirection === 'asc' ? 1 : -1;
  return filtered.sort((left, right) => {
    let comparison = 0;
    if (request.sortKey === 'title') {
      comparison = collator.compare(left.title || left.threadId, right.title || right.threadId);
    } else if (request.sortKey === 'status') {
      comparison = statusOrder[left.status] - statusOrder[right.status];
    } else {
      const leftTime = conversationTimestamp(left);
      const rightTime = conversationTimestamp(right);
      if (!leftTime && rightTime) return 1;
      if (leftTime && !rightTime) return -1;
      comparison = leftTime - rightTime;
    }
    if (comparison !== 0) return comparison * direction;
    return conversationTimestamp(right) - conversationTimestamp(left);
  });
}

function conversationTimestamp(row: CodexConversationHealthRow): number {
  const parsed = Date.parse(row.updatedAt || row.fileModifiedAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function summaryRow(row: CodexConversationHealthRow): CodexConversationHealthSummaryRow {
  return {
    threadId: row.threadId,
    title: row.title.slice(0, 240),
    status: row.status,
    primaryIssueTitle: row.issues[0]?.title || '一致',
    issueCount: row.issues.length,
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    ...(row.fileModifiedAt ? { fileModifiedAt: row.fileModifiedAt } : {})
  };
}

