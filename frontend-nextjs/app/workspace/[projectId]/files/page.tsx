'use client'

/**
 * `/workspace/[projectId]/files` — 只读浏览项目对象存储里的最新文件。
 *
 * 改文件在别处覆盖写入；本页 list/get/presign GET，不做上传删除。
 * 连接配置仍在「集成 → 对象存储」（admin）。
 */

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AxiosError } from 'axios'
import {
  objectStorageAPI,
  type ObjectStorageConnectionPublic,
} from '@/lib/api'
import { FileContentViewer } from '@/components/files/FileContentViewer'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import {
  breadcrumbParts,
  fileDisplayName,
  folderDisplayName,
  isGetTooLargeError,
  lastConnectionStorageKey,
  parentPrefix,
  previewLanguageFromKey,
} from '@/lib/objectStorageFiles'

type ListedObject = {
  key: string
  size?: number
  last_modified?: string
}

function apiErrorMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    const data = err.response?.data as { error?: string } | undefined
    if (typeof data?.error === 'string' && data.error) return data.error
    if (err.message) return err.message
  }
  if (err instanceof Error && err.message) return err.message
  return '请求失败'
}

function formatBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function parseListResult(result: Record<string, unknown>): {
  objects: ListedObject[]
  common_prefixes: string[]
  next_continuation_token: string | null
  is_truncated: boolean
} {
  const objects: ListedObject[] = []
  if (Array.isArray(result.objects)) {
    for (const item of result.objects) {
      if (item && typeof item === 'object' && typeof (item as ListedObject).key === 'string') {
        const row = item as ListedObject
        objects.push({
          key: row.key,
          size: typeof row.size === 'number' ? row.size : undefined,
          last_modified: typeof row.last_modified === 'string' ? row.last_modified : undefined,
        })
      }
    }
  }
  const common_prefixes = Array.isArray(result.common_prefixes)
    ? result.common_prefixes.filter((p): p is string => typeof p === 'string')
    : []
  const next =
    typeof result.next_continuation_token === 'string' ? result.next_continuation_token : null
  return {
    objects,
    common_prefixes,
    next_continuation_token: next,
    is_truncated: Boolean(result.is_truncated) || Boolean(next),
  }
}

export default function FilesPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const caps = useCurrentProjectCapabilities()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const urlConnection = searchParams.get('connection')
  const prefix = searchParams.get('prefix') ?? ''
  const selectedKey = searchParams.get('key') ?? ''

  const [catalog, setCatalog] = useState<ObjectStorageConnectionPublic[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [catalogLoading, setCatalogLoading] = useState(true)

  const [objects, setObjects] = useState<ListedObject[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [listError, setListError] = useState('')
  const [listLoading, setListLoading] = useState(false)
  const [continuation, setContinuation] = useState<string | null>(null)
  const [isTruncated, setIsTruncated] = useState(false)

  const [content, setContent] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewKind, setPreviewKind] = useState<'text' | 'binary' | 'too_large' | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const listTokenRef = useRef(0)
  const getTokenRef = useRef(0)

  const objectStorageHref = `/workspace/${params.projectId}/events/object-storage-connections`

  const writeQuery = useCallback(
    (next: { connection: number | null; prefix: string; key: string }) => {
      const sp = new URLSearchParams()
      if (next.connection != null) sp.set('connection', String(next.connection))
      if (next.prefix) sp.set('prefix', next.prefix)
      if (next.key) sp.set('key', next.key)
      const keys = ['connection', 'prefix', 'key'] as const
      const unchanged = keys.every((k) => (sp.get(k) || '') === (searchParams.get(k) || ''))
      if (unchanged) return
      const qs = sp.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  useEffect(() => {
    if (!Number.isFinite(projectId) || projectId <= 0) return
    let cancelled = false
    setCatalogLoading(true)
    setCatalogError('')
    objectStorageAPI
      .listCatalog(projectId)
      .then((res) => {
        if (cancelled) return
        setCatalog(res.data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setCatalog([])
        setCatalogError(apiErrorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const urlId = urlConnection ? parseInt(urlConnection, 10) : NaN
  const connectionInCatalog = Number.isFinite(urlId) && catalog.some((c) => c.id === urlId)
  const connectionId = connectionInCatalog ? urlId : null
  const connectionError =
    !catalogLoading && Boolean(urlConnection) && !connectionInCatalog
      ? '找不到该对象存储连接（已停用或不属于本项目）'
      : ''

  useEffect(() => {
    if (catalogLoading || catalog.length === 0 || urlConnection) return
    let stored: number | null = null
    try {
      const raw = localStorage.getItem(lastConnectionStorageKey(projectId))
      if (raw) stored = parseInt(raw, 10)
    } catch {
      stored = null
    }
    const picked =
      stored != null && catalog.some((c) => c.id === stored) ? stored : catalog[0].id
    writeQuery({ connection: picked, prefix, key: selectedKey })
  }, [catalog, catalogLoading, projectId, prefix, selectedKey, urlConnection, writeQuery])

  useEffect(() => {
    if (connectionId == null) return
    try {
      localStorage.setItem(lastConnectionStorageKey(projectId), String(connectionId))
    } catch {
      /* ignore quota */
    }
  }, [connectionId, projectId])

  const loadList = useCallback(
    async (opts?: { append?: boolean; token?: string }) => {
      if (connectionId == null) return
      const token = ++listTokenRef.current
      setListLoading(true)
      if (!opts?.append) {
        setListError('')
        setObjects([])
        setFolders([])
        setContinuation(null)
        setIsTruncated(false)
      }
      try {
        const args: Record<string, unknown> = {
          prefix: prefix || undefined,
          delimiter: '/',
          max_keys: 100,
        }
        if (opts?.token) args.continuation_token = opts.token
        const res = await objectStorageAPI.exec(connectionId, { op: 'list', args })
        if (token !== listTokenRef.current) return
        const parsed = parseListResult(res.data.result ?? {})
        setObjects((prev) => (opts?.append ? [...prev, ...parsed.objects] : parsed.objects))
        setFolders((prev) =>
          opts?.append ? [...prev, ...parsed.common_prefixes] : parsed.common_prefixes,
        )
        setContinuation(parsed.next_continuation_token)
        setIsTruncated(parsed.is_truncated)
      } catch (err: unknown) {
        if (token !== listTokenRef.current) return
        setListError(apiErrorMessage(err))
        if (!opts?.append) {
          setObjects([])
          setFolders([])
        }
      } finally {
        if (token === listTokenRef.current) setListLoading(false)
      }
    },
    [connectionId, prefix],
  )

  useEffect(() => {
    if (connectionId == null) {
      setObjects([])
      setFolders([])
      return
    }
    void loadList()
  }, [connectionId, prefix, loadList])

  const openFile = useCallback(
    async (key: string) => {
      if (connectionId == null) return
      const token = ++getTokenRef.current
      setPreviewLoading(true)
      setPreviewError('')
      setContent(null)
      setPreviewKind(null)
      try {
        const res = await objectStorageAPI.exec(connectionId, { op: 'get', args: { key } })
        if (token !== getTokenRef.current) return
        const result = res.data.result ?? {}
        if (typeof result.content === 'string') {
          setContent(result.content)
          setPreviewKind('text')
          return
        }
        if (typeof result.content_base64 === 'string') {
          setPreviewKind('binary')
          return
        }
        setPreviewError('无法读取文件内容')
      } catch (err: unknown) {
        if (token !== getTokenRef.current) return
        const msg = apiErrorMessage(err)
        if (isGetTooLargeError(msg)) {
          setPreviewKind('too_large')
          setPreviewError(msg)
        } else {
          setPreviewError(msg)
        }
      } finally {
        if (token === getTokenRef.current) setPreviewLoading(false)
      }
    },
    [connectionId],
  )

  useEffect(() => {
    if (connectionId == null || !selectedKey) {
      setContent(null)
      setPreviewKind(null)
      setPreviewError('')
      setPreviewLoading(false)
      return
    }
    void openFile(selectedKey)
  }, [connectionId, selectedKey, openFile])

  const crumbs = useMemo(() => breadcrumbParts(prefix), [prefix])
  const language = previewLanguageFromKey(selectedKey)
  const selectedConn = catalog.find((c) => c.id === connectionId)

  const downloadSelected = async () => {
    if (connectionId == null || !selectedKey) return
    setDownloading(true)
    try {
      const res = await objectStorageAPI.exec(connectionId, {
        op: 'presign',
        args: { key: selectedKey, method: 'GET' },
      })
      const url = res.data.result?.url
      if (typeof url !== 'string' || !url) {
        setPreviewError('无法生成下载地址')
        return
      }
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err: unknown) {
      setPreviewError(apiErrorMessage(err))
    } finally {
      setDownloading(false)
    }
  }

  const onRefresh = () => {
    void loadList()
    if (selectedKey) void openFile(selectedKey)
  }

  const goFolder = (nextPrefix: string) => {
    writeQuery({ connection: connectionId, prefix: nextPrefix, key: '' })
  }

  if (!Number.isFinite(projectId) || projectId <= 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        <i className="fas fa-spinner fa-spin text-2xl" />
        <p className="text-sm mt-2">正在加载项目上下文…</p>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-gray-600">
          连接
          <select
            className="ml-2 border border-gray-300 rounded px-2 py-1 text-sm bg-white"
            value={connectionId ?? ''}
            disabled={catalogLoading || catalog.length === 0}
            onChange={(e) => {
              const id = parseInt(e.target.value, 10)
              writeQuery({
                connection: Number.isFinite(id) ? id : null,
                prefix: '',
                key: '',
              })
            }}
          >
            {catalog.length === 0 ? <option value="">无连接</option> : null}
            {catalog.map((c) => (
              <option key={c.id} value={c.id}>
                {c.connection_name}（{c.bucket}）
              </option>
            ))}
          </select>
        </label>
        <nav className="flex items-center gap-1 text-sm text-gray-600 min-w-0 flex-1">
          <button
            type="button"
            className="hover:text-blue-600 disabled:text-gray-400"
            disabled={!prefix}
            onClick={() => goFolder('')}
          >
            {selectedConn?.bucket || '根目录'}
          </button>
          {crumbs.map((c) => (
            <span key={c.prefix} className="flex items-center gap-1 min-w-0">
              <span className="text-gray-400">/</span>
              <button
                type="button"
                className="hover:text-blue-600 truncate"
                onClick={() => goFolder(c.prefix)}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <button
          type="button"
          className="btn-default text-xs"
          onClick={onRefresh}
          disabled={connectionId == null || listLoading || previewLoading}
        >
          刷新
        </button>
      </div>

      {catalogError ? (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {catalogError}
        </div>
      ) : null}
      {connectionError ? (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {connectionError}
        </div>
      ) : null}

      {!catalogLoading && catalog.length === 0 && !catalogError ? (
        <div className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded px-3 py-4">
          请让项目管理员在「集成 → 对象存储」中配置连接。
          {caps.canManageEvents ? (
            <>
              {' '}
              <Link href={objectStorageHref} className="text-blue-600 hover:underline">
                打开对象存储
              </Link>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(240px,320px)_1fr] gap-3">
        <div className="border border-gray-200 rounded bg-white overflow-auto min-h-[240px]">
          {listError ? (
            <div className="p-3 text-sm text-red-600">{listError}</div>
          ) : catalogLoading || (catalog.length > 0 && connectionId == null && !connectionError) || (listLoading && objects.length === 0 && folders.length === 0) ? (
            <div className="p-6 text-center text-gray-400 text-sm">加载中…</div>
          ) : folders.length === 0 && objects.length === 0 ? (
            <div className="p-6 text-center text-gray-400 text-sm">这个目录下没有文件</div>
          ) : (
            <ul className="text-sm divide-y divide-gray-100">
              {prefix ? (
                <li>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 text-gray-600"
                    onClick={() => goFolder(parentPrefix(prefix))}
                  >
                    <i className="fas fa-level-up-alt mr-2" />
                    上级目录
                  </button>
                </li>
              ) : null}
              {folders.map((folder) => (
                <li key={folder}>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-gray-50"
                    onClick={() => goFolder(folder)}
                  >
                    <i className="fas fa-folder mr-2 text-amber-500" />
                    {folderDisplayName(folder, prefix)}
                  </button>
                </li>
              ))}
              {objects.map((obj) => (
                <li key={obj.key}>
                  <button
                    type="button"
                    className={`w-full text-left px-3 py-2 hover:bg-gray-50 ${
                      selectedKey === obj.key ? 'bg-blue-50' : ''
                    }`}
                    onClick={() =>
                      writeQuery({ connection: connectionId, prefix, key: obj.key })
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">
                        <i className="fas fa-file-code mr-2 text-sky-600" />
                        {fileDisplayName(obj.key, prefix)}
                      </span>
                      <span className="text-xs text-gray-400 shrink-0">{formatBytes(obj.size)}</span>
                    </div>
                    {obj.last_modified ? (
                      <div className="pl-6 text-xs text-gray-400 truncate">{obj.last_modified}</div>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {isTruncated && continuation ? (
            <div className="p-2 border-t border-gray-100">
              <button
                type="button"
                className="btn-default text-xs w-full"
                disabled={listLoading}
                onClick={() => void loadList({ append: true, token: continuation })}
              >
                加载更多
              </button>
            </div>
          ) : null}
        </div>

        <div className="border border-gray-200 rounded bg-white min-h-[240px] flex flex-col overflow-hidden">
          {!selectedKey ? (
            <div className="m-auto p-6 text-sm text-gray-400 text-center">
              从左侧打开文件，查看对象存储里的最新内容。
            </div>
          ) : (
            <>
              <div className="px-3 py-2 border-b border-gray-100 text-xs text-gray-500 flex items-center justify-between gap-2">
                <span className="truncate font-mono">{selectedKey}</span>
                {previewKind === 'binary' || previewKind === 'too_large' ? (
                  <button
                    type="button"
                    className="btn-default text-xs shrink-0"
                    disabled={downloading}
                    onClick={() => void downloadSelected()}
                  >
                    {downloading ? '准备下载…' : '下载'}
                  </button>
                ) : null}
              </div>
              <div className="flex-1 min-h-0">
                {previewLoading ? (
                  <div className="p-6 text-center text-gray-400 text-sm">加载中…</div>
                ) : previewKind === 'too_large' ? (
                  <div className="p-4 text-sm text-gray-700 space-y-2">
                    <p>文件超过 5 MiB，无法在页面里预览。</p>
                    {previewError ? <p className="text-gray-500">{previewError}</p> : null}
                  </div>
                ) : previewKind === 'binary' ? (
                  <div className="p-4 text-sm text-gray-700">不是文本，无法预览。</div>
                ) : previewError ? (
                  <div className="p-4 text-sm text-red-600">{previewError}</div>
                ) : content != null ? (
                  <FileContentViewer value={content} language={language} />
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
