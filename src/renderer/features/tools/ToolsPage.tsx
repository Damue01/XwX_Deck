import * as React from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Search
} from 'lucide-react';
import type {
  CodexConversationFilter as ConversationFilter,
  CodexConversationHealthSummaryRow,
  CodexConversationHealthRow,
  CodexConversationPageResponse,
  CodexConversationSortDirection as ConversationSortDirection,
  CodexConversationSortKey as ConversationSortKey
} from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { isDesktop } from '@/bridge/api';
import { showToast } from '@/lib/toast';
import { userErrorMessage } from '@/lib/errors';
import { Input } from '@/components/ui/input';

interface Props {
  readonly active: boolean;
}

const CONVERSATION_PAGE_SIZE = 120;

interface ConversationSortState {
  readonly key: ConversationSortKey;
  readonly direction: ConversationSortDirection;
}

interface ConversationHeaderOption {
  readonly value: string;
  readonly label: string;
}

function fileName(p: string): string {
  return String(p || '').split(/[\\/]/).pop() || String(p || '');
}

function diagnosticError(error: unknown): string {
  return userErrorMessage(error, '无法读取对话索引');
}

function healthStatusLabel(status: CodexConversationHealthRow['status']): string {
  if (status === 'error') return '异常';
  if (status === 'warning') return '需关注';
  return '正常';
}

function locationLabel(location: CodexConversationHealthRow['location']): string {
  if (location === 'sessions') return '活动会话';
  if (location === 'archived_sessions') return '已归档';
  if (location === 'missing') return '文件缺失';
  return '其他位置';
}

function formatBytes(value: number | undefined): string {
  if (!Number.isFinite(value) || Number(value) < 0) return '—';
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatTime(value: string | undefined): string {
  return formatTableTime(value).full;
}

function formatScanTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  const now = new Date();
  const twoDigits = (part: number): string => String(part).padStart(2, '0');
  const clock = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
    ? clock
    : `${twoDigits(date.getMonth() + 1)}月${twoDigits(date.getDate())}日 ${clock}`;
}

function formatTableTime(value: string | undefined): {
  readonly short: string;
  readonly full: string;
} {
  if (!value) return { short: '—', full: '无更新时间' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { short: value, full: value };
  const now = new Date();
  const twoDigits = (part: number): string => String(part).padStart(2, '0');
  const month = twoDigits(date.getMonth() + 1);
  const day = twoDigits(date.getDate());
  const clock = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  const year = String(date.getFullYear());
  const sameYear = date.getFullYear() === now.getFullYear();
  const today = sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return {
    short: today ? `今天 ${clock}` : sameYear ? `${month}月${day}日` : `${year}年${month}月`,
    full: `${year}年${month}月${day}日 ${clock}`
  };
}

function conversationDetailId(threadId: string): string {
  return `conversation-detail-${threadId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function conversationHasAmbiguousFiles(row: CodexConversationHealthRow): boolean {
  return row.issues.some(issue => issue.code === 'multiple_rollout_candidates');
}

function ConversationHeaderMenu({
  label,
  sortKey,
  sort,
  sortLabels,
  onSort,
  filterValue,
  filterOptions,
  onFilter,
  align = 'start'
}: {
  readonly label: string;
  readonly sortKey: ConversationSortKey;
  readonly sort: ConversationSortState;
  readonly sortLabels: readonly [string, string];
  readonly onSort: (key: ConversationSortKey, direction: ConversationSortDirection) => void;
  readonly filterValue?: string;
  readonly filterOptions?: readonly ConversationHeaderOption[];
  readonly onFilter?: (value: string) => void;
  readonly align?: 'start' | 'end';
}): React.ReactElement {
  const sorted = sort.key === sortKey;
  const filtered = filterValue !== undefined && filterValue !== 'all';
  const sortIcon = sorted
    ? sort.direction === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />
    : <ChevronDown aria-hidden="true" />;

  return (
    <Menu.Root>
      <Menu.Trigger
        type="button"
        className="conversation-header-trigger"
        data-active={sorted || filtered ? 'true' : 'false'}
        data-filtered={filtered ? 'true' : 'false'}
        aria-label={`${label}列，${filterOptions ? '排序和筛选' : '排序'}`}
        title={filterOptions ? '排序和筛选' : '排序'}
      >
        <span>{label}</span>
        {sortIcon}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="conversation-header-menu-positioner"
          side="bottom"
          align={align}
          sideOffset={4}
        >
          <Menu.Popup className="conversation-header-menu">
            <Menu.Group>
              <Menu.GroupLabel className="conversation-header-menu-label">排序</Menu.GroupLabel>
              <Menu.RadioGroup
                value={sorted ? sort.direction : ''}
                onValueChange={value => onSort(sortKey, value as ConversationSortDirection)}
              >
                {(['asc', 'desc'] as const).map((direction, index) => (
                  <Menu.RadioItem
                    className="conversation-header-menu-item"
                    closeOnClick
                    key={direction}
                    value={direction}
                  >
                    <span className="conversation-header-menu-indicator">
                      <Menu.RadioItemIndicator><Check aria-hidden="true" /></Menu.RadioItemIndicator>
                    </span>
                    {sortLabels[index]}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
            {filterOptions && filterValue !== undefined && onFilter && (
              <>
                <div className="conversation-header-menu-separator" role="separator" />
                <Menu.Group>
                  <Menu.GroupLabel className="conversation-header-menu-label">筛选</Menu.GroupLabel>
                  <Menu.RadioGroup value={filterValue} onValueChange={value => onFilter(String(value))}>
                    {filterOptions.map(option => (
                      <Menu.RadioItem
                        className="conversation-header-menu-item"
                        closeOnClick
                        key={option.value}
                        value={option.value}
                      >
                        <span className="conversation-header-menu-indicator">
                          <Menu.RadioItemIndicator><Check aria-hidden="true" /></Menu.RadioItemIndicator>
                        </span>
                        {option.label}
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Group>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ConversationFieldList({
  fields,
  empty
}: {
  readonly fields: CodexConversationHealthRow['sqliteFields'];
  readonly empty: string;
}): React.ReactElement {
  return (
    <dl>
      {fields.length
        ? fields.map(field => (
            <div key={field.key}>
              <dt>{field.key}</dt>
              <dd title={field.value}>{field.value}</dd>
            </div>
          ))
        : <div><dt>记录</dt><dd className="conversation-fallback">{empty}</dd></div>}
    </dl>
  );
}

function ConversationFileTable({ row }: { readonly row: CodexConversationHealthRow }): React.ReactElement {
  // [label, shown value, whether the value is real data (selectable code) or a fallback]
  const rows: ReadonlyArray<readonly [string, string, boolean]> = [
    ['SQLite 数据库', row.databasePaths.join('\n') || '未找到', row.databasePaths.length > 0],
    ['threads.id', row.indexed ? row.threadId : '未进入索引', row.indexed && !!row.threadId],
    ['threads.rollout_path', row.rolloutPath || '空', !!row.rolloutPath],
    ['实际找到的 JSONL', row.resolvedPath || (row.candidatePaths.length > 1 ? '未唯一确定，见上方结论' : '未找到文件'), !!row.resolvedPath],
    ['session_meta.id', row.sessionId || '无法读取', !!row.sessionId]
  ];
  const facts: ReadonlyArray<readonly [string, string]> = [
    ['目录', locationLabel(row.location)],
    ['大小', formatBytes(row.fileSize)],
    ['修改时间', formatTime(row.fileModifiedAt)]
  ];

  return (
    <dl className="conversation-file-table" aria-label="会话文件">
      {rows.map(([label, value, real]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            {real
              ? <code>{value}</code>
              : <span className="conversation-fallback">{value}</span>}
          </dd>
        </div>
      ))}
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ConversationPathList({ paths }: { readonly paths: readonly string[] }): React.ReactElement {
  return (
    <div className="conversation-path-list">
      {paths.map(candidate => <code key={candidate}>{candidate}</code>)}
    </div>
  );
}

function ConversationHealthTool({ active }: { active: boolean }): React.ReactElement {
  const bridge = useBridge();
  const [report, setReport] = React.useState<CodexConversationPageResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<ConversationFilter>('all');
  const [sort, setSort] = React.useState<ConversationSortState>({ key: 'status', direction: 'asc' });
  const [selectedId, setSelectedId] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [details, setDetails] = React.useState<Map<string, CodexConversationHealthRow>>(() => new Map());
  const [detailLoadingId, setDetailLoadingId] = React.useState('');
  const [detailError, setDetailError] = React.useState('');
  const mountedRef = React.useRef(true);
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const detailSequenceRef = React.useRef(0);
  const activeRequestRef = React.useRef('');
  const requestSequenceRef = React.useRef(0);
  const snapshotIdRef = React.useRef('');
  const deferredQuery = React.useDeferredValue(query);

  const loadPage = React.useCallback(async (refresh = false) => {
    if (!activeRef.current) return;
    setSelectedId('');
    setDetailLoadingId('');
    const previousRequestId = activeRequestRef.current;
    if (previousRequestId) void bridge.api.cancelCodexConversationScan(previousRequestId).catch(() => undefined);
    const requestId = `conversation:${Date.now()}:${++requestSequenceRef.current}`;
    activeRequestRef.current = requestId;
    setLoading(true);
    setError('');
    try {
      const next = await bridge.api.queryCodexConversations({
        requestId,
        page,
        pageSize: CONVERSATION_PAGE_SIZE,
        query: deferredQuery,
        filter,
        sortKey: sort.key,
        sortDirection: sort.direction,
        refresh
      });
      if (!mountedRef.current || activeRequestRef.current !== requestId) return;
      const snapshotChanged = snapshotIdRef.current !== next.snapshotId;
      snapshotIdRef.current = next.snapshotId;
      setReport(next);
      if (next.page !== page) setPage(next.page);
      if (snapshotChanged) {
        detailSequenceRef.current += 1;
        setDetailLoadingId('');
        setDetails(new Map());
        setSelectedId('');
      } else {
        setSelectedId(previous => previous && next.rows.some(row => row.threadId === previous) ? previous : '');
      }
      setDetailError('');
    } catch (scanError) {
      if (!mountedRef.current || activeRequestRef.current !== requestId) return;
      const message = diagnosticError(scanError);
      if (message.includes('扫描已取消')) return;
      setError(message);
    } finally {
      if (mountedRef.current && activeRequestRef.current === requestId) {
        activeRequestRef.current = '';
        setLoading(false);
      }
    }
  }, [bridge.api, deferredQuery, filter, page, sort.direction, sort.key]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  React.useEffect(() => {
    void bridge.api.setCodexConversationDiagnosticsActive(active).catch(() => undefined);
    if (active) void loadPage(false);
    return () => {
      const requestId = activeRequestRef.current;
      activeRequestRef.current = '';
      detailSequenceRef.current += 1;
      if (requestId) void bridge.api.cancelCodexConversationScan(requestId).catch(() => undefined);
      void bridge.api.setCodexConversationDiagnosticsActive(false).catch(() => undefined);
    };
  }, [active, bridge.api, loadPage]);

  const pageRows = report?.rows ?? [];
  const pageCount = Math.max(1, Math.ceil((report?.total ?? 0) / CONVERSATION_PAGE_SIZE));
  const safePage = report?.page ?? page;
  const pageOffset = safePage * CONVERSATION_PAGE_SIZE;

  const loadDetail = React.useCallback(async (row: CodexConversationHealthSummaryRow): Promise<void> => {
    if (!report || details.has(row.threadId)) return;
    const expectedSnapshotId = report.snapshotId;
    const detailSequence = ++detailSequenceRef.current;
    setDetailLoadingId(row.threadId);
    setDetailError('');
    try {
      const detail = await bridge.api.detailCodexConversation({
        snapshotId: expectedSnapshotId,
        threadId: row.threadId
      });
      if (!mountedRef.current || !activeRef.current || detailSequenceRef.current !== detailSequence || snapshotIdRef.current !== expectedSnapshotId) return;
      setDetails(previous => {
        const next = new Map(previous);
        next.set(row.threadId, detail);
        return next;
      });
    } catch (detailLoadError) {
      if (!mountedRef.current || !activeRef.current || detailSequenceRef.current !== detailSequence) return;
      setDetailError(diagnosticError(detailLoadError));
    } finally {
      if (mountedRef.current && detailSequenceRef.current === detailSequence) setDetailLoadingId('');
    }
  }, [bridge.api, details, report]);

  const updateSort = React.useCallback((
    key: ConversationSortKey,
    direction: ConversationSortDirection
  ): void => {
    setSort({ key, direction });
    setSelectedId('');
    setPage(0);
  }, []);

  const scanProblem = report?.scanIssues.some(issue => issue.severity === 'error');

  return (
    <div className="conversation-tool" id="conversationDoctor">
      {loading && !report && (
        <div className="conversation-loading" aria-live="polite">
          <LoaderCircle className="conversation-spin" aria-hidden="true" />
          <span>正在读取会话…</span>
        </div>
      )}

      {error && !report && (
        <div className="conversation-empty is-error">
          <strong>扫描失败</strong>
          <span>{error}</span>
        </div>
      )}

      {report && (
        <>
          <div className="conversation-toolbar">
            <label className="conversation-search">
              <Search aria-hidden="true" />
              <Input
                type="search"
                size="sm"
                value={query}
                placeholder="搜索标题、任务 ID、Provider 或路径"
                aria-label="搜索对话"
                onChange={event => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            <span
              className="conversation-toolbar-status"
              data-status={scanProblem ? 'error' : report.scanComplete ? 'healthy' : 'warning'}
              aria-live="polite"
              title={`生成于 ${formatTime(report.generatedAt)}；扫描 ${report.performance.durationMs} ms；复用 ${report.performance.reusedRollouts} 个 Session 文件`}
            >
              {report.scanComplete
                ? `上次扫描 ${formatScanTimestamp(report.generatedAt)}`
                : `扫描不完整，${formatScanTimestamp(report.generatedAt)}`}
            </span>
            <button
              type="button"
              className="txt-action conversation-refresh"
              id="conversationDoctorScan"
              disabled={loading}
              onClick={() => void loadPage(true)}
            >
              <RefreshCw className={loading ? 'conversation-spin' : ''} aria-hidden="true" />
              <span>{loading ? '扫描中' : '刷新'}</span>
            </button>
          </div>

          {report.scanIssues.length > 0 && (
            <div className="conversation-scan-issues" role="status">
              {report.scanIssues.map((issue, index) => (
                <span data-severity={issue.severity} key={`${issue.code}:${index}`} title={issue.detail}>
                  <b>{issue.title}</b>
                  <span>{issue.detail}</span>
                </span>
              ))}
            </div>
          )}
          {error && (
            <div className="conversation-scan-issues" role="status">
              <span data-severity="error"><b>刷新失败</b><span>{error}</span></span>
            </div>
          )}

          <div className="conversation-table-wrap">
            <table className="conversation-table">
              <colgroup>
                <col className="conversation-col-title" />
                <col className="conversation-col-result" />
                <col className="conversation-col-updated" />
              </colgroup>
              <thead>
                <tr>
                  <th aria-sort={sort.key === 'title' ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
                    <ConversationHeaderMenu
                      label="对话"
                      sortKey="title"
                      sort={sort}
                      sortLabels={['标题 A 到 Z', '标题 Z 到 A']}
                      onSort={updateSort}
                    />
                  </th>
                  <th aria-sort={sort.key === 'status' ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
                    <ConversationHeaderMenu
                      label="检查结果"
                      sortKey="status"
                      sort={sort}
                      sortLabels={['问题优先', '正常优先']}
                      onSort={updateSort}
                      filterValue={filter}
                      filterOptions={[
                        { value: 'all', label: '全部结果' },
                        { value: 'issues', label: '仅有问题' },
                        { value: 'healthy', label: '仅正常' }
                      ]}
                      onFilter={value => {
                        setFilter(value as ConversationFilter);
                        setSelectedId('');
                        setPage(0);
                      }}
                    />
                  </th>
                  <th aria-sort={sort.key === 'updated' ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
                    <ConversationHeaderMenu
                      label="更新时间"
                      sortKey="updated"
                      sort={sort}
                      sortLabels={['最早优先', '最新优先']}
                      onSort={updateSort}
                      align="end"
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(row => {
                  const expanded = row.threadId === selectedId;
                  const detailId = conversationDetailId(row.threadId);
                  const detail = details.get(row.threadId);
                  const ambiguousFiles = detail ? conversationHasAmbiguousFiles(detail) : false;
                  const hasSegments = !!detail && detail.candidatePaths.length > 1 && !ambiguousFiles;
                  const resultSummary = [
                    row.primaryIssueTitle,
                    row.issueCount > 1 ? `另 ${row.issueCount - 1} 项` : ''
                  ].filter(Boolean).join('，');
                  const updatedValue = row.updatedAt || row.fileModifiedAt;
                  const updatedTime = formatTableTime(updatedValue);
                  const toggleExpanded = (): void => {
                    if (expanded) {
                      setSelectedId('');
                      setDetailError('');
                      return;
                    }
                    setSelectedId(row.threadId);
                    void loadDetail(row);
                  };
                  return (
                    <React.Fragment key={row.threadId}>
                      <tr
                        className="conversation-table-row"
                        data-status={row.status}
                        data-expanded={expanded ? 'true' : 'false'}
                        tabIndex={0}
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        title={expanded ? '收起详细信息' : '展开详细信息'}
                        onClick={toggleExpanded}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            toggleExpanded();
                          }
                        }}
                      >
                        <td>
                          <span className="conversation-name">
                            <ChevronRight className="disclosure-chevron" aria-hidden="true" />
                            <strong title={row.title || '未命名任务'}>{row.title || '未命名任务'}</strong>
                          </span>
                        </td>
                        <td>
                          <span
                            className="conversation-result"
                            data-status={row.status}
                            aria-label={`${healthStatusLabel(row.status)}：${row.primaryIssueTitle}`}
                          >
                            {resultSummary}
                          </span>
                        </td>
                        <td>
                          <time
                            className="conversation-updated"
                            dateTime={updatedValue}
                            title={updatedTime.full}
                            aria-label={updatedTime.full}
                          >
                            {updatedTime.short}
                          </time>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="conversation-table-detail" id={detailId}>
                          <td colSpan={3}>
                            <div className="conversation-inline-detail">
                              {!detail && detailLoadingId === row.threadId && (
                                <div className="conversation-detail-loading" aria-live="polite">
                                  <LoaderCircle className="conversation-spin" aria-hidden="true" />
                                  <span>正在读取详情…</span>
                                </div>
                              )}
                              {!detail && detailLoadingId !== row.threadId && (
                                <div className="conversation-detail-loading is-error" role="status">
                                  <span>{detailError || '详情暂时不可用，请收起后重试。'}</span>
                                </div>
                              )}
                              {detail && (
                                <>
                                  <h4 className="conversation-detail-title">结论</h4>
                                  {detail.issues.length > 0 ? (
                                    <ul>
                                      {detail.issues.map((issue, issueIndex) => (
                                        <li data-severity={issue.severity} key={`${issue.code}:${issueIndex}`}>
                                          <strong>{issue.title}</strong>
                                          {issue.code === 'multiple_rollout_candidates'
                                            ? <ConversationPathList paths={detail.candidatePaths} />
                                            : <span>{issue.detail}</span>}
                                        </li>
                                      ))}
                                    </ul>
                                  ) : <p className="conversation-detail-ok">没有发现问题。</p>}
                                  <h4 className="conversation-detail-title">文件</h4>
                                  <ConversationFileTable row={detail} />
                                  {hasSegments && (
                                    <div className="conversation-candidates">
                                      <ConversationPathList paths={detail.candidatePaths} />
                                    </div>
                                  )}
                                  <details className="conversation-raw">
                                    <summary><ChevronRight className="disclosure-chevron" aria-hidden="true" />原始字段</summary>
                                    <div className="conversation-field-groups">
                                      <section>
                                        <h4>SQLite threads</h4>
                                        <ConversationFieldList fields={detail.sqliteFields} empty="无记录" />
                                      </section>
                                      <section>
                                        <h4>JSONL session_meta</h4>
                                        <ConversationFieldList fields={detail.sessionFields} empty="无记录" />
                                      </section>
                                    </div>
                                  </details>
                                  {isDesktop() && detail.resolvedPath && (
                                    <div className="conversation-open-actions">
                                      <button
                                        type="button"
                                        className="txt-action conversation-open-link"
                                        onClick={() => void bridge.api.openCodexConversationPath(detail.resolvedPath!).catch(() => {
                                          showToast('无法打开 Session 文件位置', 'error');
                                        })}
                                      >
                                        <FolderOpen aria-hidden="true" />
                                        <span>打开文件位置</span>
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            {!pageRows.length && (
              query.trim() || filter !== 'all' ? (
                <div className="conversation-empty">
                  <strong>没有符合筛选的会话</strong>
                  <button
                    type="button"
                    className="txt-action"
                    onClick={() => {
                      setQuery('');
                      setFilter('all');
                      setSelectedId('');
                      setPage(0);
                    }}
                  >
                    清除筛选
                  </button>
                </div>
              ) : (
                <div className="conversation-empty">
                  <strong>还没有会话记录</strong>
                </div>
              )
            )}
          </div>

          {report.total > 0 && (
            <nav className="conversation-pagination" aria-label="对话列表分页">
              <span>
                {pageOffset + 1}–{pageOffset + pageRows.length} / {report.total}
              </span>
              <div>
                <button
                  type="button"
                  className="txt-action"
                  disabled={loading || safePage === 0}
                  onClick={() => {
                    setSelectedId('');
                    setPage(current => Math.max(0, current - 1));
                  }}
                >
                  <ChevronLeft aria-hidden="true" />
                  <span>上一页</span>
                </button>
                <button
                  type="button"
                  className="txt-action"
                  disabled={loading || safePage >= pageCount - 1}
                  onClick={() => {
                    setSelectedId('');
                    setPage(current => Math.min(pageCount - 1, current + 1));
                  }}
                >
                  <span>下一页</span>
                  <ChevronRight aria-hidden="true" />
                </button>
              </div>
            </nav>
          )}

          {report.truncated && <p className="conversation-scope-note">仅显示前 5,000 条（异常优先）</p>}
        </>
      )}
    </div>
  );
}

export function ToolsPage({ active }: Props): React.ReactElement {
  return (
    <section
      className={`page${active ? ' current' : ''}`}
      id="page-tools"
      aria-label="工具"
      inert={active ? undefined : true}
    >
      <div className="page-inner">
        <div className="page-head tool-head">
          <div>
            <h1>工具</h1>
          </div>
        </div>
        <ConversationHealthTool active={active} />
      </div>
    </section>
  );
}
