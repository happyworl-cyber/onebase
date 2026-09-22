'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import api, { type ApiRequestConfig } from '@/lib/api'
import { showToast } from '@/components/Toast'
import { workflowEditorPath, workflowVersionsPath } from './paths'
import WorkflowVersionList from './WorkflowVersionList'
import WorkflowVersionCanvas from './WorkflowVersionCanvas'
import type {
  WorkflowVersionHeader,
  WorkflowVersionListItem,
  WorkflowVersionSnapshot,
} from './types'

const silent = { suppressErrorToast: true } as ApiRequestConfig

function apiError(err: any, fallback: string): string {
  return err?.response?.data?.error || err?.message || fallback
}

export default function WorkflowVersionBrowser({
  projectId,
  workflowId,
  version,
  versionInvalid = false,
}: {
  projectId: number
  workflowId: number
  version: number | null
  versionInvalid?: boolean
}) {
  const t = useTranslations('wfCanvas')
  const router = useRouter()
  const [header, setHeader] = useState<WorkflowVersionHeader | null>(null)
  const [headerError, setHeaderError] = useState<string | null>(null)
  const [headerLoading, setHeaderLoading] = useState(true)

  const [versions, setVersions] = useState<WorkflowVersionListItem[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)

  const [snapshot, setSnapshot] = useState<WorkflowVersionSnapshot | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(version != null && !versionInvalid)
  const [fetchedVersion, setFetchedVersion] = useState<number | null>(null)
  const [detailNonce, setDetailNonce] = useState(0)
  const [restoring, setRestoring] = useState(false)

  const loadHeader = useCallback(async () => {
    setHeaderLoading(true)
    setHeaderError(null)
    try {
      const res = await api.get(`/api/admin/workflows/${workflowId}`, silent)
      const wf = res.data.workflow
      setHeader({ id: wf.id, name: wf.name, slug: wf.slug })
    } catch (err: any) {
      setHeader(null)
      setHeaderError(apiError(err, t('loadWfFailed')))
    } finally {
      setHeaderLoading(false)
    }
  }, [workflowId])

  const loadList = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const res = await api.get(`/api/admin/workflows/${workflowId}/versions`, {
        ...silent,
        params: { limit: 200 },
      })
      setVersions(res.data.versions || [])
    } catch (err: any) {
      setVersions([])
      setListError(apiError(err, t('loadVersionsFailed')))
    } finally {
      setListLoading(false)
    }
  }, [workflowId])

  useEffect(() => {
    void loadHeader()
    void loadList()
  }, [loadHeader, loadList])

  useEffect(() => {
    if (versionInvalid) {
      setSnapshot(null)
      setDetailError(t('versionNotFound'))
      setDetailLoading(false)
      return
    }
    if (version == null) {
      setSnapshot(null)
      setDetailError(null)
      setDetailLoading(false)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    setSnapshot(null)
    api
      .get(`/api/admin/workflows/${workflowId}/versions/${version}`, silent)
      .then((res) => {
        if (!cancelled) setSnapshot(res.data.version)
      })
      .catch((err: any) => {
        if (!cancelled) {
          setSnapshot(null)
          setDetailError(
            err?.response?.status === 404 ? t('versionNotFound') : apiError(err, t('loadDetailFailed')),
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFetchedVersion(version)
          setDetailLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [workflowId, version, versionInvalid, detailNonce])

  const validSelected = version != null && !versionInvalid
  const latestVersion = versions.reduce((max, v) => Math.max(max, v.version), 0)
  const canRestore =
    version != null &&
    !versionInvalid &&
    !detailLoading &&
    !detailError &&
    snapshot?.version === version &&
    latestVersion > 0 &&
    version !== latestVersion

  const restore = async () => {
    if (!canRestore || restoring) return
    if (
      !confirm(t('confirmRestore', { v: version }))
    ) {
      return
    }
    setRestoring(true)
    try {
      await api.post(`/api/admin/workflows/${workflowId}/versions/${version}/restore`, undefined, silent)
      showToast('success', t('restoredOk', { v: version }))
      await Promise.all([loadList(), loadHeader()])
    } catch (err: any) {
      showToast('error', apiError(err, t('restoreFailed')))
    } finally {
      setRestoring(false)
    }
  }

  if (headerLoading && !header) {
    return <div className="p-8 text-center text-slate-400 text-sm">{t('loading')}</div>
  }

  if (headerError || !header) {
    return (
      <div className="p-8 text-center space-y-3">
        <p className="text-sm text-slate-600">{headerError || t('wfNotFound')}</p>
        <button type="button" onClick={() => void loadHeader()} className="text-sm text-indigo-600 hover:underline">
          {t('retry')}
        </button>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <div className="font-medium text-slate-800 truncate">{header.name}</div>
          <div className="text-xs font-mono text-slate-400">{header.slug}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={workflowEditorPath(projectId, workflowId)}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            {t('openEditor')}
          </Link>
          {canRestore && (
            <button
              type="button"
              disabled={restoring}
              onClick={() => void restore()}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-indigo-300 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"
            >
              {restoring ? t('restoring') : t('restoreToVersion')}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <WorkflowVersionList
          versions={versions}
          selectedVersion={version}
          loading={listLoading}
          error={listError}
          onRetry={() => void loadList()}
          onSelect={(v) => router.replace(workflowVersionsPath(projectId, workflowId, v))}
        />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {version == null && !versionInvalid ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
              {t('selectVersion')}
            </div>
          ) : versionInvalid ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-600">{t('versionNotFound')}</div>
          ) : validSelected && snapshot != null && snapshot.version === version && !detailLoading ? (
            <WorkflowVersionCanvas snapshot={snapshot} />
          ) : validSelected && !detailLoading && detailError && fetchedVersion === version ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-slate-600">
              <p>{detailError}</p>
              <button
                type="button"
                onClick={() => setDetailNonce((n) => n + 1)}
                className="text-xs text-indigo-600 hover:underline"
              >
                {t('retry')}
              </button>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-400">{t('loading')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
