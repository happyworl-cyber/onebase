'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import {
  projectLogSourceAPI,
  type CloudLogLine,
  type ProjectLogSource,
} from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'
import { oversizeWindowError } from './window'

function toLocalInput(unix: number): string {
  const d = new Date(unix * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(v: string): number | undefined {
  if (!v) return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
}

function contentStr(contents: Record<string, unknown>, key: string): string {
  const v = contents[key]
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** 只有能准确指向控制台的 provider 才给按钮文案，避免写死「阿里云」。 */
function consoleLabelFor(provider: string | undefined): string | null {
  if (provider === 'aliyun_sls') return '在阿里云打开'
  return null
}

const GENERIC_MESSAGES = new Set(['HTTP request completed'])

/** 采集侧元数据、已单独成列或已编进摘要标题的字段，不重复堆在内容里。 */
const SUMMARY_SKIP_KEYS = new Set([
  'level',
  'logger',
  'message',
  'content',
  'x_request_id',
  'taskName',
  'timestamp',
  'method',
  'path',
  'status',
  'elapsed_ms',
])

function isInfraLogKey(key: string): boolean {
  return key.startsWith('_') || key.startsWith('__')
}

function formatAccessHeadline(contents: Record<string, unknown>): string {
  const method = contentStr(contents, 'method')
  const path = contentStr(contents, 'path')
  if (!method && !path) return ''
  const status = contentStr(contents, 'status')
  const elapsed = contentStr(contents, 'elapsed_ms')
  return [method, path, status, elapsed ? `${elapsed}ms` : ''].filter(Boolean).join(' ')
}

/** 把 method/path/status 和其余业务字段收成一行，避免只看见套话 message。 */
function formatLogSummary(contents: Record<string, unknown>): string {
  const parts: string[] = []
  const headline = formatAccessHeadline(contents)
  if (headline) parts.push(headline)

  const msg = contentStr(contents, 'message')
  if (msg && !GENERIC_MESSAGES.has(msg)) {
    parts.push(msg)
  } else if (!headline) {
    const fallback = msg || contentStr(contents, 'content')
    if (fallback) parts.push(fallback)
  }

  const extras: string[] = []
  for (const key of Object.keys(contents).sort()) {
    if (isInfraLogKey(key) || SUMMARY_SKIP_KEYS.has(key)) continue
    const v = contentStr(contents, key)
    if (!v) continue
    extras.push(`${key}=${v}`)
  }
  if (extras.length) parts.push(extras.join(' '))
  return parts.join('  ·  ')
}

export default function ProjectCloudLogsPage() {
  const params = useParams<{ projectId: string }>()
  const search = useSearchParams()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()
  const notify = useNotification()

  const nowSec = Math.floor(Date.now() / 1000)
  const qFrom = search.get('from')
  const qTo = search.get('to')

  const [sources, setSources] = useState<ProjectLogSource[] | null>(null)
  const [sourceId, setSourceId] = useState<number | ''>('')
  const [fromLocal, setFromLocal] = useState(() =>
    toLocalInput(qFrom ? Number(qFrom) : nowSec - 3600),
  )
  const [toLocal, setToLocal] = useState(() => toLocalInput(qTo ? Number(qTo) : nowSec))
  const [keyword, setKeyword] = useState('')
  const [requestId, setRequestId] = useState(search.get('trace_id') ?? '')
  const [loading, setLoading] = useState(false)
  const [logs, setLogs] = useState<CloudLogLine[] | null>(null)
  const [consoleUrl, setConsoleUrl] = useState<string | null>(null)
  const [openRow, setOpenRow] = useState<number | null>(null)

  useEffect(() => {
    if (!Number.isFinite(projectId) || !caps.canManageSecurity) return
    projectLogSourceAPI
      .list(projectId)
      .then((res) => {
        setSources(res.data)
        const wanted = Number(search.get('source_id'))
        if (res.data.some((s) => s.id === wanted)) {
          setSourceId(wanted)
        } else if (res.data.length === 1) {
          setSourceId(res.data[0].id)
        }
      })
      .catch((err: unknown) => notify.error(err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, caps.canManageSecurity])

  const queryBody = useMemo(
    () => ({
      from: fromLocalInput(fromLocal),
      to: fromLocalInput(toLocal),
      query: keyword.trim() || undefined,
      x_request_id: requestId.trim() || undefined,
    }),
    [fromLocal, toLocal, keyword, requestId],
  )

  const selectedSource = sources?.find((s) => s.id === sourceId)
  const consoleLabel = consoleLabelFor(selectedSource?.provider)

  const handleQuery = async () => {
    if (sourceId === '') return notify.warning('请选择日志源')
    const spanErr = oversizeWindowError(queryBody.from, queryBody.to)
    if (spanErr) return notify.error(spanErr)
    setLoading(true)
    try {
      const res = await projectLogSourceAPI.query(projectId, sourceId, queryBody)
      setLogs(res.data.logs)
      setConsoleUrl(consoleLabel ? res.data.console_url : null)
      setOpenRow(null)
    } catch (err: unknown) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }

  const openConsole = async () => {
    if (!consoleLabel) return
    if (consoleUrl) {
      window.open(consoleUrl, '_blank', 'noopener')
      return
    }
    const spanErr = oversizeWindowError(queryBody.from, queryBody.to)
    if (spanErr) return notify.error(spanErr)
    if (sourceId === '') return notify.warning('请选择日志源')
    try {
      const res = await projectLogSourceAPI.consoleUrl(projectId, sourceId, queryBody)
      window.open(res.data.console_url, '_blank', 'noopener')
    } catch (err: unknown) {
      notify.error(err)
    }
  }

  if (!caps.canManageSecurity) {
    return <ForbiddenPlaceholder reason="云日志需要项目 admin 或 owner 角色（或平台超管）" />
  }

  return (
    <div className="p-6 max-w-[1400px] space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">云日志</h1>
        <p className="text-sm text-gray-500 mt-1">
          按项目配置的 SLS 日志源查询。未配置时请先到{' '}
          <Link
            href={`/workspace/${projectId}/settings/log-sources`}
            className="text-blue-600 hover:underline"
          >
            设置 → 云日志源
          </Link>
          。
        </p>
      </div>

      {sources && sources.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl py-12 text-center text-gray-400">
          还没有日志源。
          <Link
            href={`/workspace/${projectId}/settings/log-sources`}
            className="text-blue-600 hover:underline ml-1"
          >
            去配置
          </Link>
        </div>
      )}

      {sources && sources.length > 0 && (
        <>
          <div className="bg-white border border-gray-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <label className="block text-sm">
              <span className="text-gray-600">日志源</span>
              <select
                value={sourceId}
                onChange={(e) => {
                  setSourceId(e.target.value ? Number(e.target.value) : '')
                  setConsoleUrl(null)
                }}
                className="w-full input-base mt-1"
              >
                <option value="">请选择</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">开始</span>
              <input
                type="datetime-local"
                value={fromLocal}
                onChange={(e) => setFromLocal(e.target.value)}
                className="w-full input-base mt-1"
              />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">结束</span>
              <input
                type="datetime-local"
                value={toLocal}
                onChange={(e) => setToLocal(e.target.value)}
                className="w-full input-base mt-1"
              />
            </label>
            <p className="text-xs text-gray-500 sm:col-span-2 lg:col-span-3">单次最长 7 天</p>
            <label className="block text-sm">
              <span className="text-gray-600">关键字</span>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                className="w-full input-base mt-1 font-mono"
                placeholder="error"
              />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">x_request_id</span>
              <input
                value={requestId}
                onChange={(e) => setRequestId(e.target.value)}
                className="w-full input-base mt-1 font-mono"
                placeholder="与执行日志 trace_id 相同"
              />
            </label>
            <div className="flex items-end gap-2">
              <button onClick={handleQuery} disabled={loading} className="btn-primary">
                {loading ? '查询中...' : '查询'}
              </button>
              {consoleLabel && (
                <button onClick={openConsole} className="btn-default">
                  {consoleLabel}
                </button>
              )}
            </div>
          </div>

          {logs && (
            <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2 whitespace-nowrap">时间</th>
                    <th className="px-3 py-2 whitespace-nowrap">level</th>
                    <th className="px-3 py-2">内容</th>
                    <th className="px-3 py-2 whitespace-nowrap">logger</th>
                    <th className="px-3 py-2 whitespace-nowrap">x_request_id</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-gray-400">
                        没有匹配的日志
                      </td>
                    </tr>
                  )}
                  {logs.map((line, i) => {
                    const summary = formatLogSummary(line.contents)
                    return (
                      <Fragment key={`${line.time}-${i}`}>
                        <tr
                          className="border-t border-gray-100 cursor-pointer hover:bg-gray-50"
                          onClick={() => setOpenRow(openRow === i ? null : i)}
                        >
                          <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                            {line.time
                              ? new Date(line.time * 1000).toLocaleString()
                              : '—'}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                            {contentStr(line.contents, 'level')}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs max-w-3xl">
                            <span className="line-clamp-2" title={summary}>
                              {summary || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-600 whitespace-nowrap">
                            {contentStr(line.contents, 'logger')}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                            {contentStr(line.contents, 'x_request_id')}
                          </td>
                        </tr>
                        {openRow === i && (
                          <tr className="border-t border-gray-100">
                            <td colSpan={5} className="px-3 py-2 bg-gray-50">
                              <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-all">
                                {JSON.stringify(line.contents, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
              {logs.length > 0 && (
                <p className="px-3 py-2 text-xs text-gray-400 border-t border-gray-100">
                  点击一行查看完整字段
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
