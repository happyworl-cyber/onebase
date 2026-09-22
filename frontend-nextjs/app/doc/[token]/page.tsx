'use client'

/**
 * 工作流接口文档的公开只读页（免登录）。
 *
 * 凭分享 token 从后端公开接口取提炼后的文档数据，用与登录态编辑器同一个
 * `WorkflowDocContent` 组件渲染。链接被作者关闭或不存在时返回 404，页面显示失效提示。
 *
 * 位于 workspace 布局之外，根 layout 不强制登录，故未登录访客也能访问。
 */

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import WorkflowDocContent, {
  buildDocMarkdown,
  CopyMarkdownButton,
  type DocModel,
} from '@/components/workflow/WorkflowDocContent'
import { resolvePublicApiBase } from '@/lib/apiBase'

type LoadState =
  | { status: 'loading' }
  | { status: 'ok'; model: DocModel }
  | { status: 'notfound' }
  | { status: 'error'; message: string }

export default function PublicWorkflowDocPage() {
  const t = useTranslations('docPage')
  const params = useParams<{ token: string }>()
  const token = params?.token
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    if (!token) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/public/workflow-doc/${encodeURIComponent(token)}`, {
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
        const model = (await res.json()) as DocModel
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
      <div className="mx-auto w-full max-w-3xl">
        {state.status === 'loading' && (
          <div className="bg-white rounded-xl shadow-sm p-8 text-center text-sm text-gray-400">
            {t('loading')}
          </div>
        )}

        {state.status === 'notfound' && (
          <div className="bg-white rounded-xl shadow-sm p-10 text-center">
            <div className="text-4xl mb-3">🔗</div>
            <h1 className="text-lg font-semibold text-gray-800 mb-1">{t('linkGone')}</h1>
            <p className="text-sm text-gray-500">{t('linkGoneDesc')}</p>
          </div>
        )}

        {state.status === 'error' && (
          <div className="bg-white rounded-xl shadow-sm p-10 text-center">
            <h1 className="text-lg font-semibold text-gray-800 mb-1">{t('loadFailed')}</h1>
            <p className="text-sm text-gray-500">{state.message}</p>
          </div>
        )}

        {state.status === 'ok' && (
          <div className="bg-white rounded-xl shadow-sm">
            <div className="px-6 py-4 border-b flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h1 className="font-semibold text-gray-800 truncate">
                  {t('docTitle', { name: state.model.name || t('unnamed') })}
                </h1>
                {state.model.description && (
                  <p className="text-xs text-gray-400 mt-0.5 truncate">{state.model.description}</p>
                )}
              </div>
              <CopyMarkdownButton
                text={buildDocMarkdown(
                  state.model,
                  resolvePublicApiBase(state.model.api_base_url),
                  t,
                  !!state.model.gateway_mode,
                )}
              />
            </div>
            <div className="p-6">
              <WorkflowDocContent
                model={state.model}
                apiBase={resolvePublicApiBase(state.model.api_base_url)}
                gatewayMode={!!state.model.gateway_mode}
              />
            </div>
            <div className="px-6 py-3 border-t text-center text-[11px] text-gray-300">
              {t('footer')}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
