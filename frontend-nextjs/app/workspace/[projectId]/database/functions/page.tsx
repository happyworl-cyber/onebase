'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
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
    nameKey: 'tplSimpleQuery',
    language: 'sql',
    code: `CREATE OR REPLACE FUNCTION my_function(param1 integer)
RETURNS TABLE(id integer, name text) AS $$
  SELECT id, name FROM my_table WHERE id = param1;
$$ LANGUAGE sql;`,
  },
  {
    nameKey: 'tplPlpgsql',
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
    nameKey: 'tplTrigger',
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
    nameKey: 'tplValidate',
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
  const t = useTranslations('wsFunctions')
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
      notify.warning(t('errCode'))
      return
    }
    
    try {
      // 编辑器抽屉就是"二次确认"——点击保存即代表明确意图，用 executeManaged
      // 直接带 acknowledge_destructive=true，避免再额外弹一层通用 modal。
      await queryAPI.executeManaged(functionCode)
      notify.success(t('saveOk'))
      setShowCreateForm(false)
      setFunctionCode('')
      loadFunctions()
    } catch (err: any) {
      notify.error(err)
    }
  }

  // 删除函数
  const deleteFunction = async (func: FunctionInfo) => {
    const confirmed = window.confirm(t('confirmDelete', { name: func.function_name }))
    if (!confirmed) return
    
    try {
      const dropSql = func.argument_types
        ? `DROP FUNCTION IF EXISTS "${currentSchema}"."${func.function_name}"(${func.argument_types});`
        : `DROP FUNCTION IF EXISTS "${currentSchema}"."${func.function_name}"();`
      
      await queryAPI.executeManaged(dropSql)
      notify.success(t('deleteOk'))
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
      notify.success(t('execOk'))
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
          <h1 className="text-2xl font-semibold text-gray-800">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('subtitle')}
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
          {t('createFn')}
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
                  placeholder={t('phSearch')}
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
                    <span>{t('showExtFns')}</span>
                  </span>
                  <span className="text-gray-400">
                    {showExtensionFunctions
                      ? t('countTotal', { n: hiddenExtensionCount })
                      : t('countHidden', { n: hiddenExtensionCount })}
                  </span>
                </label>
              )}
            </div>
            <div className="max-h-[600px] overflow-y-auto">
              {loading && functions.length === 0 ? (
                <div className="p-4 text-center text-gray-500">
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  {t('loading')}
                </div>
              ) : filteredFunctions.length === 0 ? (
                <div className="p-8 text-center">
                  <i className="fas fa-code text-4xl text-gray-300 mb-3"></i>
                  <p className="text-gray-500">
                    {searchTerm ? t('noMatch') : t('empty')}
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
                            title={t('fromExtension', { name: func.extension_name })}
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
              <p className="text-gray-500">{t('selectHint')}</p>
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
                      {t('test')}
                    </button>
                    <button
                      onClick={() => editFunction(selectedFunction)}
                      className="btn-default text-sm"
                    >
                      <i className="fas fa-edit mr-2"></i>
                      {t('edit')}
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
                      <span className="text-xs text-gray-500">{t('params')}</span>
                      <p className="text-sm font-mono text-gray-900">
                        {selectedFunction.argument_types || t('none')}
                      </p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500">{t('returnType')}</span>
                      <p className="text-sm font-mono text-gray-900">{selectedFunction.return_type}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500">{t('language')}</span>
                      <p className="text-sm text-gray-900">{selectedFunction.language}</p>
                    </div>
                  </div>
                  
                  <div>
                    <span className="text-xs text-gray-500">{t('sourceCode')}</span>
                    <pre className="mt-2 p-4 bg-gray-900 text-green-400 rounded-lg text-sm font-mono overflow-auto max-h-[400px]">
                      {selectedFunction.source_code || t('noSource')}
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
        title={functionCode.includes('CREATE OR REPLACE') ? t('editTitle') : t('createTitle')}
        size="xl"
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setShowCreateForm(false)}
              className="flex-1 h-11 px-5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-all duration-200"
            >
              {t('cancel')}
            </button>
            <button
              onClick={saveFunction}
              disabled={!functionCode.trim()}
              className="flex-1 h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md flex items-center justify-center"
            >
              <i className="fas fa-save mr-2"></i>
              {t('saveFn')}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          {/* 模板选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">{t('quickTemplate')}</label>
            <div className="grid grid-cols-2 gap-2">
              {FUNCTION_TEMPLATES.map((template, idx) => (
                <button
                  key={idx}
                  onClick={() => applyTemplate(template)}
                  className="p-3 text-left border border-gray-200 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors"
                >
                  <p className="text-sm font-medium text-gray-900">{t(template.nameKey)}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{template.language}</p>
                </button>
              ))}
            </div>
          </div>
          
          {/* 代码编辑器 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('fnDefinition')}</label>
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
        title={t('testTitle', { name: selectedFunction?.function_name || '' })}
        size="md"
        footer={
          <button
            onClick={testFunction}
            className="w-full h-11 px-5 text-sm font-medium text-white bg-gradient-to-r from-green-500 to-green-600 rounded-lg hover:from-green-600 hover:to-green-700 transition-all duration-200 shadow-sm hover:shadow-md flex items-center justify-center"
          >
            <i className="fas fa-play mr-2"></i>
            {t('execFn')}
          </button>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('fnParams')}
            </label>
            <div className="p-3 bg-gray-50 rounded-lg mb-3">
              <p className="text-sm font-mono text-gray-700">
({selectedFunction?.argument_types || t('noParams')})
              </p>
            </div>
            <input
              type="text"
              value={testParams}
              onChange={(e) => setTestParams(e.target.value)}
              placeholder={t('phArgs')}
              className="w-full input-base font-mono"
            />
            <p className="text-xs text-gray-500 mt-2">
              <i className="fas fa-info-circle mr-1"></i>
              {t('argsHint')}
            </p>
          </div>
          
          {testResult && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('execResult')}</label>
              <pre className="p-4 bg-gray-900 text-green-400 rounded-lg text-sm font-mono overflow-auto max-h-[250px]">
                {JSON.stringify(testResult.data, null, 2)}
              </pre>
              <p className="text-xs text-gray-500 mt-2 flex items-center">
                <i className="fas fa-clock mr-1"></i>
                {t('execTime', { ms: testResult.elapsed_ms })}
              </p>
            </div>
          )}
        </div>
      </Drawer>
    </div>
  )
}

