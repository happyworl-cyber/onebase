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
          setState({ status: 'error', message: `加载失败（${res.status}）` })
          return
        }
        const model = (await res.json()) as RestDocModel
        if (!cancelled) setState({ status: 'ok', model })
      } catch {
        if (!cancelled) setState({ status: 'error', message: '网络异常，无法加载文档' })
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
          <div className="bg-white rounded-xl shadow-sm p-8 text-center text-sm text-gray-400">加载中…</div>
        )}

        {state.status === 'notfound' && (
          <div className="bg-white rounded-xl shadow-sm p-10 text-center">
            <div className="text-4xl mb-3">🔗</div>
            <h1 className="text-lg font-semibold text-gray-800 mb-1">链接不存在或已失效</h1>
            <p className="text-sm text-gray-500">该分享链接可能已被关闭，或从未存在。</p>
          </div>
        )}

        {state.status === 'error' && (
          <div className="bg-white rounded-xl shadow-sm p-10 text-center">
            <h1 className="text-lg font-semibold text-gray-800 mb-1">加载失败</h1>
            <p className="text-sm text-gray-500">{state.message}</p>
          </div>
        )}

        {state.status === 'ok' && (
          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-sm px-6 py-4">
              <h1 className="text-xl font-bold text-gray-900">
                {state.model.project_name || '项目'} · REST API 接口文档
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                数据表 CRUD、表结构 DDL 与 RPC 函数，均可配合 API Key 调用
              </p>
            </div>
            <RestApiDocContent apiBaseUrl={resolvePublicApiBase(state.model.api_base_url)} databaseSlug={state.model.database_slug} schema={state.model.schema} gatewayMode={!!state.model.gateway_mode} />
            <div className="text-center text-[11px] text-gray-300">OneBase · REST API 接口文档</div>
          </div>
        )}
      </div>
    </div>
  )
}
