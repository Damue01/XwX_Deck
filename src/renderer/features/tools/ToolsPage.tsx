import * as React from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Search
} from 'lucide-react';
import type {
  CodexConversationHealthReport,
  CodexConversationHealthRow
} from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { isDesktop } from '@/bridge/api';
import { showToast } from '@/lib/toast';
import { Input } from '@/components/ui/input';

interface Props {
  readonly active: boolean;
}

type ConversationFilter = 'all' | 'issues' | 'healthy';
type ConversationWorkspaceFilter = CodexConversationHealthRow['workspaceKind'] | 'all';
type ConversationSortKey = 'title' | 'workspace' | 'location' | 'status' | 'updated';
type ConversationSortDirection = 'asc' | 'desc';

interface ConversationSortState {
  readonly key: ConversationSortKey;
  readonly direction: ConversationSortDirection;
}

interface ConversationHeaderOption {
  readonly value: string;
  readonly label: string;
}

function diagnosticError(error: unknown): string {
  const raw = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message.split(/\r?\n/, 1)[0]?.trim() || ''
    : '';
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^(?:Error:\s*)+/u, '')
    .trim() || '无法读取对话索引';
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
  const formatted = formatTableTime(value);
  return [formatted.primary, formatted.secondary].filter(Boolean).join(' ');
}

function formatTableTime(value: string | undefined): {
  readonly primary: string;
  readonly secondary: string;
  readonly full: string;
} {
  if (!value) return { primary: '—', secondary: '', full: '无更新时间' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { primary: value, secondary: '', full: value };
  const twoDigits = (part: number): string => String(part).padStart(2, '0');
  const month = twoDigits(date.getMonth() + 1);
  const day = twoDigits(date.getDate());
  const hour = twoDigits(date.getHours());
  const minute = twoDigits(date.getMinutes());
  const year = String(date.getFullYear());
  return {
    primary: `${month}月${day}日`,
    secondary: `${hour}:${minute} · ${year}`,
    full: `${year}年${month}月${day}日 ${hour}:${minute}`
  };
}

function conversationDetailId(threadId: string): string {
  return `conversation-detail-${threadId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

const conversationCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
});

const conversationStatusOrder: Record<CodexConversationHealthRow['status'], number> = {
  error: 0,
  warning: 1,
  healthy: 2
};

const conversationLocationOrder: Record<CodexConversationHealthRow['location'], number> = {
  sessions: 0,
  archived_sessions: 1,
  other: 2,
  missing: 3
};

function conversationTimestamp(row: CodexConversationHealthRow): number {
  const parsed = Date.parse(row.updatedAt || row.fileModifiedAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function workspaceKindLabel(kind: CodexConversationHealthRow['workspaceKind']): string {
  if (kind === 'project') return 'ChatGPT Project';
  if (kind === 'directory') return '本地目录（未加入 Project）';
  return '无工作区';
}

function conversationWorkspaceTitle(row: CodexConversationHealthRow): string {
  if (row.workspaceKind === 'project') return `ChatGPT Project：${row.projectName || row.workspaceName}`;
  if (row.workspaceKind === 'directory') return `本地目录：${row.cwd || row.workspaceName}`;
  return '无工作区';
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
        : <div><dt>记录</dt><dd>{empty}</dd></div>}
    </dl>
  );
}

function ConversationPathChain({
  row,
  onCopy
}: {
  readonly row: CodexConversationHealthRow;
  readonly onCopy: (label: string, value: string) => void;
}): React.ReactElement {
  const actualPath = row.resolvedPath
    || (row.candidatePaths.length > 1 ? '找到多个同 ID 文件，未唯一确定' : '未找到文件');
  const chain = [
    ['SQLite 数据库', row.databasePaths.join(' · ') || '未进入索引', row.databasePaths.join('\n'), 'SQLite 数据库路径'],
    ['threads.id', row.indexed ? row.threadId : '未进入索引', row.indexed ? row.threadId : '', 'Thread ID'],
    ['threads.rollout_path', row.rolloutPath || '空', row.rolloutPath || '', 'rollout_path'],
    ['实际找到的 JSONL', actualPath, row.resolvedPath || '', 'JSONL 文件路径'],
    ['session_meta.id', row.sessionId || '无法读取', row.sessionId || '', 'Session ID']
  ] as const;

  return (
    <div className="conversation-path-chain" aria-label="SQLite 到 JSONL 的路径链路">
      {chain.map(([label, value, copyValue, copyLabel], index) => (
        <React.Fragment key={label}>
          <div>
            <b>{label}</b>
            {copyValue ? (
              <button
                type="button"
                className="conversation-copy-value"
                aria-label={`复制${copyLabel}`}
                title={`点击复制${copyLabel}`}
                onClick={() => onCopy(copyLabel, copyValue)}
              >
                <code>{value}</code>
              </button>
            ) : <code title={value}>{value}</code>}
          </div>
          {index < chain.length - 1 && <span aria-hidden="true">→</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

function ConversationWorkspaceFacts({
  row,
  onCopy
}: {
  readonly row: CodexConversationHealthRow;
  readonly onCopy: (label: string, value: string) => void;
}): React.ReactElement {
  const roots = row.projectRoots ?? [];
  const facts: Array<{
    label: string;
    value: string;
    copyLabel?: string;
    copyValue?: string;
  }> = [
    { label: '工作区', value: row.workspaceName || '—' },
    { label: '归属类型', value: workspaceKindLabel(row.workspaceKind) },
    {
      label: 'Project ID',
      value: row.projectId || '—',
      ...(row.projectId ? { copyLabel: 'Project ID', copyValue: row.projectId } : {})
    },
    {
      label: '工作目录',
      value: row.cwd || '—',
      ...(row.cwd ? { copyLabel: '工作目录', copyValue: row.cwd } : {})
    },
    {
      label: '主目录',
      value: roots[0] || '—',
      ...(roots[0] ? { copyLabel: 'Project 主目录', copyValue: roots[0] } : {})
    }
  ];

  return (
    <section className="conversation-workspace-facts" aria-label="工作归属">
      <h4>工作归属</h4>
      <dl>
        {facts.map(fact => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>
              {fact.copyValue && fact.copyLabel ? (
                <button
                  type="button"
                  className="conversation-copy-value"
                  aria-label={`复制${fact.copyLabel}`}
                  title={`点击复制${fact.copyLabel}`}
                  onClick={() => onCopy(fact.copyLabel!, fact.copyValue!)}
                >
                  <code>{fact.value}</code>
                </button>
              ) : <span title={fact.value}>{fact.value}</span>}
            </dd>
          </div>
        ))}
        <div>
          <dt>其他目录</dt>
          <dd className="conversation-workspace-roots">
            {roots.length > 1 ? roots.slice(1).map(root => (
              <button
                type="button"
                className="conversation-copy-value"
                aria-label="复制 Project 其他目录"
                title="点击复制 Project 其他目录"
                onClick={() => onCopy('Project 其他目录', root)}
                key={root}
              >
                <code>{root}</code>
              </button>
            )) : <span>—</span>}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ConversationHealthTool({ active }: { active: boolean }): React.ReactElement {
  const bridge = useBridge();
  const [report, setReport] = React.useState<CodexConversationHealthReport | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<ConversationFilter>('all');
  const [workspaceFilter, setWorkspaceFilter] = React.useState<ConversationWorkspaceFilter>('all');
  const [locationFilter, setLocationFilter] = React.useState<CodexConversationHealthRow['location'] | 'all'>('all');
  const [sort, setSort] = React.useState<ConversationSortState>({ key: 'status', direction: 'asc' });
  const [selectedId, setSelectedId] = React.useState('');
  const loadedRef = React.useRef(false);
  const scanningRef = React.useRef(false);
  const deferredQuery = React.useDeferredValue(query);

  const copyValue = React.useCallback((label: string, value: string): void => {
    void bridge.api.copyText(value).then(() => {
      showToast(`已复制 ${label}`, 'success');
    }).catch(() => {
      showToast('复制失败', 'error');
    });
  }, [bridge.api]);

  const scan = React.useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setLoading(true);
    setError('');
    try {
      const next = await bridge.api.diagnoseCodexConversations();
      setReport(next);
      setSelectedId(previous => (
        previous && next.conversations.some(row => row.threadId === previous)
          ? previous
          : ''
      ));
      setWorkspaceFilter(previous => (
        previous === 'all' || next.conversations.some(row => row.workspaceKind === previous)
          ? previous
          : 'all'
      ));
      setLocationFilter(previous => (
        previous === 'all' || next.conversations.some(row => row.location === previous)
          ? previous
          : 'all'
      ));
      loadedRef.current = true;
    } catch (scanError) {
      const message = diagnosticError(scanError);
      setError(message);
      showToast(message, 'error');
    } finally {
      scanningRef.current = false;
      setLoading(false);
    }
  }, [bridge.api]);

  React.useEffect(() => {
    if (active && !loadedRef.current) void scan();
  }, [active, scan]);

  const workspaceFilterOptions = React.useMemo<readonly ConversationHeaderOption[]>(() => {
    const present = new Set((report?.conversations ?? []).map(row => row.workspaceKind));
    return [
      { value: 'all', label: '全部工作区' },
      ...(['project', 'directory', 'none'] as const)
        .filter(value => present.has(value))
        .map(value => ({ value, label: workspaceKindLabel(value) }))
    ];
  }, [report]);

  const locationFilterOptions = React.useMemo<readonly ConversationHeaderOption[]>(() => {
    const present = new Set((report?.conversations ?? []).map(row => row.location));
    return [
      { value: 'all', label: '全部文件位置' },
      ...(['sessions', 'archived_sessions', 'other', 'missing'] as const)
        .filter(value => present.has(value))
        .map(value => ({ value, label: locationLabel(value) }))
    ];
  }, [report]);

  const rows = React.useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    const filteredRows = (report?.conversations ?? []).filter(row => {
      if (filter === 'issues' && row.status === 'healthy') return false;
      if (filter === 'healthy' && row.status !== 'healthy') return false;
      if (workspaceFilter !== 'all' && row.workspaceKind !== workspaceFilter) return false;
      if (locationFilter !== 'all' && row.location !== locationFilter) return false;
      if (!needle) return true;
      return [
        row.threadId,
        row.title,
        row.preview,
        row.workspaceName,
        row.projectId,
        row.projectName,
        row.cwd,
        ...row.projectRoots,
        row.sqliteProvider,
        row.sessionProvider,
        row.rolloutPath,
        row.resolvedPath,
        ...row.databasePaths,
        ...row.candidatePaths,
        ...row.issues.flatMap(issue => [issue.title, issue.detail])
      ].some(value => String(value || '').toLocaleLowerCase().includes(needle));
    });

    const direction = sort.direction === 'asc' ? 1 : -1;
    return filteredRows.sort((left, right) => {
      let comparison = 0;
      if (sort.key === 'title') {
        comparison = conversationCollator.compare(left.title || left.threadId, right.title || right.threadId);
      } else if (sort.key === 'workspace') {
        comparison = conversationCollator.compare(
          left.workspaceName || workspaceKindLabel(left.workspaceKind),
          right.workspaceName || workspaceKindLabel(right.workspaceKind)
        );
      } else if (sort.key === 'location') {
        comparison = conversationLocationOrder[left.location] - conversationLocationOrder[right.location];
      } else if (sort.key === 'status') {
        comparison = conversationStatusOrder[left.status] - conversationStatusOrder[right.status];
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
  }, [deferredQuery, filter, locationFilter, report, sort, workspaceFilter]);

  const updateSort = React.useCallback((
    key: ConversationSortKey,
    direction: ConversationSortDirection
  ): void => {
    setSort({ key, direction });
    setSelectedId('');
  }, []);

  const scanProblem = report?.scanIssues.some(issue => issue.severity === 'error');

  return (
    <div className="conversation-tool" id="conversationDoctor">
      {loading && !report && (
        <div className="conversation-loading" aria-live="polite">
          <LoaderCircle className="conversation-spin" aria-hidden="true" />
          <span>正在读取会话索引和 Session 元数据</span>
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
                placeholder="搜索标题、任务 ID、工作区、Provider 或路径"
                aria-label="搜索对话"
                onChange={event => setQuery(event.target.value)}
              />
            </label>
            <span
              className="conversation-toolbar-status"
              data-status={scanProblem ? 'error' : report.scanComplete ? 'healthy' : 'warning'}
              aria-live="polite"
            >
              {report.scanComplete ? '扫描完成' : '扫描不完整'}
            </span>
            <button
              type="button"
              className="txt-action conversation-refresh"
              id="conversationDoctorScan"
              disabled={loading}
              onClick={() => void scan()}
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
                  <code>{issue.detail}</code>
                </span>
              ))}
            </div>
          )}
          {error && (
            <div className="conversation-scan-issues" role="status">
              <span data-severity="error"><b>刷新失败</b><code>{error}</code></span>
            </div>
          )}

          <div className="conversation-table-wrap">
            <table className="conversation-table">
              <colgroup>
                <col className="conversation-col-title" />
                <col className="conversation-col-workspace" />
                <col className="conversation-col-file" />
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
                  <th aria-sort={sort.key === 'workspace' ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
                    <ConversationHeaderMenu
                      label="工作区"
                      sortKey="workspace"
                      sort={sort}
                      sortLabels={['名称 A 到 Z', '名称 Z 到 A']}
                      onSort={updateSort}
                      filterValue={workspaceFilter}
                      filterOptions={workspaceFilterOptions}
                      onFilter={value => {
                        setWorkspaceFilter(value as ConversationWorkspaceFilter);
                        setSelectedId('');
                      }}
                    />
                  </th>
                  <th aria-sort={sort.key === 'location' ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
                    <ConversationHeaderMenu
                      label="文件"
                      sortKey="location"
                      sort={sort}
                      sortLabels={['活动优先', '缺失优先']}
                      onSort={updateSort}
                      filterValue={locationFilter}
                      filterOptions={locationFilterOptions}
                      onFilter={value => {
                        setLocationFilter(value as CodexConversationHealthRow['location'] | 'all');
                        setSelectedId('');
                      }}
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
                {rows.map(row => {
                  const expanded = row.threadId === selectedId;
                  const detailId = conversationDetailId(row.threadId);
                  const fileSummary = row.candidatePaths.length > 1
                    ? `多个文件 · ${row.candidatePaths.length} 个`
                    : locationLabel(row.location);
                  const resultSummary = [
                    row.issues[0]?.title || '一致',
                    row.issues.length > 1 ? `另 ${row.issues.length - 1} 项` : ''
                  ].filter(Boolean).join(' · ');
                  const updatedValue = row.updatedAt || row.fileModifiedAt;
                  const updatedTime = formatTableTime(updatedValue);
                  const toggleExpanded = (): void => {
                    setSelectedId(expanded ? '' : row.threadId);
                  };
                  return (
                    <React.Fragment key={`${row.threadId}:${row.resolvedPath || row.rolloutPath || 'missing'}`}>
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
                            <strong title={row.title || '未命名任务'}>{row.title || '未命名任务'}</strong>
                          </span>
                        </td>
                        <td>
                          <span className="conversation-workspace-summary" title={conversationWorkspaceTitle(row)}>
                            {row.workspaceName || '—'}
                          </span>
                        </td>
                        <td>
                          <span className="conversation-file-summary" title={fileSummary}>{fileSummary}</span>
                        </td>
                        <td>
                          <span
                            className="conversation-result"
                            data-status={row.status}
                            aria-label={`${healthStatusLabel(row.status)}：${row.issues[0]?.title || '一致'}`}
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
                            <span>{updatedTime.primary}</span>
                            {updatedTime.secondary && <small>{updatedTime.secondary}</small>}
                          </time>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="conversation-table-detail" id={detailId}>
                          <td colSpan={5}>
                            <div className="conversation-inline-detail">
                              {row.issues.length > 0 && (
                                <ul>
                                  {row.issues.map((issue, issueIndex) => (
                                    <li data-severity={issue.severity} key={`${issue.code}:${issueIndex}`}>
                                      <strong>{issue.title}</strong>
                                      <span>{issue.detail}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <ConversationWorkspaceFacts row={row} onCopy={copyValue} />
                              <ConversationPathChain row={row} onCopy={copyValue} />
                              <div className="conversation-file-facts">
                                <span><b>目录</b>{locationLabel(row.location)}</span>
                                <span><b>大小</b>{formatBytes(row.fileSize)}</span>
                                <span><b>修改时间</b>{formatTime(row.fileModifiedAt)}</span>
                                <span><b>同 ID 文件</b>{row.candidatePaths.length}</span>
                              </div>
                              {row.candidatePaths.length > 1 && (
                                <div className="conversation-candidates">
                                  <b>找到的 JSONL</b>
                                  {row.candidatePaths.map(candidate => (
                                    <button
                                      type="button"
                                      className="conversation-copy-value"
                                      aria-label="复制 JSONL 文件路径"
                                      title="点击复制 JSONL 文件路径"
                                      onClick={() => copyValue('JSONL 文件路径', candidate)}
                                      key={candidate}
                                    >
                                      <code>{candidate}</code>
                                    </button>
                                  ))}
                                </div>
                              )}
                              <div className="conversation-field-groups">
                                <section>
                                  <h4>SQLite · threads</h4>
                                  <ConversationFieldList fields={row.sqliteFields} empty="未进入索引" />
                                </section>
                                <section>
                                  <h4>JSONL · session_meta</h4>
                                  <ConversationFieldList fields={row.sessionFields} empty="无法读取" />
                                </section>
                              </div>
                              {isDesktop() && row.resolvedPath && (
                                <div className="conversation-open-actions">
                                  <button
                                    type="button"
                                    className="txt-action conversation-open-link"
                                    onClick={() => void bridge.api.openCodexConversationPath(row.resolvedPath!).catch(() => {
                                      showToast('无法打开 Session 文件位置', 'error');
                                    })}
                                  >
                                    <FolderOpen aria-hidden="true" />
                                    <span>打开文件位置</span>
                                  </button>
                                </div>
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
            {!rows.length && (
              <div className="conversation-empty">
                <strong>没有符合条件的对话</strong>
                <span>调整搜索词或状态筛选。</span>
              </div>
            )}
          </div>

          {report.truncated && <p className="conversation-scope-note">结果数量已达到显示上限。</p>}
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
            <p>检查 ChatGPT 本地对话索引、Session 文件与 Provider 元数据是否一致。</p>
          </div>
        </div>
        <ConversationHealthTool active={active} />
      </div>
    </section>
  );
}
