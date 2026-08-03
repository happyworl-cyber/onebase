/**
 * 项目 REST / RPC / DDL 接口文档的「唯一数据源」：curl 模板、端点数组与整页 Markdown。
 *
 * 登录态页面 `app/workspace/[projectId]/api/page.tsx` 与免登录公开页
 * `app/doc/api/[token]/page.tsx`（经 `RestApiDocContent`）共用这里的纯函数，
 * 避免同一份接口文档在两处各写一遍导致漂移。
 *
 * gatewayMode：走网关（配置了对外基址）时，示例统一由网关鉴权，不再展示 API Key 鉴权头。
 */

export type DocEndpointColor = 'green' | 'blue' | 'yellow' | 'red' | 'purple'

export interface DocEndpoint {
  method: string
  color: DocEndpointColor
  path: string
  desc: string
  body: string
}

export interface RestApiDocInput {
  /** 后端基址（可为空，公开页用 '' → 由浏览器 origin 决定）。 */
  apiBaseUrl: string
  /** REST 路径段：tenant_databases.slug（如 shirehub-test）。 */
  databaseSlug: string
  /** 当前 schema（如 gamesq / public）。 */
  schema: string
  /** 走网关时隐藏 API Key 鉴权头（网关统一鉴权）。默认 false，行为不变。 */
  gatewayMode?: boolean
}

export interface RestApiDoc {
  endpointBase: string
  rpcEndpointRoot: string
  ddlEndpointRoot: string
  sqlEndpoint: string
  genericTableEndpoints: DocEndpoint[]
  genericDdlEndpoints: DocEndpoint[]
  genericRawDdlEndpoints: DocEndpoint[]
  genericRpcEndpoints: DocEndpoint[]
  fullDocText: string
}

const TABLE_PH = '{table}'
const FN_PH = '{function}'

export function buildRestApiDoc({ apiBaseUrl, databaseSlug, schema, gatewayMode = false }: RestApiDocInput): RestApiDoc {
  const endpointBase = `${apiBaseUrl}/api/v1/${databaseSlug}/${schema}`
  const rpcEndpointRoot = `${apiBaseUrl}/api/v1/${databaseSlug}/rpc`
  const ddlEndpointRoot = `${apiBaseUrl}/api/v1/${databaseSlug}/ddl/tables`
  const sqlEndpoint = `${apiBaseUrl}/api/v1/${databaseSlug}/sql`

  const contentProfileLine = schema !== 'public' ? ` \\\n  -H "Content-Profile: ${schema}"` : ''
  const acceptProfileLine = schema !== 'public' ? ` \\\n  -H "Accept-Profile: ${schema}"` : ''
  // 走网关时鉴权由网关统一处理，示例不再展示 API Key 头。
  const authHeaderLine = gatewayMode ? '' : ` \\\n  -H "Authorization: Bearer YOUR_API_KEY"`

  const genericTableEndpoints: DocEndpoint[] = [
    {
      method: 'GET',
      color: 'green',
      path: `/${schema}/${TABLE_PH}`,
      desc: '获取记录列表',
      body: `curl "${endpointBase}/${TABLE_PH}?limit=10&offset=0"${authHeaderLine}`,
    },
    {
      method: 'GET',
      color: 'green',
      path: `/${schema}/${TABLE_PH}/:id`,
      desc: '获取单条记录',
      body: `curl "${endpointBase}/${TABLE_PH}/1"${authHeaderLine}`,
    },
    {
      method: 'POST',
      color: 'blue',
      path: `/${schema}/${TABLE_PH}`,
      desc: '创建记录',
      body: `curl -X POST "${endpointBase}/${TABLE_PH}"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -d '{"column1": "value1", "column2": "value2"}'`,
    },
    {
      method: 'PATCH',
      color: 'yellow',
      path: `/${schema}/${TABLE_PH}/:id`,
      desc: '更新记录',
      body: `curl -X PATCH "${endpointBase}/${TABLE_PH}/1"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -d '{"column1": "new_value"}'`,
    },
    {
      method: 'DELETE',
      color: 'red',
      path: `/${schema}/${TABLE_PH}/:id`,
      desc: '删除记录',
      body: `curl -X DELETE "${endpointBase}/${TABLE_PH}/1"${authHeaderLine}`,
    },
  ]

  const genericDdlEndpoints: DocEndpoint[] = [
    {
      method: 'POST',
      color: 'blue',
      path: `/api/v1/${databaseSlug}/ddl/tables`,
      desc: '创建表（结构化 body，服务端拼 SQL）',
      body: `curl -X POST "${ddlEndpointRoot}"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "schema": "${schema}",\n    "table": "my_table",\n    "columns": [\n      {"name":"id","data_type":"serial","nullable":false,"is_primary_key":true},\n      {"name":"title","data_type":"varchar","length":200,"nullable":false}\n    ]\n  }'`,
    },
    {
      method: 'PATCH',
      color: 'yellow',
      path: `/api/v1/${databaseSlug}/ddl/tables/${schema}/{table}`,
      desc: '修改表结构（加列、改类型、重命名等）',
      body: `curl -X PATCH "${ddlEndpointRoot}/${schema}/my_table"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "operations": [\n      {"kind":"add_column","column":{"name":"author","data_type":"varchar","length":100,"nullable":true}}\n    ]\n  }'`,
    },
    {
      method: 'DELETE',
      color: 'red',
      path: `/api/v1/${databaseSlug}/ddl/tables/${schema}/{table}`,
      desc: '删除表（?cascade=true 级联）',
      body: `curl -X DELETE "${ddlEndpointRoot}/${schema}/my_table?cascade=true"${authHeaderLine}`,
    },
  ]

  const genericRawDdlEndpoints: DocEndpoint[] = [
    {
      method: 'POST',
      color: 'blue',
      path: `/api/v1/${databaseSlug}/sql`,
      desc: '直接执行 DDL SQL（CREATE / ALTER / DROP / COMMENT）',
      body: `curl -X POST "${sqlEndpoint}"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "schema": "${schema}",\n    "sql": "CREATE TABLE ${schema}.my_table (id serial PRIMARY KEY, title varchar(200) NOT NULL)",\n    "acknowledge_destructive": true\n  }'`,
    },
  ]

  const genericRpcEndpoints: DocEndpoint[] = [
    {
      method: 'POST',
      color: 'blue',
      path: `/api/v1/${databaseSlug}/rpc/${FN_PH}`,
      desc: '默认：JSON body 按形参名传参（同 supabase.rpc）',
      body: `curl -X POST "${rpcEndpointRoot}/${FN_PH}"${authHeaderLine} \\\n  -H "Content-Type: application/json"${contentProfileLine} \\\n  -d '{"arg1": 1, "arg2": "demo"}'`,
    },
    {
      method: 'GET',
      color: 'green',
      path: `/api/v1/${databaseSlug}/rpc/${FN_PH}`,
      desc: '适合 IMMUTABLE / STABLE；字符串参数需 URL 编码',
      body: `curl -X GET "${rpcEndpointRoot}/${FN_PH}?arg1=1&arg2=%22demo%22"${authHeaderLine}${acceptProfileLine}`,
    },
    {
      method: 'POST',
      color: 'purple',
      path: `/api/v1/${databaseSlug}/rpc/${FN_PH}`,
      desc: '单 jsonb 实参：整段 body 作为一个参数',
      body: `curl -X POST "${rpcEndpointRoot}/${FN_PH}"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -H "Prefer: params=single-object"${contentProfileLine} \\\n  -d '{"payload": {"nested": true}}'`,
    },
  ]

  const authDocLines = gatewayMode
    ? [`## 鉴权`, `请求经网关统一鉴权，无需在调用侧携带 API Key。`]
    : [
        `## 鉴权`,
        `所有请求需带请求头 Authorization: Bearer <YOUR_API_KEY>（API Key 以 cr_ 开头；也支持 apikey: cr_... 头；登录用户可用 JWT）。`,
        `RPC 调用需在 API Key 的 scope 中包含 EXECUTE 动作；DDL 需包含 DDL 或 ALL。`,
      ]

  const fullDocText = [
    `# OneBase REST / RPC API`,
    ``,
    `基址 Base URL : ${apiBaseUrl}`,
    `项目标识 project : ${databaseSlug}`,
    `Schema : ${schema}`,
    ``,
    ...authDocLines,
    ``,
    `## 数据表 REST`,
    `路径前缀：${endpointBase}/{table}  （schema 已包含在路径中，无需 Profile 头；把 {table} 换成实际表名）`,
    ``,
    ...genericTableEndpoints.map(
      (e) => `### ${e.method} ${e.path}  —— ${e.desc}\n\`\`\`bash\n${e.body}\n\`\`\``
    ),
    ``,
    `### 查询参数（仅 GET 列表接口）`,
    `- select   选择返回字段          例：?select=id,name,email`,
    `- order    排序                 例：?order=created_at.desc`,
    `- limit    返回数量（最大 1000）  例：?limit=20`,
    `- offset   跳过数量（分页）       例：?offset=20`,
    `- field.eq / field.neq         等于 / 不等于    例：?status.eq=active`,
    `- field.gt / field.gte         大于 / 大于等于   例：?age.gte=18`,
    `- field.lt / field.lte         小于 / 小于等于   例：?price.lt=100`,
    `- field.like / field.ilike     模糊匹配         例：?name.ilike=%john%`,
    `- field.in                     集合匹配（IN）    例：?status.in=active,pending 或 ?id.in=1,2,3`,
    `- count                        总行数 COUNT(*)   例：?select=count`,
    `- field.聚合                    聚合 count/sum/avg/min/max，返回 字段_函数   例：?select=amount.sum,amount.avg`,
    `- 分组聚合                      select 同时带普通列与聚合，普通列自动 GROUP BY   例：?select=status,count`,
    ``,
    `## DDL（建表 / 改表 / 删表）`,
    `路径前缀：${ddlEndpointRoot}  （body 全结构化，不接受 raw SQL）`,
    `API Key 须启用新版 scope，Actions 含 DDL 或 ALL；Resources 允许目标 schema（如 ${schema}.*）。`,
    ``,
    ...genericDdlEndpoints.map(
      (e) => `### ${e.method} ${e.path}  —— ${e.desc}\n\`\`\`bash\n${e.body}\n\`\`\``
    ),
    ``,
    `## Raw DDL（直接 SQL）`,
    `路径：${sqlEndpoint}`,
    `仅允许 CREATE / ALTER / DROP / COMMENT；必须 acknowledge_destructive: true。`,
    `body.schema 用于 API Key Resources 校验（如 ${schema}.*）。`,
    ``,
    ...genericRawDdlEndpoints.map(
      (e) => `### ${e.method} ${e.path}  —— ${e.desc}\n\`\`\`bash\n${e.body}\n\`\`\``
    ),
    ``,
    `## RPC（存储过程 / 函数）`,
    `路径前缀：${rpcEndpointRoot}/{function}  （把 {function} 换成实际函数名）`,
    `POST 用 JSON body 按形参名传参；GET 用 Query（每个值先按 JSON 解析）。`,
    schema !== 'public'
      ? `非 public schema 的函数需加 Content-Profile / Accept-Profile: ${schema} 头。`
      : ``,
    ``,
    ...genericRpcEndpoints.map(
      (e) => `### ${e.method} ${e.path}  —— ${e.desc}\n\`\`\`bash\n${e.body}\n\`\`\``
    ),
  ].join('\n')

  return {
    endpointBase,
    rpcEndpointRoot,
    ddlEndpointRoot,
    sqlEndpoint,
    genericTableEndpoints,
    genericDdlEndpoints,
    genericRawDdlEndpoints,
    genericRpcEndpoints,
    fullDocText,
  }
}
