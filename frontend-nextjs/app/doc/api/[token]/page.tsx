'use client'

/**
 * 项目 REST API 接口文档的公开只读页（免登录）。
 *
 * 凭分享 token 从后端公开接口取 database_slug / schema / 项目名，用与登录态页面共用的
 * `restApiDoc.ts` 模板（经 `RestApiDocContent`）渲染。链接被关闭或不存在时返回 404。
 *
 * 位于 workspace 布局之外，根 layout 不强制登录，故未登录访客也能访问。
 */

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import RestApiDocContent from '@/components/api/RestApiDocContent'
import { resolvePublicApiBase } from '@/lib/apiBase'

interface RestDocModel {
  database_slug: string
  schema: string
  project_name: string
  /** 后端下发的对外调用基址（网关域名）；缺省时前端兜底。 */
  api_base_url?: string
  /** 后端下发的是否走网关；true 时隐藏 API Key 鉴权头。 */
  gateway_mode?: boolean
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ok'; model: RestDocModel }
  | { status: 'notfound' }
  | { status: 'error'; message: string }

export default function PublicRestApiDocPage() {
  const t = useTranslations('docApiPage')
  const params = useParams<{ token: string }>()
  const token = params?.token
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    if (!token) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/public/rest-api-doc/${encodeURIComponent(token)}`, {
          headers: { Accept: 'application/json' },
        })
        if (cancelled) return
        if (res.status === 404) {
          setState({ status: 'notfound' })
          return
        }
        if (!res.ok) {
          setState({ status: 'error', message: t('loadFailedStatus', { status: res.status }) })
          return
        }
        const model = (await res.json()) as RestDocModel
        if (!cancelled) setState({ status: 'ok', model })
      } catch {
        if (!cancelled) setState({ status: 'error', message: t('networkError') })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="mx-auto w-full max-w-4xl">
        {state.status === 'loading' && (
          <div className="bg-white rounded-xl shadow-sm p-8 text-center text-sm text-gray-400">{t('loading')}</div>
        )}

        {state.status === 'notfound' && (
          <div className="bg-white rounded-xl shadow-sm p-10 text-center">
            <div className="text-4xl mb-3">🔗</div>
            <h1 className="text-lg font-semibold text-gray-800 mb-1">{t('linkNotFoundTitle')}</h1>
            <p className="text-sm text-gray-500">{t('linkNotFoundDesc')}</p>
          </div>
        )}

        {state.status === 'error' && (
          <div className="bg-white rounded-xl shadow-sm p-10 text-center">
            <h1 className="text-lg font-semibold text-gray-800 mb-1">{t('loadFailedTitle')}</h1>
            <p className="text-sm text-gray-500">{state.message}</p>
          </div>
        )}

        {state.status === 'ok' && (
          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-sm px-6 py-4">
              <h1 className="text-xl font-bold text-gray-900">
                {t('pageTitle', { projectName: state.model.project_name || t('defaultProjectName') })}
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                {t('pageSubtitle')}
              </p>
            </div>
            <RestApiDocContent apiBaseUrl={resolvePublicApiBase(state.model.api_base_url)} databaseSlug={state.model.database_slug} schema={state.model.schema} gatewayMode={!!state.model.gateway_mode} />
            <div className="text-center text-[11px] text-gray-300">{t('footerBrandLine')}</div>
          </div>
        )}
      </div>
    </div>
  )
}
