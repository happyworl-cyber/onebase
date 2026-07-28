'use client'

import { NODE_TYPE_META } from './NodeTypes'

interface WorkflowNodeData {
  id: string
  type: string
  label?: string
  config: any
}

interface Props {
  node: WorkflowNodeData | null
  onChange: (node: WorkflowNodeData) => void
  onClose: () => void
  onDelete: () => void
}

export default function NodeConfigPanel({ node, onChange, onClose, onDelete }: Props) {
  if (!node) return null

  const meta = NODE_TYPE_META[node.type] || NODE_TYPE_META.code

  const updateConfig = (key: string, value: any) => {
    onChange({ ...node, config: { ...node.config, [key]: value } })
  }

  return (
    <div className="w-[380px] border-l bg-white flex flex-col h-full overflow-hidden">
      <div className={`p-4 border-b ${meta.color} flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <span className="text-xl">{meta.icon}</span>
          <div>
            <div className="text-xs text-gray-500">{meta.label}</div>
            <div className="font-semibold text-gray-800">{node.label || node.id}</div>
          </div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">节点 ID</label>
          <input
            value={node.id}
            disabled
            className="w-full px-3 py-2 border rounded-lg bg-gray-50 text-sm font-mono text-gray-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">标签名称</label>
          <input
            value={node.label || ''}
            onChange={e => onChange({ ...node, label: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg text-sm"
            placeholder="给节点起个名字"
          />
        </div>

        <hr className="border-gray-100" />

        {node.type === 'code' && (
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Lua 代码</label>
            <textarea
              value={node.config.code || ''}
              onChange={e => updateConfig('code', e.target.value)}
              className="w-full px-3 py-2 border rounded-lg font-mono text-sm bg-gray-900 text-green-400 leading-relaxed"
              rows={12}
              spellCheck={false}
              placeholder={'function execute(ctx)\n  -- ctx.trigger: 触发数据\n  -- ctx.nodes.xxx: 上游节点输出\n  ctx.body = { ok = true }\nend'}
            />
            <p className="text-xs text-gray-400 mt-1">
              可用变量: ctx.trigger（触发数据）、ctx.nodes.nodeId（上游输出）
            </p>
          </div>
        )}

        {node.type === 'db_query' && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">SQL 查询</label>
              <textarea
                value={node.config.sql || ''}
                onChange={e => updateConfig('sql', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={5}
                placeholder="SELECT * FROM users WHERE id = $1"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">参数 (JSON 数组)</label>
              <input
                value={node.config.params || ''}
                onChange={e => updateConfig('params', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                placeholder='["{{trigger.id}}"]'
              />
              <p className="text-xs text-gray-400 mt-1">支持模板: {'{{trigger.x}}'}, {'{{nodeId.field}}'}</p>
            </div>
          </>
        )}

        {node.type === 'db_execute' && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">SQL 语句</label>
              <textarea
                value={node.config.sql || ''}
                onChange={e => updateConfig('sql', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={5}
                placeholder="INSERT INTO logs(msg) VALUES($1)"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">参数 (JSON 数组)</label>
              <input
                value={node.config.params || ''}
                onChange={e => updateConfig('params', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                placeholder='["{{trigger.message}}"]'
              />
            </div>
          </>
        )}

        {node.type === 'http_call' && (
          <>
            <div className="grid grid-cols-4 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">方法</label>
                <select
                  value={node.config.method || 'GET'}
                  onChange={e => updateConfig('method', e.target.value)}
                  className="w-full px-2 py-2 border rounded-lg text-sm"
                >
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-3">
                <label className="block text-xs font-medium text-gray-500 mb-1">URL</label>
                <input
                  value={node.config.url || ''}
                  onChange={e => updateConfig('url', e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
                  placeholder="https://api.example.com/data"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Headers (JSON)</label>
              <textarea
                value={node.config.headers || ''}
                onChange={e => updateConfig('headers', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={3}
                placeholder='{"Authorization": "Bearer xxx"}'
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Body (JSON)</label>
              <textarea
                value={node.config.body || ''}
                onChange={e => updateConfig('body', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={3}
                placeholder='{"key": "{{trigger.value}}"}'
              />
            </div>
          </>
        )}

        {node.type === 'condition' && (
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">条件表达式</label>
            <input
              value={node.config.expression || ''}
              onChange={e => updateConfig('expression', e.target.value)}
              className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
              placeholder="{{trigger.age}} > 18"
            />
            <p className="text-xs text-gray-400 mt-1">
              支持: ==, !=, &gt;, &lt;, &gt;=, &lt;=, contains, starts_with
            </p>
            <p className="text-xs text-gray-400">
              true 分支从右侧出口连接，false 分支从左侧出口连接
            </p>
          </div>
        )}

        {node.type === 'transform' && (
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">转换映射 (JSON)</label>
            <textarea
              value={node.config.mapping ? (typeof node.config.mapping === 'string' ? node.config.mapping : JSON.stringify(node.config.mapping, null, 2)) : ''}
              onChange={e => updateConfig('mapping', e.target.value)}
              className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
              rows={6}
              placeholder={'{\n  "user_name": "{{query.rows.0.name}}",\n  "total": "{{query.rows.length}}"\n}'}
            />
            <p className="text-xs text-gray-400 mt-1">键值对映射，值支持模板变量</p>
          </div>
        )}

        {node.type === 'response' && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">HTTP 状态码</label>
              <input
                type="number"
                value={node.config.status_code || 200}
                onChange={e => updateConfig('status_code', parseInt(e.target.value) || 200)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">响应 Body (JSON 模板)</label>
              <textarea
                value={node.config.body || ''}
                onChange={e => updateConfig('body', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={5}
                placeholder={'{\n  "success": true,\n  "data": "{{transform.result}}"\n}'}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">响应 Headers (JSON)</label>
              <textarea
                value={node.config.headers || ''}
                onChange={e => updateConfig('headers', e.target.value)}
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
                rows={2}
                placeholder='{"X-Custom": "value"}'
              />
            </div>
          </>
        )}
      </div>

      <div className="p-4 border-t bg-gray-50 flex justify-between">
        <button
          onClick={onDelete}
          className="px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          删除节点
        </button>
        <button
          onClick={onClose}
          className="px-4 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          完成
        </button>
      </div>
    </div>
  )
}
