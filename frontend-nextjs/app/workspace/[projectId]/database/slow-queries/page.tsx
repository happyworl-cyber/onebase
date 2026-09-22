'use client'

/**
 * `/workspace/[projectId]/database/slow-queries` —— 项目慢查询观察台（W3）。
 *
 * 三 tab 混合：
 *   - pg_stats：`/api/query-perf/statements`（X-Database-Id，项目级）
 *   - live：    `/api/query-perf/active`（X-Database-Id，项目级）
 *   - app：     `/api/admin/slow-queries?database_id=...`（当前项目库）
 *
 * app tab 按当前连接的 database_id 请求平台慢查询日志；后端会校验当前用户对该
 * database 所属租户的管理权限。403 时不阻塞 pg_stats / live 两个 tab。
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import api, {
  queryPerfAPI,
  StatementStat,
  ActiveQuery,
  QueryPerfExtensionStatus,
} from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import Pagination, { sliceForPage } from '@/components/Pagination'
import { askAi, genRequestId } from '@/lib/aiAssistant'
import { useAppStore } from '@/lib/store'

type Tab = 'pg_stats' | 'live' | 'app'

interface AppSlowRow {
  id: number
  database_id: number | null
  schema_name: string | null
  table_name: string | null
  sql_preview: string | null
  duration_ms: number
  created_at: string
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '-'
  if (ms < 1) return `${ms.toFixed(3)} ms`
  if (ms < 1000) return `${ms.toFixed(2)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  const m = Math.floor(ms / 60_000)
  const s = ((ms % 60_000) / 1000).toFixed(1)
  return `${m}m ${s}s`
}

function fmtSeconds(s: number): string {
  return fmtMs(s * 1000)
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return String(n)
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export default function SlowQueriesPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const t = useTranslations('wsSlowQueries')
  const notify = useNotification()
  const currentConnection = useAppStore((s) => s.currentConnection)
  const databaseId = currentConnection?.database_id ?? null

  const [tab, setTab] = useState<Tab>('pg_stats')
  const [autoRefresh, setAutoRefresh] = useState(false)

  // 通用阈值（pg_stats / live 都用这个 ms 阈值）
  const [thresholdMs, setThresholdMs] = useState<number>(500)

  // pg_stat_statements
  const [extStatus, setExtStatus] = useState<QueryPerfExtensionStatus | null>(null)
  const [pgStats, setPgStats] = useState<StatementStat[]>([])
  const [pgLoading, setPgLoading] = useState(false)

  // pg_stat_activity
  const [activeQueries, setActiveQueries] = useState<ActiveQuery[]>([])
  const [activeLoading, setActiveLoading] = useState(false)

  // 应用层 slow_query_logs
  const [appRows, setAppRows] = useState<AppSlowRow[]>([])
  const [appLoading, setAppLoading] = useState(false)

  // 详情 / 取消
  const [detailQuery, setDetailQuery] = useState<string | null>(null)
  const [cancelTarget, setCancelTarget] = useState<ActiveQuery | null>(null)
  const [cancelTerminate, setCancelTerminate] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  // 三个 tab 各自的客户端分页：拉回来的是 top 100/200 条，再切成每页 20。
  // 切 tab / 重新拉 / 改阈值时把页码 reset 到 1，避免落在"超出新数据范围"的页。
  const [pgPage, setPgPage] = useState(1)
  const [pgPageSize, setPgPageSize] = useState(20)
  const [livePage, setLivePage] = useState(1)
  const [livePageSize, setLivePageSize] = useState(20)
  const [appPage, setAppPage] = useState(1)
  const [appPageSize, setAppPageSize] = useState(20)

  const pagedPgStats = useMemo(
    () => sliceForPage(pgStats, pgPage, pgPageSize),
    [pgStats, pgPage, pgPageSize],
  )
  const pagedActiveQueries = useMemo(
    () => sliceForPage(activeQueries, livePage, livePageSize),
    [activeQueries, livePage, livePageSize],
  )
  const pagedAppRows = useMemo(
    () => sliceForPage(appRows, appPage, appPageSize),
    [appRows, appPage, appPageSize],
  )

  // ----- 加载逻辑 -----
  const loadExtension = async () => {
    try {
      const res = await queryPerfAPI.getExtensionStatus()
      setExtStatus(res.data)
    } catch (err: any) {
      notify.error(err)
    }
  }

  const loadPgStats = async () => {
    setPgLoading(true)
    try {
      const res = await queryPerfAPI.listStatements({
        order_by: 'max_exec_time',
        limit: 100,
        min_max_ms: thresholdMs,
      })
      setPgStats(res.data || [])
      setPgPage(1)
    } catch (err: any) {
      notify.error(err)
      setPgStats([])
      setPgPage(1)
    } finally {
      setPgLoading(false)
    }
  }

  const loadActive = async () => {
    setActiveLoading(true)
    try {
      const res = await queryPerfAPI.listActiveQueries({
        min_duration_ms: thresholdMs,
        limit: 200,
      })
      setActiveQueries(res.data || [])
      setLivePage(1)
    } catch (err: any) {
      notify.error(err)
      setActiveQueries([])
      setLivePage(1)
    } finally {
      setActiveLoading(false)
    }
  }

  const loadApp = async () => {
    if (databaseId == null) {
      setAppRows([])
      setAppPage(1)
      return
    }
    setAppLoading(true)
    try {
      const res = await api.get('/api/admin/slow-queries', {
        params: { limit: 100, min_duration_ms: thresholdMs, database_id: databaseId },
      })
      setAppRows(res.data?.data || [])
      setAppPage(1)
    } catch (err: any) {
      // 普通租户用户可能没权限——给个温和提示就好，不阻塞页面
      if (err?.response?.status === 403) {
        setAppRows([])
      } else {
        notify.error(err)
      }
      setAppPage(1)
    } finally {
      setAppLoading(false)
    }
  }

  const reload = () => {
    if (tab === 'pg_stats') loadPgStats()
    else if (tab === 'live') loadActive()
    else loadApp()
  }

  useEffect(() => {
    loadExtension()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, projectId, databaseId])

  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(reload, 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, tab, thresholdMs, databaseId])

  const handleApplyThreshold = () => reload()

  // 把慢 SQL 交给 AI 助手分析优化
  const analyzeSlowWithAi = (sqlText: string) => {
    if (!sqlText?.trim()) return
    askAi({
      prompt: t('aiPrompt', { sql: sqlText.trim() }),
      requestId: genRequestId('slow-analyze'),
    })
  }

  const handleCancel = async () => {
    if (!cancelTarget) return
    setCancelling(true)
    try {
      await queryPerfAPI.cancelActiveQuery(cancelTarget.pid, cancelTerminate)
      notify.success(
        cancelTerminate
          ? t('terminatedProc', { pid: cancelTarget.pid })
          : t('cancelledQuery', { pid: cancelTarget.pid }),
      )
      setCancelTarget(null)
      setCancelTerminate(false)
      await loadActive()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setCancelling(false)
    }
  }

  const stats = useMemo(() => {
    return {
      pgCount: pgStats.length,
      liveCount: activeQueries.length,
      appCount: appRows.length,
      worstMean: pgStats[0]?.mean_exec_time ?? 0,
      worstLive:
        activeQueries.length > 0
          ? Math.max(...activeQueries.map((q) => q.duration_seconds))
          : 0,
    }
  }, [pgStats, activeQueries, appRows])

  return (
    <div className="space-y-6">
      {/* 顶部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('subtitle')}
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <label className="flex items-center space-x-2 cursor-pointer text-sm text-gray-600">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded"
            />
            <span>{t('autoRefresh')}</span>
          </label>
          <button onClick={reload} className="btn-default text-sm">
            <i className="fas fa-sync-alt mr-1"></i>{t('refresh')}
          </button>
        </div>
      </div>

      {/* 阈值 */}
      <div className="card p-4 flex items-end space-x-3">
        <div className="flex-1 max-w-xs">
          <label className="block text-xs text-gray-500 mb-1">
            {t('thresholdLabel')}
          </label>
          <input
            type="number"
            min={0}
            value={thresholdMs}
            onChange={(e) =>
              setThresholdMs(Math.max(0, Number(e.target.value) || 0))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleApplyThreshold()
            }}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button onClick={handleApplyThreshold} className="btn-primary text-sm">
          {t('apply')}
        </button>
        {[200, 500, 1000, 3000].map((v) => (
          <button
            key={v}
            onClick={() => {
              setThresholdMs(v)
              setTimeout(reload, 0)
            }}
            className={`text-xs px-2 py-1 rounded border ${
              thresholdMs === v
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {v} ms
          </button>
        ))}
      </div>

      {/* 概览 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard
          icon="fa-list-ol"
          label={t('sumPgHit')}
          value={String(stats.pgCount)}
          color="blue"
        />
        <SummaryCard
          icon="fa-bolt"
          label={t('sumLiveSlow')}
          value={String(stats.liveCount)}
          color={stats.liveCount > 0 ? 'red' : 'gray'}
        />
        <SummaryCard
          icon="fa-stopwatch"
          label={t('sumWorstMean')}
          value={fmtMs(stats.worstMean)}
          color="purple"
        />
        <SummaryCard
          icon="fa-history"
          label={t('sumAppRecords')}
          value={String(stats.appCount)}
          color="emerald"
        />
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg w-fit">
        {(
          [
            ['pg_stats', t('tabPgStats'), 'fa-database'],
            ['live', t('tabLive'), 'fa-bolt'],
            ['app', t('tabApp'), 'fa-history'],
          ] as [Tab, string, string][]
        ).map(([key, label, icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <i className={`fas ${icon} mr-2`}></i>
            {label}
          </button>
        ))}
      </div>

      {/* pg_stat_statements 慢查询 */}
      {tab === 'pg_stats' && (
        <div className="space-y-3">
          {extStatus && extStatus.install_hint && (
            <div className="card p-3 border-l-4 border-yellow-400 bg-yellow-50 text-sm text-yellow-800">
              <i className="fas fa-exclamation-triangle mr-2"></i>
              {extStatus.install_hint}
              {t('extHintSuffix')}
            </div>
          )}
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <th className="px-4 py-3">SQL</th>
                    <th className="px-4 py-3 text-right">{t('thCalls')}</th>
                    <th className="px-4 py-3 text-right">{t('thAvg')}</th>
                    <th className="px-4 py-3 text-right">{t('thMax')}</th>
                    <th className="px-4 py-3 text-right">{t('thTotal')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {pgLoading && pgStats.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                        <i className="fas fa-spinner fa-spin mr-2"></i>{t('loading')}
                      </td>
                    </tr>
                  )}
                  {!pgLoading && pgStats.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                        {extStatus?.install_hint
                          ? extStatus.install_hint
                          : t('noStmtsOverThreshold', { ms: thresholdMs })}
                      </td>
                    </tr>
                  )}
                  {pagedPgStats.map((s, i) => (
                    <tr
                      key={`${s.queryid ?? 'q'}-${(pgPage - 1) * pgPageSize + i}`}
                      className="hover:bg-blue-50 cursor-pointer"
                      onClick={() => setDetailQuery(s.query)}
                    >
                      <td className="px-4 py-3 max-w-xl">
                        <code className="font-mono text-xs text-gray-800 line-clamp-2 break-all">
                          {s.query}
                        </code>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {fmtNum(s.calls)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-gray-900">
                        {fmtMs(s.mean_exec_time)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {fmtMs(s.max_exec_time)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {fmtMs(s.total_exec_time)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pgStats.length > 0 && (
              <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/40">
                <Pagination
                  total={pgStats.length}
                  page={pgPage}
                  pageSize={pgPageSize}
                  onPageChange={setPgPage}
                  onPageSizeChange={(size) => {
                    setPgPageSize(size)
                    setPgPage(1)
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* 实时活跃查询 */}
      {tab === 'live' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">PID</th>
                  <th className="px-4 py-3">{t('thUser')}</th>
                  <th className="px-4 py-3">{t('thClient')}</th>
                  <th className="px-4 py-3">{t('thState')}</th>
                  <th className="px-4 py-3 text-right">{t('thRunning')}</th>
                  <th className="px-4 py-3">SQL</th>
                  <th className="px-4 py-3 text-right">{t('thActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {activeLoading && activeQueries.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                      <i className="fas fa-spinner fa-spin mr-2"></i>{t('loading')}
                    </td>
                  </tr>
                )}
                {!activeLoading && activeQueries.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                      {t('noRunningOverThreshold', { ms: thresholdMs })}
                    </td>
                  </tr>
                )}
                {pagedActiveQueries.map((q) => (
                  <tr key={q.pid} className="hover:bg-blue-50">
                    <td className="px-4 py-3 font-mono text-xs">{q.pid}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-gray-900">{q.user || '-'}</div>
                      {q.application_name && (
                        <div className="text-xs text-gray-500">{q.application_name}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-600">
                      {q.client_addr || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <StateBadge state={q.state} />
                      {q.wait_event && (
                        <div className="text-xs text-gray-500 mt-1">
                          {q.wait_event_type}: {q.wait_event}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap font-medium">
                      {fmtSeconds(q.duration_seconds)}
                    </td>
                    <td className="px-4 py-3 max-w-md">
                      <code
                        className="font-mono text-xs text-gray-800 line-clamp-2 break-all cursor-pointer hover:underline"
                        onClick={() => setDetailQuery(q.query)}
                      >
                        {q.query || '-'}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => {
                          setCancelTarget(q)
                          setCancelTerminate(false)
                        }}
                      >
                        {t('cancelBtn')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {activeQueries.length > 0 && (
            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/40">
              <Pagination
                total={activeQueries.length}
                page={livePage}
                pageSize={livePageSize}
                onPageChange={setLivePage}
                onPageSizeChange={(size) => {
                  setLivePageSize(size)
                  setLivePage(1)
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* 应用层 slow_query_logs */}
      {tab === 'app' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">{t('thTime')}</th>
                  <th className="px-4 py-3">{t('thDbTable')}</th>
                  <th className="px-4 py-3 text-right">{t('thDuration')}</th>
                  <th className="px-4 py-3">{t('thSqlPreview')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {appLoading && appRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-gray-400">
                      <i className="fas fa-spinner fa-spin mr-2"></i>{t('loading')}
                    </td>
                  </tr>
                )}
                {!appLoading && appRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-gray-400">
                      {t('noAppSlowRecords', { ms: thresholdMs })}
                    </td>
                  </tr>
                )}
                {pagedAppRows.map((r) => (
                  <tr
                    key={r.id}
                    className="hover:bg-blue-50 cursor-pointer"
                    onClick={() => setDetailQuery(r.sql_preview || '')}
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-600">
                      {fmtTime(r.created_at)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-gray-900">
                        {r.schema_name || '-'}
                        {r.table_name ? `.${r.table_name}` : ''}
                      </div>
                      <div className="text-xs text-gray-500">DB#{r.database_id ?? '-'}</div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap font-medium">
                      {fmtMs(r.duration_ms)}
                    </td>
                    <td className="px-4 py-3 max-w-xl">
                      <code className="font-mono text-xs text-gray-800 line-clamp-2 break-all">
                        {r.sql_preview || '-'}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {appRows.length > 0 && (
            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/40">
              <Pagination
                total={appRows.length}
                page={appPage}
                pageSize={appPageSize}
                onPageChange={setAppPage}
                onPageSizeChange={(size) => {
                  setAppPageSize(size)
                  setAppPage(1)
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* 详情抽屉 —— 完整 SQL */}
      <Drawer
        isOpen={!!detailQuery}
        onClose={() => setDetailQuery(null)}
        title={t('fullSql')}
        size="xl"
        footer={
          <div className="flex justify-end">
            <button
              onClick={() => detailQuery && analyzeSlowWithAi(detailQuery)}
              className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg text-white bg-gradient-to-br from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 transition-colors"
            >
              <i className="fas fa-robot mr-2"></i>
              {t('aiAnalyze')}
            </button>
          </div>
        }
      >
        <pre className="bg-gray-900 text-green-300 text-xs font-mono p-4 rounded-md overflow-auto max-h-[70vh] whitespace-pre-wrap">
          {detailQuery}
        </pre>
      </Drawer>

      {/* 取消查询确认 */}
      <Drawer
        isOpen={!!cancelTarget}
        onClose={() => !cancelling && setCancelTarget(null)}
        title={t('cancelRunning')}
        size="lg"
        footer={
          <div className="flex justify-end space-x-2">
            <button
              className="btn-default"
              onClick={() => setCancelTarget(null)}
              disabled={cancelling}
            >
              {t('dontCancel')}
            </button>
            <button
              className="btn-primary bg-red-600 hover:bg-red-700"
              onClick={handleCancel}
              disabled={cancelling}
            >
              {cancelling
                ? t('running')
                : cancelTerminate
                ? t('terminateProc')
                : t('cancelThisQuery')}
            </button>
          </div>
        }
      >
        {cancelTarget && (
          <div className="space-y-3 text-sm text-gray-700">
            <div className="bg-gray-50 rounded p-3">
              <div className="text-xs text-gray-500 mb-1">PID</div>
              <div className="font-mono">{cancelTarget.pid}</div>
              <div className="text-xs text-gray-500 mt-2 mb-1">{t('runningLabel')}</div>
              <div>{fmtSeconds(cancelTarget.duration_seconds)}</div>
              <div className="text-xs text-gray-500 mt-2 mb-1">SQL</div>
              <pre className="bg-gray-900 text-green-300 text-xs font-mono p-2 rounded overflow-auto max-h-32 whitespace-pre-wrap">
                {cancelTarget.query}
              </pre>
            </div>
            <label className="flex items-start space-x-2 cursor-pointer">
              <input
                type="checkbox"
                checked={cancelTerminate}
                onChange={(e) => setCancelTerminate(e.target.checked)}
                className="mt-0.5 w-4 h-4"
              />
              <div>
                <div className="font-medium text-gray-900">{t('alsoTerminate')}</div>
                <div className="text-xs text-gray-500">
                  {t.rich('terminateHint', { code: (c) => <code>{c}</code> })}
                </div>
              </div>
            </label>
            <p className="text-xs text-yellow-700 bg-yellow-50 p-2 rounded">
              {t('superAdminOnly')}
            </p>
          </div>
        )}
      </Drawer>
    </div>
  )
}

function SummaryCard({
  icon,
  label,
  value,
  color,
}: {
  icon: string
  label: string
  value: string
  color: 'blue' | 'red' | 'purple' | 'emerald' | 'gray'
}) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-600',
    red: 'bg-red-100 text-red-600',
    purple: 'bg-purple-100 text-purple-600',
    emerald: 'bg-emerald-100 text-emerald-600',
    gray: 'bg-gray-100 text-gray-600',
  }
  return (
    <div className="card p-4 flex items-center space-x-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colorMap[color]}`}>
        <i className={`fas ${icon}`}></i>
      </div>
      <div>
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-lg font-semibold text-gray-900">{value}</div>
      </div>
    </div>
  )
}

function StateBadge({ state }: { state: string }) {
  const cls =
    state === 'active'
      ? 'bg-green-100 text-green-800'
      : state === 'idle in transaction'
      ? 'bg-orange-100 text-orange-800'
      : state.startsWith('idle')
      ? 'bg-gray-100 text-gray-700'
      : 'bg-blue-100 text-blue-800'
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {state || '-'}
    </span>
  )
}
