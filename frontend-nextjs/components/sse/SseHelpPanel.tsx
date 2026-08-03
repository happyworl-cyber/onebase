/**
 * 实时推送规则（SSE 转发）使用说明面板。
 *
 * 工作区入口 `/workspace/.../automation/sse-routes` 使用（老后台 `/dashboard/sse-routes`
 * 已在 W2/W3 收尾时删除）。内容覆盖：原理 → 字段含义 → 客户端订阅 → 端到端示例。
 *
 * 与后端对齐（src/sse.rs）：
 *   - topic 授权前缀：user:{uid}:* / db:{dbId}:* / sys:*（超管）
 *   - 订阅入口：GET /sse?token=<jwt>&topics=a,b,c（支持末尾 * 通配）
 */
export default function SseHelpPanel() {
  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-6 space-y-5 text-sm text-gray-700">
      <div>
        <h2 className="text-base font-semibold text-gray-900 mb-1">
          <i className="fas fa-circle-info text-blue-500 mr-2"></i>这是什么
        </h2>
        <p className="leading-relaxed">
          配置一条规则后，当数据库发生 <b>INSERT / UPDATE / DELETE</b> 且命中「事件模式」时，
          平台会自动把这次变更写进你指定的 <b>topic</b>。客户端通过浏览器原生的{' '}
          <code className="font-mono">EventSource</code> 长连接订阅该 topic，实时收到推送
          （无需轮询、无需自己搭 WebSocket）。
        </p>
      </div>

      <div>
        <h3 className="font-semibold text-gray-900 mb-2">字段说明</h3>
        <ul className="space-y-1.5 list-disc list-outside ml-5">
          <li>
            <b>数据库 / 作用范围</b>：选具体库只匹配该库的变更；选「该租户全部库」匹配本租户所有库。
          </li>
          <li>
            <b>事件模式</b>：格式 <code className="font-mono">schema.table.action</code>，支持{' '}
            <code className="font-mono">*</code> 通配。例：
            <code className="font-mono">public.orders.INSERT</code>、
            <code className="font-mono">*.*.UPDATE</code>、
            <code className="font-mono">*.*.*</code>（全部）。
          </li>
          <li>
            <b>目标 topic 模板</b>：命中后推送到的 topic。占位符会按实际事件替换：
            <code className="font-mono">{'{database_id}'}</code>{' '}
            <code className="font-mono">{'{schema}'}</code>{' '}
            <code className="font-mono">{'{table}'}</code>{' '}
            <code className="font-mono">{'{action}'}</code>。例：
            <code className="font-mono">db:{'{database_id}'}:{'{schema}'}.{'{table}'}:{'{action}'}</code>{' '}
            在 db=2、public.orders 的 INSERT 时解析为{' '}
            <code className="font-mono">db:2:public.orders:INSERT</code>。
          </li>
          <li>
            <b>SSE event 名</b>：客户端 <code className="font-mono">addEventListener(名字, ...)</code>{' '}
            用的事件名；留空则用动作名（INSERT/UPDATE/DELETE）。
          </li>
        </ul>
      </div>

      <div>
        <h3 className="font-semibold text-gray-900 mb-2">客户端如何订阅</h3>
        <p className="leading-relaxed mb-2">
          连接 <code className="font-mono">/sse</code>，用 query 参数带上 JWT 和要订阅的 topic
          （逗号分隔，支持末尾 <code className="font-mono">*</code> 通配）：
        </p>
        <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 text-xs overflow-x-auto leading-relaxed">{`const es = new EventSource(
  '/sse?token=' + jwt + '&topics=' + encodeURIComponent('db:2:*')
)

// event 名 = 规则里的「SSE event 名」，留空时为 INSERT/UPDATE/DELETE
es.addEventListener('INSERT', (e) => {
  const evt = JSON.parse(e.data) // { topic, event, data, id, ts }
  console.log('收到变更', evt.topic, evt.data)
})

es.onerror = () => { /* EventSource 会自动重连 */ }`}</pre>
        <p className="leading-relaxed mt-2 text-xs text-gray-500">
          授权：只能订阅你有权限的 topic 前缀——
          <code className="font-mono">user:{'{你的uid}'}:*</code>（自己的）、
          <code className="font-mono">db:{'{dbId}'}:*</code>（你是该库所属租户成员）、
          <code className="font-mono">sys:*</code>（仅平台超管）。订阅未授权的 topic 会被拒绝。
        </p>
      </div>

      <div>
        <h3 className="font-semibold text-gray-900 mb-2">端到端示例</h3>
        <ol className="space-y-1 list-decimal list-outside ml-5 text-xs leading-relaxed">
          <li>
            建规则：数据库选 <code className="font-mono">orders 库</code>，事件模式{' '}
            <code className="font-mono">public.orders.INSERT</code>，topic 模板{' '}
            <code className="font-mono">db:{'{database_id}'}:orders:new</code>，event 名{' '}
            <code className="font-mono">order_created</code>。
          </li>
          <li>
            业务往 <code className="font-mono">public.orders</code> 插一行 → 平台推送到{' '}
            <code className="font-mono">db:2:orders:new</code>，event 名{' '}
            <code className="font-mono">order_created</code>。
          </li>
          <li>
            前端 <code className="font-mono">new EventSource('/sse?token=…&topics=db:2:*')</code> 并{' '}
            <code className="font-mono">addEventListener('order_created', …)</code> 即可实时收到。
          </li>
        </ol>
      </div>
    </div>
  )
}
