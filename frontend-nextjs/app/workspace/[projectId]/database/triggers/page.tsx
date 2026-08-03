'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  schemaAPI,
  queryAPI,
  type TriggerMetadata,
  type FunctionMetadata,
} from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

// 与后端 catalog 接口（GET /api/schema/:schema/triggers）字段对齐，
// 旧 raw SQL 路径已改成结构化读，类型从 lib/api.ts 复用。
type TriggerInfo = TriggerMetadata

interface TableInfo {
  table_name: string
  table_type: string
}

// 触发器创建表单里需要的"返回 trigger 的函数"下拉项 —— 用 schemaAPI.listFunctions
// 拉到全 schema 函数后在前端按 return_type='trigger' 过滤。本地只取这两个字段。
interface FunctionInfo {
  function_name: string
  return_type: string | null
}

export default function TriggersPage() {
  const { currentSchema } = useAppStore()
  const notify = useNotification()
  const [triggers, setTriggers] = useState<TriggerInfo[]>([])
  const [tables, setTables] = useState<TableInfo[]>([])
  const [functions, setFunctions] = useState<FunctionInfo[]>([])
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  
  // 新建触发器表单
  const [newTrigger, setNewTrigger] = useState({
    name: '',
    table: '',
    timing: 'BEFORE',
    events: ['INSERT'],
    forEach: 'ROW',
    function: '',
    condition: '',
  })

  // 加载触发器列表 —— 走结构化 GET /api/schema/:schema/triggers，路由层
  // dynamic_db_middleware 已经把住"必须是该租户成员"，所以不再借道 `/query`
  // 这条平台超管专属的 raw SQL 通路。
  const loadTriggers = useCallback(async () => {
    if (!currentSchema) return
    setLoading(true)
    try {
      const result = await schemaAPI.listTriggers(currentSchema)
      setTriggers(result.data || [])
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }, [currentSchema, notify])

  // 加载表列表
  const loadTables = async () => {
    try {
      const response = await schemaAPI.listTables(currentSchema)
      setTables(response.data.filter((t: TableInfo) => t.table_type === 'BASE TABLE'))
    } catch (err) {
      console.error('加载表列表失败:', err)
    }
  }

  // 加载触发器函数列表 —— 复用 schemaAPI.listFunctions 拉全量函数，再前端
  // 过滤出 return_type === 'trigger' 的。这里不再走 /query，原因同 loadTriggers。
  const loadTriggerFunctions = async () => {
    if (!currentSchema) return
    try {
      const result = await schemaAPI.listFunctions(currentSchema)
      const triggerFns: FunctionInfo[] = (result.data || [])
        .filter((f) => f.return_type === 'trigger')
        .map((f) => ({
          function_name: f.function_name,
          return_type: f.return_type,
        }))
      setFunctions(triggerFns)
    } catch (err) {
      console.error('加载触发器函数失败:', err)
    }
  }

  useEffect(() => {
    loadTriggers()
    loadTables()
    loadTriggerFunctions()
  }, [loadTriggers, currentSchema])

  // 创建触发器
  const createTrigger = async () => {
    if (!newTrigger.name || !newTrigger.table || !newTrigger.function) {
      notify.warning('请填写所有必填字段')
      return
    }
    
    try {
      let sql = `CREATE TRIGGER "${newTrigger.name}"\n`
      sql += `${newTrigger.timing} ${newTrigger.events.join(' OR ')}\n`
      sql += `ON "${currentSchema}"."${newTrigger.table}"\n`
      sql += `FOR EACH ${newTrigger.forEach}\n`
      
      if (newTrigger.condition) {
        sql += `WHEN (${newTrigger.condition})\n`
      }
      
      sql += `EXECUTE FUNCTION "${currentSchema}"."${newTrigger.function}"();`
      
      // 触发器创建抽屉本身是用户填表 + 点保存，意图明确；executeManaged
      // 直接带 ack，省一层通用确认 modal。
      await queryAPI.executeManaged(sql)
      notify.success('触发器创建成功')
      setShowCreateForm(false)
      setNewTrigger({
        name: '',
        table: '',
        timing: 'BEFORE',
        events: ['INSERT'],
        forEach: 'ROW',
        function: '',
        condition: '',
      })
      loadTriggers()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 删除触发器
  const deleteTrigger = async (trigger: TriggerInfo) => {
    const confirmed = window.confirm(`确定要删除触发器 "${trigger.trigger_name}" 吗？`)
    if (!confirmed) return
    
    try {
      await queryAPI.executeManaged(`DROP TRIGGER "${trigger.trigger_name}" ON "${currentSchema}"."${trigger.table_name}";`)
      notify.success('触发器已删除')
      setSelectedTrigger(null)
      loadTriggers()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 启用/禁用触发器
  const toggleTrigger = async (trigger: TriggerInfo) => {
    try {
      const action = trigger.is_enabled ? 'DISABLE' : 'ENABLE'
      await queryAPI.executeManaged(`ALTER TABLE "${currentSchema}"."${trigger.table_name}" ${action} TRIGGER "${trigger.trigger_name}";`)
      notify.success(`触发器已${trigger.is_enabled ? '禁用' : '启用'}`)
      loadTriggers()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 过滤触发器
  const filteredTriggers = triggers.filter(t =>
    t.trigger_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    t.table_name.toLowerCase().includes(searchTerm.toLowerCase())
  )

  // 切换事件选择
  const toggleEvent = (event: string) => {
    setNewTrigger(prev => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter(e => e !== event)
        : [...prev.events, event]
    }))
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">触发器管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            管理数据库表的触发器
          </p>
        </div>
        
        <button
          onClick={() => setShowCreateForm(true)}
          disabled={functions.length === 0}
          className="btn-primary"
          title={functions.length === 0 ? '请先创建触发器函数' : ''}
        >
          <i className="fas fa-plus mr-2"></i>
          创建触发器
        </button>
      </div>

      {functions.length === 0 && !loading && (
        <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-sm text-yellow-700">
            <i className="fas fa-info-circle mr-2"></i>
            未找到触发器函数。请先在"函数管理"中创建返回类型为 trigger 的函数。
          </p>
        </div>
      )}


      <div className="grid grid-cols-12 gap-6">
        {/* 左侧：触发器列表 */}
        <div className="col-span-4">
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
              <div className="relative">
                <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="搜索触发器..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="max-h-[600px] overflow-y-auto">
              {loading && triggers.length === 0 ? (
                <div className="p-4 text-center text-gray-500">
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  加载中...
                </div>
              ) : filteredTriggers.length === 0 ? (
                <div className="p-8 text-center">
                  <i className="fas fa-bolt text-4xl text-gray-300 mb-3"></i>
                  <p className="text-gray-500">
                    {searchTerm ? '未找到匹配的触发器' : '暂无触发器'}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {filteredTriggers.map((trigger, idx) => (
                    <div
                      key={idx}
                      onClick={() => setSelectedTrigger(trigger)}
                      className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                        selectedTrigger?.trigger_name === trigger.trigger_name ? 'bg-blue-50 border-l-2 border-blue-500' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                            trigger.is_enabled ? 'bg-green-100' : 'bg-gray-100'
                          }`}>
                            <i className={`fas fa-bolt ${
                              trigger.is_enabled ? 'text-green-600' : 'text-gray-400'
                            }`}></i>
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{trigger.trigger_name}</p>
                            <p className="text-xs text-gray-500">{trigger.table_name}</p>
                          </div>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          trigger.is_enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                        }`}>
                          {trigger.is_enabled ? '启用' : '禁用'}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center space-x-2">
                        <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded">
                          {trigger.action_timing}
                        </span>
                        <span className="text-xs text-gray-500">
                          {trigger.event_manipulation}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右侧：触发器详情 */}
        <div className="col-span-8">
          {!selectedTrigger ? (
            <div className="card p-8 text-center">
              <i className="fas fa-bolt text-5xl text-gray-300 mb-4"></i>
              <p className="text-gray-500">选择一个触发器查看详情</p>
            </div>
          ) : (
            <div className="card">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700">
                  {selectedTrigger.trigger_name}
                </h3>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => toggleTrigger(selectedTrigger)}
                    className={`text-sm px-3 py-1.5 rounded-lg ${
                      selectedTrigger.is_enabled
                        ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
                        : 'bg-green-100 text-green-700 hover:bg-green-200'
                    }`}
                  >
                    <i className={`fas ${selectedTrigger.is_enabled ? 'fa-pause' : 'fa-play'} mr-1`}></i>
                    {selectedTrigger.is_enabled ? '禁用' : '启用'}
                  </button>
                  <button
                    onClick={() => deleteTrigger(selectedTrigger)}
                    className="text-red-500 hover:text-red-700 px-3 py-2"
                  >
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              </div>
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-xs text-gray-500">关联表</span>
                    <p className="text-sm font-medium text-gray-900">{selectedTrigger.table_name}</p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500">执行时机</span>
                    <p className="text-sm text-gray-900">{selectedTrigger.action_timing}</p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500">触发事件</span>
                    <p className="text-sm text-gray-900">{selectedTrigger.event_manipulation}</p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500">触发级别</span>
                    <p className="text-sm text-gray-900">{selectedTrigger.action_orientation}</p>
                  </div>
                </div>
                
                <div>
                  <span className="text-xs text-gray-500">触发器定义</span>
                  <pre className="mt-2 p-4 bg-gray-900 text-green-400 rounded-lg text-sm font-mono overflow-auto max-h-[300px]">
                    {selectedTrigger.action_statement}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 创建触发器抽屉 */}
      <Drawer
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        title="创建触发器"
        size="md"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setShowCreateForm(false)}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-all duration-200"
            >
              取消
            </button>
            <button
              onClick={createTrigger}
              disabled={!newTrigger.name || !newTrigger.table || !newTrigger.function || newTrigger.events.length === 0}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-amber-500 to-amber-600 rounded-lg hover:from-amber-600 hover:to-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md flex items-center justify-center"
            >
              <i className="fas fa-bolt mr-2"></i>
              创建触发器
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">触发器名称</label>
            <input
              type="text"
              value={newTrigger.name}
              onChange={(e) => setNewTrigger({ ...newTrigger, name: e.target.value })}
              placeholder="输入触发器名称"
              className="w-full input-base"
              autoFocus
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">关联表</label>
            <select
              value={newTrigger.table}
              onChange={(e) => setNewTrigger({ ...newTrigger, table: e.target.value })}
              className="w-full input-base"
            >
              <option value="">选择表...</option>
              {tables.map(table => (
                <option key={table.table_name} value={table.table_name}>
                  {table.table_name}
                </option>
              ))}
            </select>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">执行时机</label>
              <select
                value={newTrigger.timing}
                onChange={(e) => setNewTrigger({ ...newTrigger, timing: e.target.value })}
                className="w-full input-base"
              >
                <option value="BEFORE">BEFORE (之前)</option>
                <option value="AFTER">AFTER (之后)</option>
                <option value="INSTEAD OF">INSTEAD OF (替代)</option>
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">触发级别</label>
              <select
                value={newTrigger.forEach}
                onChange={(e) => setNewTrigger({ ...newTrigger, forEach: e.target.value })}
                className="w-full input-base"
              >
                <option value="ROW">FOR EACH ROW (每行)</option>
                <option value="STATEMENT">FOR EACH STATEMENT (每语句)</option>
              </select>
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">触发事件</label>
            <div className="grid grid-cols-2 gap-2">
              {['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map(event => (
                <label 
                  key={event} 
                  className={`flex items-center space-x-3 p-3 rounded-lg cursor-pointer transition-colors ${
                    newTrigger.events.includes(event) 
                      ? 'bg-blue-50 border border-blue-200' 
                      : 'bg-gray-50 border border-transparent hover:bg-gray-100'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={newTrigger.events.includes(event)}
                    onChange={() => toggleEvent(event)}
                    className="rounded border-gray-300 text-blue-600 w-4 h-4"
                  />
                  <span className={`text-sm font-medium ${
                    newTrigger.events.includes(event) ? 'text-blue-700' : 'text-gray-700'
                  }`}>{event}</span>
                </label>
              ))}
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">触发器函数</label>
            <select
              value={newTrigger.function}
              onChange={(e) => setNewTrigger({ ...newTrigger, function: e.target.value })}
              className="w-full input-base"
            >
              <option value="">选择函数...</option>
              {functions.map(func => (
                <option key={func.function_name} value={func.function_name}>
                  {func.function_name}()
                </option>
              ))}
            </select>
            {functions.length === 0 && (
              <p className="text-xs text-yellow-600 mt-1">
                <i className="fas fa-exclamation-triangle mr-1"></i>
                请先创建返回类型为 trigger 的函数
              </p>
            )}
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              条件表达式 <span className="text-gray-400 font-normal">(可选)</span>
            </label>
            <input
              type="text"
              value={newTrigger.condition}
              onChange={(e) => setNewTrigger({ ...newTrigger, condition: e.target.value })}
              placeholder="例如: NEW.status = 'active'"
              className="w-full input-base font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              <i className="fas fa-info-circle mr-1"></i>
              WHEN 子句的条件，只有满足条件时才触发
            </p>
          </div>
        </div>
      </Drawer>
    </div>
  )
}

