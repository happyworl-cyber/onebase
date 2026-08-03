'use client'

/**
 * `/workspace/[projectId]/database/locks` —— 锁与阻塞观察台。
 *
 * 数据来自后端 `GET /api/monitor/locks`（pg_blocking_pids + pg_locks + pg_stat_activity）。
 * 每行是一对「被阻塞会话 ← 阻塞会话」关系：
 *   - 被阻塞侧：在等哪张表 / 哪种锁、等了多久、卡在哪条 SQL
 *   - 阻塞侧：哪个 PID 持锁、它在跑什么 SQL —— 通常这就是要被「杀掉」的进程
 *
 * 终止进程复用 `POST /api/query-perf/active/:pid/cancel`（仅平台超管可用）：
 *   - 取消查询：pg_cancel_backend（保留连接）
 *   - 终止后端：pg_terminate_backend（断开整条连接，释放它持有的全部锁）
 */

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { monitorAPI, queryPerfAPI, LockWait } from '@/lib/api'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'
import { askAi } from '@/lib/aiAssistant'
import { genRequestId } from '@/lib/embedBridge'
import { useAppStore } from '@/lib/store'

function fmtSeconds(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '-'
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(0)
  return `${m}m ${sec}s`
}

type KillTarget = {
  pid: number
  user: string
  query: string
  duration_seconds: number | null
}

export default function LocksPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const notify = useNotification()
  const currentConnection = useAppStore((s) => s.currentConnection)
  const databaseId = currentConnection?.database_id ?? null

  const [rows, setRows] = useState<LockWait[]>([])
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)

  const [detail, setDetail] = useState<LockWait | null>(null)
  const [killTarget, setKillTarget] = useState<KillTarget | null>(null)
  const [killTerminate, setKillTerminate] = useState(true)
  const [killing, setKilling] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await monitorAPI.getLockWaits()
      setRows(res.data || [])
    } catch (err: any) {
      notify.error(err)
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, databaseId])

  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, databaseId])

  const stats = useMemo(() => {
    const blockedPids = new Set(rows.map((r) => r.blocked_pid))
    const blockingPids = new Set(rows.map((r) => r.blocking_pid))
    const longest = rows.reduce(
      (max, r) => Math.max(max, r.blocked_duration_seconds ?? 0),
      0,
    )
    return {
      pairs: rows.length,
      blocked: blockedPids.size,
      blocking: blockingPids.size,
      longest,
    }
  }, [rows])

  const handleKill = async () => {
    if (!killTarget) return
    setKilling(true)
    try {
      await queryPerfAPI.cancelActiveQuery(killTarget.pid, killTerminate)
      notify.success(
        killTerminate
          ? `已请求终止后端进程 (pid=${killTarget.pid})`
          : `已请求取消查询 (pid=${killTarget.pid})`,
      )
      setKillTarget(null)
      await load()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setKilling(false)
    }
  }

  const analyzeWithAi = (r: LockWait) => {
    askAi({
      prompt:
        '下面是当前数据库的一处锁等待 / 阻塞关系，请分析阻塞成因、风险，并给出处理建议' +
        '（例如该终止哪个进程、如何避免再次发生、是否存在长事务 / 缺索引等问题）：\n\n' +
        `- 等待的对象（表）：${r.blocked_relation || '（非表级锁）'}\n` +
        `- 被阻塞会话申请的锁模式：${r.blocked_lock_mode || '-'}\n` +
        `- 被阻塞会话等待事件：${[r.wait_event_type, r.wait_event].filter(Boolean).join(': ') || '-'}\n` +
        `- 被阻塞会话已等待：${fmtSeconds(r.blocked_duration_seconds)}\n\n` +
        `被阻塞会话 SQL (pid=${r.blocked_pid}, user=${r.blocked_user || '-'})：\n` +
        '```sql\n' + (r.blocked_query || '-') + '\n```\n\n' +
        `阻塞方会话 SQL (pid=${r.blocking_pid}, user=${r.blocking_user || '-'}, state=${r.blocking_state || '-'})：\n` +
        '```sql\n' + (r.blocking_query || '-') + '\n```',
      requestId: genRequestId('lock-analyze'),
    })
  }

  return (
    <div className="space-y-6">
      {/* 顶部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">锁与阻塞</h1>
          <p className="text-sm text-gray-500 mt-1">
            基于 pg_blocking_pids / pg_locks 查看当前的锁等待关系，并可终止持锁进程
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
            <span>每 5s 自动刷新</span>
          </label>
          <button onClick={load} className="btn-default text-sm">
            <i className="fas fa-sync-alt mr-1"></i>刷新
          </button>
        </div>
      </div>

      {/* 概览 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard
          icon="fa-link"
          label="阻塞关系"
          value={String(stats.pairs)}
          color={stats.pairs > 0 ? 'red' : 'gray'}
        />
        <SummaryCard
          icon="fa-hand-paper"
          label="被阻塞会话"
          value={String(stats.blocked)}
          color={stats.blocked > 0 ? 'orange' : 'gray'}
        />
        <SummaryCard
          icon="fa-lock"
          label="持锁(阻塞)会话"
          value={String(stats.blocking)}
          color={stats.blocking > 0 ? 'purple' : 'gray'}
        />
        <SummaryCard
          icon="fa-stopwatch"
          label="最长等待"
          value={fmtSeconds(stats.longest)}
          color={stats.longest > 0 ? 'red' : 'gray'}
        />
      </div>

      {/* 阻塞列表 */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">等待对象 / 锁模式</th>
                <th className="px-4 py-3">被阻塞会话</th>
                <th className="px-4 py-3 text-right">已等待</th>
                <th className="px-4 py-3">阻塞方会话</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                    <i className="fas fa-spinner fa-spin mr-2"></i>加载中…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                    <i className="fas fa-check-circle text-green-400 mr-2"></i>
                    当前没有检测到锁等待 / 阻塞
                  </td>
                </tr>
              )}
              {rows.map((r, i) => (
                <tr
                  key={`${r.blocked_pid}-${r.blocking_pid}-${i}`}
                  className="hover:bg-red-50/40 align-top"
                >
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="font-medium text-gray-900">
                      {r.blocked_relation || (
                        <span className="text-gray-400">非表级锁</span>
                      )}
                    </div>
                    {r.blocked_lock_mode && (
                      <span className="inline-block mt-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
                        {r.blocked_lock_mode}
                      </span>
                    )}
                    {r.wait_event && (
                      <div className="text-xs text-gray-500 mt-1">
                        {r.wait_event_type}: {r.wait_event}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <div className="text-xs text-gray-500">
                      pid <span className="font-mono text-gray-700">{r.blocked_pid}</span>
                      {r.blocked_user ? ` · ${r.blocked_user}` : ''}
                    </div>
                    <code
                      className="font-mono text-xs text-gray-800 line-clamp-2 break-all cursor-pointer hover:underline"
                      onClick={() => setDetail(r)}
                    >
                      {r.blocked_query || '-'}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap font-medium text-red-600">
                    {fmtSeconds(r.blocked_duration_seconds)}
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <div className="text-xs text-gray-500">
                      pid{' '}
                      <span className="font-mono text-gray-700">{r.blocking_pid}</span>
                      {r.blocking_user ? ` · ${r.blocking_user}` : ''}
                      {r.blocking_state ? (
                        <span className="ml-1 text-gray-400">({r.blocking_state})</span>
                      ) : null}
                    </div>
                    <code
                      className="font-mono text-xs text-gray-800 line-clamp-2 break-all cursor-pointer hover:underline"
                      onClick={() => setDetail(r)}
                    >
                      {r.blocking_query || '-'}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap space-x-3">
                    <button
                      className="text-xs text-indigo-600 hover:underline"
                      onClick={() => analyzeWithAi(r)}
                    >
                      AI 分析
                    </button>
                    <button
                      className="text-xs text-red-600 hover:underline font-medium"
                      onClick={() => {
                        setKillTarget({
                          pid: r.blocking_pid,
                          user: r.blocking_user,
                          query: r.blocking_query,
                          duration_seconds: r.blocking_duration_seconds,
                        })
                        setKillTerminate(true)
                      }}
                    >
                      终止持锁进程…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 详情抽屉 —— 被阻塞 / 阻塞双方 SQL */}
      <Drawer
        isOpen={!!detail}
        onClose={() => setDetail(null)}
        title="锁等待详情"
        size="xl"
        footer={
          <div className="flex justify-end">
            <button
              onClick={() => detail && analyzeWithAi(detail)}
              className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg text-white bg-gradient-to-br from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 transition-colors"
            >
              <i className="fas fa-robot mr-2"></i>
              AI 分析
            </button>
          </div>
        }
      >
        {detail && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="等待对象" value={detail.blocked_relation || '非表级锁'} />
              <Field label="锁模式" value={detail.blocked_lock_mode || '-'} />
              <Field
                label="等待事件"
                value={
                  [detail.wait_event_type, detail.wait_event]
                    .filter(Boolean)
                    .join(': ') || '-'
                }
              />
              <Field
                label="已等待"
                value={fmtSeconds(detail.blocked_duration_seconds)}
              />
            </div>

            <div>
              <div className="text-xs font-medium text-gray-500 mb-1">
                被阻塞会话 SQL（pid {detail.blocked_pid}
                {detail.blocked_user ? ` · ${detail.blocked_user}` : ''}）
              </div>
              <pre className="bg-gray-900 text-amber-300 text-xs font-mono p-3 rounded-md overflow-auto max-h-60 whitespace-pre-wrap">
                {detail.blocked_query || '-'}
              </pre>
            </div>

            <div>
              <div className="text-xs font-medium text-gray-500 mb-1">
                阻塞方会话 SQL（pid {detail.blocking_pid}
                {detail.blocking_user ? ` · ${detail.blocking_user}` : ''}
                {detail.blocking_state ? ` · ${detail.blocking_state}` : ''}）
              </div>
              <pre className="bg-gray-900 text-green-300 text-xs font-mono p-3 rounded-md overflow-auto max-h-60 whitespace-pre-wrap">
                {detail.blocking_query || '-'}
              </pre>
            </div>
          </div>
        )}
      </Drawer>

      {/* 终止进程确认 */}
      <Drawer
        isOpen={!!killTarget}
        onClose={() => !killing && setKillTarget(null)}
        title="终止持锁进程"
        size="lg"
        footer={
          <div className="flex justify-end space-x-2">
            <button
              className="btn-default"
              onClick={() => setKillTarget(null)}
              disabled={killing}
            >
              取消
            </button>
            <button
              className="btn-primary bg-red-600 hover:bg-red-700"
              onClick={handleKill}
              disabled={killing}
            >
              {killing
                ? '执行中…'
                : killTerminate
                ? '终止后端进程'
                : '取消该查询'}
            </button>
          </div>
        }
      >
        {killTarget && (
          <div className="space-y-3 text-sm text-gray-700">
            <div className="bg-gray-50 rounded p-3">
              <div className="text-xs text-gray-500 mb-1">目标 PID（阻塞方）</div>
              <div className="font-mono">
                {killTarget.pid}
                {killTarget.user ? ` · ${killTarget.user}` : ''}
              </div>
              <div className="text-xs text-gray-500 mt-2 mb-1">已运行</div>
              <div>{fmtSeconds(killTarget.duration_seconds)}</div>
              <div className="text-xs text-gray-500 mt-2 mb-1">SQL</div>
              <pre className="bg-gray-900 text-green-300 text-xs font-mono p-2 rounded overflow-auto max-h-32 whitespace-pre-wrap">
                {killTarget.query || '-'}
              </pre>
            </div>
            <label className="flex items-start space-x-2 cursor-pointer">
              <input
                type="checkbox"
                checked={killTerminate}
                onChange={(e) => setKillTerminate(e.target.checked)}
                className="mt-0.5 w-4 h-4"
              />
              <div>
                <div className="font-medium text-gray-900">终止后端进程（推荐）</div>
                <div className="text-xs text-gray-500">
                  勾选后调用 <code>pg_terminate_backend()</code>，断开该连接并释放它持有的全部锁；
                  不勾选则只调用 <code>pg_cancel_backend()</code>，仅取消当前查询，若锁由事务持有可能仍不会释放。
                </div>
              </div>
            </label>
            <p className="text-xs text-yellow-700 bg-yellow-50 p-2 rounded">
              该操作仅平台超管可用，且会影响对应业务连接，请确认后再执行。
            </p>
          </div>
        )}
      </Drawer>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded p-2.5">
      <div className="text-xs text-gray-500 mb-0.5">{label}</div>
      <div className="text-gray-900 break-all">{value}</div>
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
  color: 'red' | 'orange' | 'purple' | 'gray'
}) {
  const colorMap: Record<string, string> = {
    red: 'bg-red-100 text-red-600',
    orange: 'bg-orange-100 text-orange-600',
    purple: 'bg-purple-100 text-purple-600',
    gray: 'bg-gray-100 text-gray-600',
  }
  return (
    <div className="card p-4 flex items-center space-x-3">
      <div
        className={`w-10 h-10 rounded-lg flex items-center justify-center ${colorMap[color]}`}
      >
        <i className={`fas ${icon}`}></i>
      </div>
      <div>
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-lg font-semibold text-gray-900">{value}</div>
      </div>
    </div>
  )
}
