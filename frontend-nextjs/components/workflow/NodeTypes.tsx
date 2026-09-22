'use client'

import { memo, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Handle, Position, NodeProps, useUpdateNodeInternals } from 'reactflow'
import { getConditionBranches, branchColor, branchHandleFraction } from './workflowLayout'

export const NODE_TYPE_META: Record<string, { label: string; labelKey: string; icon: string; color: string; borderColor: string; accent: string; minimapColor: string }> = {
  code: { label: 'Code', labelKey: 'nodeCode', icon: '{ }', color: 'bg-violet-50', borderColor: 'border-violet-300', accent: 'bg-violet-300', minimapColor: '#c4b5fd' },
  db_query: { label: 'DB Query', labelKey: 'nodeDbQuery', icon: '🔍', color: 'bg-blue-50', borderColor: 'border-blue-300', accent: 'bg-blue-300', minimapColor: '#93c5fd' },
  db_execute: { label: 'DB Write', labelKey: 'nodeDbExecute', icon: '💾', color: 'bg-emerald-50', borderColor: 'border-emerald-300', accent: 'bg-emerald-300', minimapColor: '#86efac' },
  db_transaction: { label: 'DB Transaction', labelKey: 'nodeDbTransaction', icon: '🧾', color: 'bg-emerald-50', borderColor: 'border-emerald-400', accent: 'bg-emerald-500', minimapColor: '#10b981' },
  foreach: { label: 'Batch Foreach', labelKey: 'nodeForeach', icon: '🔁', color: 'bg-green-50', borderColor: 'border-green-300', accent: 'bg-green-400', minimapColor: '#4ade80' },
  http_call: { label: 'HTTP Call', labelKey: 'nodeHttp', icon: '🌐', color: 'bg-orange-50', borderColor: 'border-orange-300', accent: 'bg-orange-300', minimapColor: '#fdba74' },
  email_send: { label: 'Send Email', labelKey: 'nodeEmail', icon: '✉️', color: 'bg-sky-50', borderColor: 'border-sky-300', accent: 'bg-sky-300', minimapColor: '#7dd3fc' },
  condition: { label: 'Condition', labelKey: 'nodeCondition', icon: '⑊', color: 'bg-amber-50', borderColor: 'border-amber-300', accent: 'bg-amber-300', minimapColor: '#fcd34d' },
  transform: { label: 'Transform', labelKey: 'nodeTransform', icon: '⇄', color: 'bg-cyan-50', borderColor: 'border-cyan-300', accent: 'bg-cyan-300', minimapColor: '#67e8f9' },
  response: { label: 'Response', labelKey: 'nodeResponse', icon: '↩', color: 'bg-pink-50', borderColor: 'border-pink-300', accent: 'bg-pink-300', minimapColor: '#f0abfc' },
  sse_publish: { label: 'SSE Publish', labelKey: 'nodeSse', icon: '📡', color: 'bg-indigo-50', borderColor: 'border-indigo-300', accent: 'bg-indigo-300', minimapColor: '#a5b4fc' },
  call_workflow: { label: 'Call Subworkflow', labelKey: 'nodeCallWf', icon: '🧩', color: 'bg-teal-50', borderColor: 'border-teal-300', accent: 'bg-teal-300', minimapColor: '#5eead4' },
  redis: { label: 'Redis Op', labelKey: 'nodeRedis', icon: '⚡', color: 'bg-red-50', borderColor: 'border-red-300', accent: 'bg-red-300', minimapColor: '#fca5a5' },
  kafka: { label: 'Kafka Message', labelKey: 'nodeKafka', icon: '📨', color: 'bg-lime-50', borderColor: 'border-lime-300', accent: 'bg-lime-300', minimapColor: '#bef264' },
  object_storage: { label: 'Object Storage', labelKey: 'nodeObjectStorage', icon: '☁', color: 'bg-sky-50', borderColor: 'border-sky-300', accent: 'bg-sky-300', minimapColor: '#7dd3fc' },
  llm: { label: 'LLM', labelKey: 'nodeLlm', icon: '✦', color: 'bg-violet-50', borderColor: 'border-violet-400', accent: 'bg-violet-400', minimapColor: '#a78bfa' },
  loop: { label: 'Loop', labelKey: 'nodeLoop', icon: '↺', color: 'bg-fuchsia-50', borderColor: 'border-fuchsia-300', accent: 'bg-fuchsia-400', minimapColor: '#e879f9' },
}

/** loop 节点卡片上展示的模式徽标文案 */
function loopModeBadge(config: any, t: (k: string, p?: any) => string): string {
  const mode = config?.loop_mode || 'while'
  switch (mode) {
    case 'while':
      return t('loopWhile', { n: config?.max_iterations ?? 100 })
    case 'until':
      return t('loopUntil', { n: config?.max_iterations ?? 100 })
    case 'count':
      return t('loopCount', { n: config?.count ?? '?' })
    case 'for_each':
      return t('loopForEach')
    default:
      return String(mode)
  }
}

const handleCls =
  '!w-[10px] !h-[10px] !border-2 !border-white !z-[3] transition-transform hover:!scale-[1.4] hover:!opacity-75'

function WorkflowNode({ id, data, selected }: NodeProps) {
  const meta = NODE_TYPE_META[data.nodeType] || NODE_TYPE_META.code
  const isCondition = data.nodeType === 'condition'
  const isLoop = data.nodeType === 'loop'
  const branches = isCondition ? getConditionBranches(data.config) : []
  // 出口数量随分支动态变化时，必须通知 React Flow 重新测量节点内部 handle，
  // 否则连线仍锚在旧位置（线点错位）、新出口未注册（拖不动）。
  const branchKey = branches.join('\u0001')
  const t = useTranslations('wfNodeTypes')
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, branchKey, updateNodeInternals])

  return (
    <div
      className={`w-[180px] px-3 py-3 rounded-xl border-2 shadow-sm cursor-grab active:cursor-grabbing transition-shadow
        ${meta.color} ${meta.borderColor}
        ${selected ? 'ring-2 ring-indigo-400 ring-offset-2 shadow-md' : 'hover:shadow-md'}`}
    >
      <Handle type="target" position={Position.Top} className={`${handleCls} !bg-[#cbd5e1]`} />

      {/* loop 回边入口：节点左侧 target handle（虚线，接收 loop_back 回边） */}
      {isLoop && (
        <Handle
          type="target"
          position={Position.Left}
          id="back"
          style={{ top: '35%', backgroundColor: '#d946ef', borderStyle: 'dashed' }}
          className={handleCls}
          title={t('loopBackIn')}
        />
      )}

      <div className="flex items-start gap-2">
        <div className={`w-1 rounded-sm self-stretch shrink-0 ${meta.accent}`} />
        <span className="text-lg leading-none shrink-0">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">{t(meta.labelKey)}</div>
          <div className="text-[15px] font-semibold text-slate-800 leading-snug line-clamp-2 break-words">{data.label || data.id}</div>
        </div>
      </div>

      {isLoop && (
        <div className="mt-1.5 ml-3 text-[10px] text-fuchsia-600 font-medium flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400 inline-block" />
          {loopModeBadge(data.config, t)}
        </div>
      )}

      {isCondition ? (
        branches.map((branch, i) => {
          const left = `${branchHandleFraction(i, branches.length) * 100}%`
          const color = branchColor(branch)
          return (
            <Handle
              key={branch}
              type="source"
              position={Position.Bottom}
              id={branch}
              style={{ left, backgroundColor: color }}
              className={`${handleCls}`}
              title={branch}
            />
          )
        })
      ) : isLoop ? (
        <>
          {/* 循环体出口（左，fuchsia） */}
          <Handle
            type="source"
            position={Position.Bottom}
            id="body"
            style={{ left: '35%', backgroundColor: branchColor('body') }}
            className={handleCls}
            title={t('loopBodyOut')}
          />
          {/* 完成出口（右，green） */}
          <Handle
            type="source"
            position={Position.Bottom}
            id="done"
            style={{ left: '65%', backgroundColor: branchColor('done') }}
            className={handleCls}
            title={t('loopDoneOut')}
          />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className={`${handleCls} !bg-[#cbd5e1]`} />
      )}
    </div>
  )
}

export const nodeTypes = {
  workflowNode: memo(WorkflowNode),
}
