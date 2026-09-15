import { HelpCode, HelpSection } from '@/components/help/HelpArticle'

const CURL = `curl "\${API_BASE}/api/v1/{库slug}/{schema}/{table}?limit=1" \\
  -H "Authorization: Bearer ob_..."`

export default function GettingStartedArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>
          项目工作区把 PostgreSQL 变成可管理的后端：建表、配权限、自动得到 REST / RPC。
          这篇只讲已经进入某个项目之后怎么走第一步。
        </p>
      </HelpSection>
      <HelpSection title="第一次建议怎么走">
        <ol className="list-decimal ml-5 space-y-1">
          <li>看项目首页，确认当前项目无误。</li>
          <li>侧栏顶部的 Schema 选择器选对 schema（常见是 public）。</li>
          <li>打开「表」查看已有表，或用「表设计器」建一张。</li>
          <li>打开「REST API」看这张表对应的端点。</li>
          <li>在「安全 → API Key」创建一把密钥，再用下面的命令调通一次。</li>
        </ol>
      </HelpSection>
      <HelpSection title="调通一次">
        <HelpCode>{CURL}</HelpCode>
        <p>
          把 <code className="font-mono text-xs">API_BASE</code>、库 slug、schema、表名和 Key
          换成项目里的值。完整方法列表与过滤参数在 REST API 页。
        </p>
      </HelpSection>
      <HelpSection title="注意">
        <p>新建项目在工作区选择页，不在本页。权限不够时，目标功能页会自己拦住，帮助目录仍全部可见。</p>
      </HelpSection>
    </>
  )
}
