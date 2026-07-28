'use client'

import { memo } from 'react'
import { Handle, Position, NodeProps } from 'reactflow'

export const NODE_TYPE_META: Record<string, { label: string; icon: string; color: string; borderColor: string }> = {
  code: { label: 'Lua 代码', icon: '{ }', color: 'bg-violet-50', borderColor: 'border-violet-300' },
  db_query: { label: '数据库查询', icon: '🔍', color: 'bg-blue-50', borderColor: 'border-blue-300' },
  db_execute: { label: '数据库写入', icon: '💾', color: 'bg-emerald-50', borderColor: 'border-emerald-300' },
  http_call: { label: 'HTTP 调用', icon: '🌐', color: 'bg-orange-50', borderColor: 'border-orange-300' },
  condition: { label: '条件分支', icon: '⑊', color: 'bg-amber-50', borderColor: 'border-amber-300' },
  transform: { label: '数据转换', icon: '⇄', color: 'bg-cyan-50', borderColor: 'border-cyan-300' },
  response: { label: '响应输出', icon: '↩', color: 'bg-pink-50', borderColor: 'border-pink-300' },
}

function WorkflowNode({ data, selected }: NodeProps) {
  const meta = NODE_TYPE_META[data.nodeType] || NODE_TYPE_META.code
  return (
    <div
      className={`px-4 py-3 rounded-xl border-2 shadow-sm min-w-[160px] transition-all
        ${meta.color} ${meta.borderColor}
        ${selected ? 'ring-2 ring-indigo-400 ring-offset-2 shadow-md' : 'hover:shadow-md'}`}
    >
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-gray-400 !border-2 !border-white" />
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-400 font-medium">{meta.label}</div>
          <div className="text-sm font-semibold text-gray-800 truncate">{data.label || data.id}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-gray-400 !border-2 !border-white" />
      {data.nodeType === 'condition' && (
        <>
          <Handle type="source" position={Position.Right} id="true" className="!w-2.5 !h-2.5 !bg-green-500 !border-2 !border-white !top-1/2" />
          <Handle type="source" position={Position.Left} id="false" className="!w-2.5 !h-2.5 !bg-red-400 !border-2 !border-white !top-1/2" />
        </>
      )}
    </div>
  )
}

export const nodeTypes = {
  workflowNode: memo(WorkflowNode),
}
