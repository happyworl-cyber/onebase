'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import GatewayManager from '@/components/gateway/GatewayManager'
import { gatewayControlAPI } from '@/lib/gatewayApi'
import type { Project } from '@/lib/store'
import { useAppStore } from '@/lib/store'

function fallbackProjectSlug(projectId: string) {
  return `project-${projectId}`
}

export default function WorkspaceGatewayPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const currentProject = useAppStore((state: { currentProject: Project | null }) => state.currentProject)
  const projectSlug = currentProject?.slug || fallbackProjectSlug(params.projectId)
  const projectName = currentProject?.name || projectSlug
  const t = useTranslations('wsGateway')

  // 网关策略依赖独立的「网关控制面」（Go 服务，走 /gateway-admin，见 lib/gatewayApi.ts）。
  // 该控制面属可选/企业版基础设施；未部署时相关接口会 500。这里先探活一次，
  // 不可达就渲染友好占位，避免直接把整套管理界面挂上去连环报错。控制面部署可达后自动恢复。
  const [status, setStatus] = useState<'checking' | 'ok' | 'down'>('checking')

  useEffect(() => {
    let cancelled = false
    gatewayControlAPI
      .health()
      .then(() => {
        if (!cancelled) setStatus('ok')
      })
      .catch(() => {
        if (!cancelled) setStatus('down')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (status === 'ok') {
    return (
      <GatewayManager
        projectId={Number.isFinite(projectId) ? projectId : undefined}
        projectSlug={projectSlug}
        projectName={projectName}
        workspaceConfig={currentProject?.workspace_config}
      />
    )
  }

  return (
    <div className="p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-lg font-semibold text-gray-900">{t('title')}</h1>
        {status === 'checking' ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-gray-500">
            <i className="fas fa-spinner fa-spin" />
            {t('cpChecking')}
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-5 py-4">
            <div className="flex items-start gap-3">
              <i className="fas fa-plug mt-0.5 text-amber-500" />
              <div>
                <div className="text-sm font-semibold text-amber-900">{t('cpUnavailableTitle')}</div>
                <p className="mt-1 text-sm leading-6 text-amber-800">{t('cpUnavailableDesc')}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
