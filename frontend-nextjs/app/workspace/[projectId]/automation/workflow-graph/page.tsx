'use client'

/**
 * `/workspace/[projectId]/automation/workflow-graph` —— 工作流依赖图浏览器。
 *
 * G6 v5 依赖 window/document、不兼容 SSR，图组件必须用 next/dynamic({ ssr:false }) 引入
 * （照 WorkflowsManager.tsx 里 WorkflowCanvas 的先例，本页是它的兄弟页）。
 * 权限门槛与 databaseId 取值方式对齐 `automation/workflows` 页。
 *
 * 入口是工作流列表页的"依赖图"按钮（不再有独立侧栏入口）：列表页按当前选中的
 * department+category 拼 query 带进来；?department=&category= 都有才生效，
 * 否则全量渲染——两个 query 名与后端 GET .../dependency-graph 的参数名一致。
 *
 * 多入口 focus（P1.3⑤）：`?focus=<slug或id>` 进图时自动选中并居中该节点（见
 * WorkflowGraphCanvas 的 focusId prop）。工作流列表行菜单"在依赖图中查看此工作流"即走这个参数。
 */

import dynamic from 'next/dynamic'
import { useParams, useSearchParams } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import ForbiddenPlaceholder from '@/components/shared/ForbiddenPlaceholder'

const WorkflowGraphCanvas = dynamic(
  () => import('@/components/workflow/graph/WorkflowGraphCanvas'),
  { ssr: false },
)

export default function WorkspaceWorkflowGraphPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = parseInt(params.projectId, 10)
  const currentConnection = useAppStore((s) => s.currentConnection)
  const databaseId = currentConnection?.database_id ?? null
  const caps = useCurrentProjectCapabilities()
  const searchParams = useSearchParams()
  const scopeDept = searchParams.get('department')
  const scopeCat = searchParams.get('category')
  const scope = scopeDept && scopeCat ? { department: scopeDept, category: scopeCat } : null
  const focusId = searchParams.get('focus')

  if (!caps.canManageEvents) {
    return <ForbiddenPlaceholder reason="工作流依赖图需要 admin+ 角色（owner / admin / 超管）" />
  }

  if (isNaN(projectId)) {
    return <div className="p-8 text-center text-gray-500">URL 中的 projectId 无效</div>
  }

  if (!databaseId) {
    return (
      <div className="p-8 text-center text-gray-500">
        本项目尚未绑定主数据库连接，无法查看工作流依赖图。
      </div>
    )
  }

  return (
    <div data-alt="workflow-graph-page" className="h-[calc(100vh-4rem)] w-full">
      <WorkflowGraphCanvas projectId={projectId} databaseId={databaseId} scope={scope} focusId={focusId} />
    </div>
  )
}
