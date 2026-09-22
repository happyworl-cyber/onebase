'use client'

/**
 * `/workspace/[projectId]/settings/gateway` —— 项目级对外调用基址（网关域名）。
 *
 * 每个项目可配置自己的对外基址，优先级高于平台全局设置；留空则回落到平台设置。
 * 保存后本项目的接口文档（工作流 / REST / RPC，含公开分享页）立即使用新域名，
 * 无需改代码 / 重启 / 重新构建。
 *
 * 鉴权：admin+（含 owner / 平台超管）。后端走 `require_tenant_admin`，前端用
 * `canManageMembers` 决定是否渲染。
 */

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { projectGatewayAPI, type ProjectGatewaySettings } from '@/lib/api'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import { useNotification } from '@/hooks/useNotification'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

export default function ProjectGatewayPage() {
  const t = useTranslations('wsGatewaySettings')
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params?.projectId ?? '', 10)
  const caps = useCurrentProjectCapabilities()
  const notify = useNotification()

  const [settings, setSettings] = useState<ProjectGatewaySettings | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await projectGatewayAPI.get(projectId)
      setSettings(res.data)
      setDraft(res.data.public_base_url ?? '')
    } catch (err: any) {
      notify.error(err)
      setSettings(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (Number.isFinite(projectId) && caps.canManageMembers) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, caps.canManageMembers])

  if (!caps.canManageMembers) {
    return <ForbiddenPlaceholder />
  }

  const trimmed = draft.trim().replace(/\/+$/, '')
  const invalid = trimmed !== '' && !/^https?:\/\//i.test(trimmed)
  const dirty = trimmed !== (settings?.public_base_url ?? '')

  const handleSave = async () => {
    if (invalid) {
      notify.error(t('errBaseScheme'))
      return
    }
    setSaving(true)
    try {
      await projectGatewayAPI.update(projectId, { public_base_url: trimmed === '' ? null : trimmed })
      notify.success(t('saved'))
      await load()
    } catch (err: any) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">{t('title')}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {t('subtitle')}
        </p>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl shadow-sm p-8 text-center text-sm text-slate-400">{t('loading')}</div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm p-6 space-y-5">
          <div>
            <h2 className="font-semibold text-slate-800">{t('cardTitle')}</h2>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed">
              {t('cardDesc1')}
              <span className="text-slate-700 font-medium">{t('cardDescStrong')}</span>{t('cardDesc2')}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t('urlLabel')}</label>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://gw.example.com"
              className={`w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 ${
                invalid
                  ? 'border-red-400 focus:ring-red-200'
                  : 'border-slate-300 focus:ring-indigo-200 focus:border-indigo-400'
              }`}
            />
            {invalid ? (
              <p className="text-xs text-red-500 mt-1">{t('mustStartWithScheme')}</p>
            ) : (
              <p className="text-xs text-slate-400 mt-1">{t('noTrailingSlashHint')}</p>
            )}
          </div>

          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-slate-500 w-28 shrink-0">{t('effective')}</span>
              <code className="text-slate-800 break-all">{settings?.effective_base_url || t('browserOrigin')}</code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-500 w-28 shrink-0">{t('platformDefault')}</span>
              <code className="text-slate-600 break-all">{settings?.platform_base_url || t('notConfigured')}</code>
            </div>
            <p className="text-xs text-slate-400 pt-1">
              {t('priority')}
            </p>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving || invalid || !dirty}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? t('saving') : t('save')}
            </button>
            {dirty && !saving && <span className="text-xs text-amber-600">{t('dirty')}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
