'use client'

import { useState, useEffect, useCallback } from 'react'
import { queryAPI, schemaAPI, type FunctionMetadata } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { pgFunctionIdentity } from '@/lib/utils'
import { useNotification } from '@/hooks/useNotification'
import Drawer from '@/components/Drawer'

/**
 * 页面用到的字段集与后端 FunctionMetadata 一致。
 *
 * 历史背景：原先这里是页面自己声明的 interface，因为读路是 `queryAPI.execute(...)`
 * 跑 raw SQL 拿到的"动态 row"。现在读路改走 `schemaAPI.listFunctions`，类型由
 * `lib/api.ts` 的 FunctionMetadata 提供——保留这个本地别名只是为了页面里旧代码
 * 引用 `FunctionInfo` 的地方少改一行。
 */
type FunctionInfo = FunctionMetadata

// 常用函数模板
const FUNCTION_TEMPLATES = [
  {
    name: '简单查询函数',
    language: 'sql',
    code: `CREATE OR REPLACE FUNCTION my_function(param1 integer)
RETURNS TABLE(id integer, name text) AS $$
  SELECT id, name FROM my_table WHERE id = param1;
$$ LANGUAGE sql;`,
  },
  {
    name: 'PL/pgSQL 函数',
    language: 'plpgsql',
    code: `CREATE OR REPLACE FUNCTION calculate_total(order_id integer)
RETURNS numeric AS $$
DECLARE
  total numeric := 0;
BEGIN
  SELECT SUM(price * quantity) INTO total
  FROM order_items
  WHERE order_id = calculate_total.order_id;
  
  RETURN COALESCE(total, 0);
END;
$$ LANGUAGE plpgsql;`,
  },
  {
    name: '触发器函数',
    language: 'plpgsql',
    code: `CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`,
  },
  {
    name: '验证函数',
    language: 'plpgsql',
    code: `CREATE OR REPLACE FUNCTION validate_email(email text)
RETURNS boolean AS $$
BEGIN
  RETURN email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$';
END;
$$ LANGUAGE plpgsql;`,
  },
]

export default function FunctionsPage() {
  const { currentSchema } = useAppStore()
  const notify = useNotification()
  const [functions, setFunctions] = useState<FunctionInfo[]>([])
  const [selectedFunction, setSelectedFunction] = useState<FunctionInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [showTestForm, setShowTestForm] = useState(false)
  const [functionCode, setFunctionCode] = useState('')
  const [testParams, setTestParams] = useState('')
  const [testResult, setTestResult] = useState<any>(null)
  const [searchTerm, setSearchTerm] = useState('')
  /**
   * 是否把扩展（citext / pgcrypto / pg_trgm 等）带进来的函数也展示出来。
   *
   * 默认 false——干净视图：扩展会往 public 塞一堆同名重载（如
   * citext(character) / citext(inet) / citext(boolean)），UI 上看起来像
   * "数据重复"，对绝大多数用户也没意义。需要排查时再打开。
   */
  const [showExtensionFunctions, setShowExtensionFunctions] = useState(false)

  // 加载函数列表 —— 走结构化 GET /api/schema/:schema/functions，鉴权
  // 由后端 dynamic_db_middleware（任意租户成员）兜底；不再借道 `/query`
  // 这条平台超管专属的 raw SQL 通路。
  //
  // 是否隐藏扩展函数仍是纯前端 toggle：后端把 extension_name 一起返回，
  // 前端按 `showExtensionFunctions` 过滤即可，切换不必重查库。
  const loadFunctions = useCallback(async () => {
    if (!currentSchema) return
    setLoading(true)
    try {
      const result = await schemaAPI.listFunctions(currentSchema)
      setFunctions(result.data || [])
    } catch (err: any) {
      notify.error(err)
    } finally {
      setLoading(false)
    }
  }, [currentSchema, notify])

  useEffect(() => {
    loadFunctions()
  }, [loadFunctions])

  // 创建/更新函数
  const saveFunction = async () => {
    if (!functionCode.trim()) {
      notify.warning('请输入函数代码')
      return
    }
    
    try {
      // 编辑器抽屉就是"二次确认"——点击保存即代表明确意图，用 executeManaged
      // 直接带 acknowledge_destructive=true，避免再额外弹一层通用 modal。
      await queryAPI.executeManaged(functionCode)
      notify.success('函数保存成功')
      setShowCreateForm(false)
      setFunctionCode('')
      loadFunctions()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 删除函数
  const deleteFunction = async (func: FunctionInfo) => {
    const confirmed = window.confirm(`确定要删除函数 "${func.function_name}" 吗？`)
    if (!confirmed) return
    
    try {
      const dropSql = func.argument_types
        ? `DROP FUNCTION IF EXISTS "${currentSchema}"."${func.function_name}"(${func.argument_types});`
        : `DROP FUNCTION IF EXISTS "${currentSchema}"."${func.function_name}"();`
      
      await queryAPI.executeManaged(dropSql)
      notify.success('函数已删除')
      setSelectedFunction(null)
      loadFunctions()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 测试函数
  const testFunction = async () => {
    if (!selectedFunction) return
    
    setTestResult(null)
    
    try {
      const params = testParams.trim() || ''
      const testSql = `SELECT "${currentSchema}"."${selectedFunction.function_name}"(${params}) as result;`
      const result = await queryAPI.execute(testSql)
      setTestResult(result.data)
      notify.success('函数执行成功')
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 编辑函数
  const editFunction = (func: FunctionInfo) => {
    setFunctionCode(func.source_code || '')
    setShowCreateForm(true)
  }

  // 应用模板
  const applyTemplate = (template: typeof FUNCTION_TEMPLATES[0]) => {
    setFunctionCode(template.code)
  }

  // 列表过滤：默认隐藏扩展函数（避免 citext 这类同名重载造成的"看着重复"），
  // 同时按搜索词筛名字。toggle 打开时把扩展函数也带进来，并以小 badge 标识来源。
  const filteredFunctions = functions.filter((f) => {
    if (!showExtensionFunctions && f.extension_name) return false
    return f.function_name.toLowerCase().includes(searchTerm.toLowerCase())
  })
  const hiddenExtensionCount = functions.filter((f) => !!f.extension_name).length

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">函数管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            管理 PostgreSQL 存储函数和过程
          </p>
        </div>
        
        <button
          onClick={() => {
            setFunctionCode('')
            setShowCreateForm(true)
          }}
          className="btn-primary"
        >
          <i className="fas fa-plus mr-2"></i>
          创建函数
        </button>
      </div>


      <div className="grid grid-cols-12 gap-6">
        {/* 左侧：函数列表 */}
        <div className="col-span-4">
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 space-y-2">
              <div className="relative">
                <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="搜索函数..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              {/* 扩展函数 toggle：默认隐藏；只在该 schema 真有扩展函数时显示，
                  避免 schema 没装扩展时摆个永远 0 的开关。 */}
              {hiddenExtensionCount > 0 && (
                <label className="flex items-center justify-between text-xs text-gray-600 cursor-pointer">
                  <span className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={showExtensionFunctions}
                      onChange={(e) => setShowExtensionFunctions(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600"
                    />
                    <span>显示扩展函数</span>
                  </span>
                  <span className="text-gray-400">
                    {showExtensionFunctions
                      ? `共 ${hiddenExtensionCount} 个`
                      : `已隐藏 ${hiddenExtensionCount} 个`}
                  </span>
                </label>
              )}
            </div>
            <div className="max-h-[600px] overflow-y-auto">
              {loading && functions.length === 0 ? (
                <div className="p-4 text-center text-gray-500">
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  加载中...
                </div>
              ) : filteredFunctions.length === 0 ? (
                <div className="p-8 text-center">
                  <i className="fas fa-code text-4xl text-gray-300 mb-3"></i>
                  <p className="text-gray-500">
                    {searchTerm ? '未找到匹配的函数' : '暂无函数'}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {filteredFunctions.map((func) => {
                    // 同 schema 同名函数可以按参数签名重载（pg_proc 里 (schema, name, args)
                    // 才唯一）。React key 用 (schema, name) 拼会出现重复，列表重排时
                    // reconciler 也会错配选中态/输入态——用完整身份才稳定。
                    const id = pgFunctionIdentity(func)
                    const active = selectedFunction
                      ? pgFunctionIdentity(selectedFunction) === id
                      : false
                    return (
                    <div
                      key={id}
                      onClick={() => setSelectedFunction(func)}
                      className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                        active ? 'bg-blue-50 border-l-2 border-blue-500' : ''
                      }`}
                    >
                      <div className="flex items-center space-x-3">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                          func.function_type === 'procedure' ? 'bg-purple-100' : 'bg-blue-100'
                        }`}>
                          <i className={`fas fa-code ${
                            func.function_type === 'procedure' ? 'text-purple-600' : 'text-blue-600'
                          }`}></i>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-gray-900 truncate">{func.function_name}</p>
                          <p className="text-xs text-gray-500 truncate">
                            ({func.argument_types || 'void'}) → {func.return_type}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center space-x-2">
                        <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
                          {func.language}
                        </span>
                        <span className="text-xs text-gray-400">{func.volatility}</span>
                        {func.extension_name && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded font-mono"
                            title={`来自 PostgreSQL 扩展 ${func.extension_name}`}
                          >
                            ext: {func.extension_name}
                          </span>
                        )}
                      </div>
                    </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右侧：函数详情 */}
        <div className="col-span-8 space-y-4">
          {!selectedFunction ? (
            <div className="card p-8 text-center">
              <i className="fas fa-code text-5xl text-gray-300 mb-4"></i>
              <p className="text-gray-500">选择一个函数查看详情</p>
            </div>
          ) : (
            <>
              {/* 函数信息 */}
              <div className="card">
                <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-700">
                    {selectedFunction.function_name}
                  </h3>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => setShowTestForm(true)}
                      className="btn-default text-sm"
                    >
                      <i className="fas fa-play mr-2"></i>
                      测试
                    </button>
                    <button
                      onClick={() => editFunction(selectedFunction)}
                      className="btn-default text-sm"
                    >
                      <i className="fas fa-edit mr-2"></i>
                      编辑
                    </button>
                    <button
                      onClick={() => deleteFunction(selectedFunction)}
                      className="text-red-500 hover:text-red-700 px-3 py-2"
                    >
                      <i className="fas fa-trash"></i>
                    </button>
                  </div>
                </div>
                <div className="p-4">
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div>
                      <span className="text-xs text-gray-500">参数</span>
                      <p className="text-sm font-mono text-gray-900">
                        {selectedFunction.argument_types || '无'}
                      </p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500">返回类型</span>
                      <p className="text-sm font-mono text-gray-900">{selectedFunction.return_type}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500">语言</span>
                      <p className="text-sm text-gray-900">{selectedFunction.language}</p>
                    </div>
                  </div>
                  
                  <div>
                    <span className="text-xs text-gray-500">源代码</span>
                    <pre className="mt-2 p-4 bg-gray-900 text-green-400 rounded-lg text-sm font-mono overflow-auto max-h-[400px]">
                      {selectedFunction.source_code || '-- 无法获取源代码'}
                    </pre>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 创建/编辑函数抽屉 */}
      <Drawer
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        title={functionCode.includes('CREATE OR REPLACE') ? '编辑函数' : '创建函数'}
        size="xl"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setShowCreateForm(false)}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-all duration-200"
            >
              取消
            </button>
            <button
              onClick={saveFunction}
              disabled={!functionCode.trim()}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md flex items-center justify-center"
            >
              <i className="fas fa-save mr-2"></i>
              保存函数
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          {/* 模板选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">快速模板</label>
            <div className="grid grid-cols-2 gap-2">
              {FUNCTION_TEMPLATES.map((template, idx) => (
                <button
                  key={idx}
                  onClick={() => applyTemplate(template)}
                  className="p-3 text-left border border-gray-200 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors"
                >
                  <p className="text-sm font-medium text-gray-900">{template.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{template.language}</p>
                </button>
              ))}
            </div>
          </div>
          
          {/* 代码编辑器 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">函数定义</label>
            <textarea
              value={functionCode}
              onChange={(e) => setFunctionCode(e.target.value)}
              className="w-full h-[450px] p-4 font-mono text-sm bg-gray-900 text-green-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="CREATE OR REPLACE FUNCTION ..."
              spellCheck={false}
            />
          </div>
        </div>
      </Drawer>

      {/* 测试函数抽屉 */}
      <Drawer
        isOpen={showTestForm && !!selectedFunction}
        onClose={() => {
          setShowTestForm(false)
          setTestResult(null)
          setTestParams('')
        }}
        title={`测试函数: ${selectedFunction?.function_name || ''}`}
        size="md"
        footer={
          <button
            onClick={testFunction}
            className="w-full h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-green-500 to-green-600 rounded-lg hover:from-green-600 hover:to-green-700 transition-all duration-200 shadow-sm hover:shadow-md flex items-center justify-center"
          >
            <i className="fas fa-play mr-2"></i>
            执行函数
          </button>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              函数参数
            </label>
            <div className="p-3 bg-gray-50 rounded-lg mb-3">
              <p className="text-sm font-mono text-gray-700">
                ({selectedFunction?.argument_types || '无参数'})
              </p>
            </div>
            <input
              type="text"
              value={testParams}
              onChange={(e) => setTestParams(e.target.value)}
              placeholder="例如: 1, 'test', true"
              className="w-full input-base font-mono"
            />
            <p className="text-xs text-gray-500 mt-2">
              <i className="fas fa-info-circle mr-1"></i>
              多个参数用逗号分隔，字符串需要用单引号包裹
            </p>
          </div>
          
          {testResult && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">执行结果</label>
              <pre className="p-4 bg-gray-900 text-green-400 rounded-lg text-sm font-mono overflow-auto max-h-[250px]">
                {JSON.stringify(testResult.data, null, 2)}
              </pre>
              <p className="text-xs text-gray-500 mt-2 flex items-center">
                <i className="fas fa-clock mr-1"></i>
                执行时间: {testResult.elapsed_ms} ms
              </p>
            </div>
          )}
        </div>
      </Drawer>
    </div>
  )
}

