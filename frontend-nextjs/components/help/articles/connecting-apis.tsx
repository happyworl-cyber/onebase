import { HelpCode, HelpSection } from '@/components/help/HelpArticle'

const CURL = `curl "\${API_BASE}/api/v1/{库slug}/{schema}/{table}?limit=1" \\
  -H "Authorization: Bearer ob_..."`

export default function ConnectingApisArticle() {
  return (
    <>
      <HelpSection title="基址">
        <p>
          表 REST：<code className="font-mono text-xs">/api/v1/{'{库slug}'}/{'{schema}'}</code>，后面接表名。
          函数 RPC：<code className="font-mono text-xs">/api/v1/{'{库slug}'}/rpc/{'{function}'}</code>。
          库 slug 不是项目数字 id，以 REST API 页上的示例为准。
        </p>
      </HelpSection>
      <HelpSection title="鉴权">
        <p>
          默认带 <code className="font-mono text-xs">Authorization: Bearer &lt;API Key&gt;</code>，Key 以{' '}
          <code className="font-mono text-xs">ob_</code> 开头。也支持 <code className="font-mono text-xs">apikey</code> 头。
          登录用户可用 JWT。项目若配置了网关对外基址，鉴权由网关处理，调用方不一定再带 Key。
        </p>
      </HelpSection>
      <HelpSection title="选哪条路">
        <ul className="list-disc ml-5 space-y-1">
          <li>读写表 → REST。</li>
          <li>调数据库函数 → RPC。</li>
          <li>浏览器要实时收表变更 → SSE（实时推送页）。</li>
          <li>变更发生时通知你自己的 HTTP 服务 → Webhook。</li>
        </ul>
      </HelpSection>
      <HelpSection title="最小示例">
        <HelpCode>{CURL}</HelpCode>
        <p>
          RPC 把路径换成 <code className="font-mono text-xs">/rpc/{'{function}'}</code> 并改用 POST JSON。过滤参数、HTTP
          方法全集在 REST API 页，这里不重复。
        </p>
      </HelpSection>
    </>
  )
}
