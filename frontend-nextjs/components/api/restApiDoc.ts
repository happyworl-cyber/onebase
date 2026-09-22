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
  /** REST 路径段：tenant_databases.slug（如 acme-test）。 */
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
      desc: 'List records',
      body: `curl "${endpointBase}/${TABLE_PH}?limit=10&offset=0"${authHeaderLine}`,
    },
    {
      method: 'GET',
      color: 'green',
      path: `/${schema}/${TABLE_PH}/:id`,
      desc: 'Get a single record',
      body: `curl "${endpointBase}/${TABLE_PH}/1"${authHeaderLine}`,
    },
    {
      method: 'POST',
      color: 'blue',
      path: `/${schema}/${TABLE_PH}`,
      desc: 'Create a record',
      body: `curl -X POST "${endpointBase}/${TABLE_PH}"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -d '{"column1": "value1", "column2": "value2"}'`,
    },
    {
      method: 'PATCH',
      color: 'yellow',
      path: `/${schema}/${TABLE_PH}/:id`,
      desc: 'Update a record',
      body: `curl -X PATCH "${endpointBase}/${TABLE_PH}/1"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -d '{"column1": "new_value"}'`,
    },
    {
      method: 'DELETE',
      color: 'red',
      path: `/${schema}/${TABLE_PH}/:id`,
      desc: 'Delete a record',
      body: `curl -X DELETE "${endpointBase}/${TABLE_PH}/1"${authHeaderLine}`,
    },
  ]

  const genericDdlEndpoints: DocEndpoint[] = [
    {
      method: 'POST',
      color: 'blue',
      path: `/api/v1/${databaseSlug}/ddl/tables`,
      desc: 'Create table (structured body; server assembles SQL)',
      body: `curl -X POST "${ddlEndpointRoot}"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "schema": "${schema}",\n    "table": "my_table",\n    "columns": [\n      {"name":"id","data_type":"serial","nullable":false,"is_primary_key":true},\n      {"name":"title","data_type":"varchar","length":200,"nullable":false}\n    ]\n  }'`,
    },
    {
      method: 'PATCH',
      color: 'yellow',
      path: `/api/v1/${databaseSlug}/ddl/tables/${schema}/{table}`,
      desc: 'Alter table (add columns, change types, rename, etc.)',
      body: `curl -X PATCH "${ddlEndpointRoot}/${schema}/my_table"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "operations": [\n      {"kind":"add_column","column":{"name":"author","data_type":"varchar","length":100,"nullable":true}}\n    ]\n  }'`,
    },
    {
      method: 'DELETE',
      color: 'red',
      path: `/api/v1/${databaseSlug}/ddl/tables/${schema}/{table}`,
      desc: 'Drop table (?cascade=true for cascade)',
      body: `curl -X DELETE "${ddlEndpointRoot}/${schema}/my_table?cascade=true"${authHeaderLine}`,
    },
  ]

  const genericRawDdlEndpoints: DocEndpoint[] = [
    {
      method: 'POST',
      color: 'blue',
      path: `/api/v1/${databaseSlug}/sql`,
      desc: 'Execute DDL SQL directly (CREATE / ALTER / DROP / COMMENT)',
      body: `curl -X POST "${sqlEndpoint}"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "schema": "${schema}",\n    "sql": "CREATE TABLE ${schema}.my_table (id serial PRIMARY KEY, title varchar(200) NOT NULL)",\n    "acknowledge_destructive": true\n  }'`,
    },
  ]

  const genericRpcEndpoints: DocEndpoint[] = [
    {
      method: 'POST',
      color: 'blue',
      path: `/api/v1/${databaseSlug}/rpc/${FN_PH}`,
      desc: 'Default: JSON body passes args by parameter name (same as supabase.rpc)',
      body: `curl -X POST "${rpcEndpointRoot}/${FN_PH}"${authHeaderLine} \\\n  -H "Content-Type: application/json"${contentProfileLine} \\\n  -d '{"arg1": 1, "arg2": "demo"}'`,
    },
    {
      method: 'GET',
      color: 'green',
      path: `/api/v1/${databaseSlug}/rpc/${FN_PH}`,
      desc: 'Suitable for IMMUTABLE / STABLE; string arguments must be URL-encoded',
      body: `curl -X GET "${rpcEndpointRoot}/${FN_PH}?arg1=1&arg2=%22demo%22"${authHeaderLine}${acceptProfileLine}`,
    },
    {
      method: 'POST',
      color: 'purple',
      path: `/api/v1/${databaseSlug}/rpc/${FN_PH}`,
      desc: 'Single jsonb argument: the entire body is passed as one parameter',
      body: `curl -X POST "${rpcEndpointRoot}/${FN_PH}"${authHeaderLine} \\\n  -H "Content-Type: application/json" \\\n  -H "Prefer: params=single-object"${contentProfileLine} \\\n  -d '{"payload": {"nested": true}}'`,
    },
  ]

  const authDocLines = gatewayMode
    ? [`## Authentication`, `Requests are authenticated by the gateway; no API Key is needed on the caller side.`]
    : [
        `## Authentication`,
        `All requests must include the header Authorization: Bearer <YOUR_API_KEY> (API Keys start with ob_; the apikey: ob_... header is also supported; logged-in users may use a JWT).`,
        `RPC calls require the EXECUTE action in the API Key scope; DDL requires DDL or ALL.`,
      ]

  const fullDocText = [
    `# PlaneOS REST / RPC API`,
    ``,
    `Base URL : ${apiBaseUrl}`,
    `Project identifier : ${databaseSlug}`,
    `Schema : ${schema}`,
    ``,
    ...authDocLines,
    ``,
    `## Table REST`,
    `Path prefix: ${endpointBase}/{table}  (the schema is already in the path, no Profile header needed; replace {table} with the actual table name)`,
    ``,
    ...genericTableEndpoints.map(
      (e) => `### ${e.method} ${e.path}  —— ${e.desc}\n\`\`\`bash\n${e.body}\n\`\`\``
    ),
    ``,
    `### Query parameters (GET list endpoint only)`,
    `- select   choose returned fields          e.g. ?select=id,name,email`,
    `- order    sort                            e.g. ?order=created_at.desc`,
    `- limit    number of rows (max 1000)       e.g. ?limit=20`,
    `- offset   rows to skip (pagination)       e.g. ?offset=20`,
    `- field.eq / field.neq         equals / not equals    e.g. ?status.eq=active`,
    `- field.gt / field.gte         greater / greater-or-equal   e.g. ?age.gte=18`,
    `- field.lt / field.lte         less / less-or-equal   e.g. ?price.lt=100`,
    `- field.like / field.ilike     fuzzy match         e.g. ?name.ilike=%john%`,
    `- field.in                     set match (IN)    e.g. ?status.in=active,pending or ?id.in=1,2,3`,
    `- count                        total rows COUNT(*)   e.g. ?select=count`,
    `- field.<agg>                  aggregate count/sum/avg/min/max, returns field_function   e.g. ?select=amount.sum,amount.avg`,
    `- group aggregate             select mixes plain columns and aggregates; plain columns auto GROUP BY   e.g. ?select=status,count`,
    ``,
    `## DDL (create / alter / drop table)`,
    `Path prefix: ${ddlEndpointRoot}  (fully structured body; raw SQL is not accepted)`,
    `The API Key must use the new scope with Actions including DDL or ALL; Resources must allow the target schema (e.g. ${schema}.*).`,
    ``,
    ...genericDdlEndpoints.map(
      (e) => `### ${e.method} ${e.path}  —— ${e.desc}\n\`\`\`bash\n${e.body}\n\`\`\``
    ),
    ``,
    `## Raw DDL (direct SQL)`,
    `Path: ${sqlEndpoint}`,
    `Only CREATE / ALTER / DROP / COMMENT are allowed; acknowledge_destructive: true is required.`,
    `body.schema is used for API Key Resources validation (e.g. ${schema}.*).`,
    ``,
    ...genericRawDdlEndpoints.map(
      (e) => `### ${e.method} ${e.path}  —— ${e.desc}\n\`\`\`bash\n${e.body}\n\`\`\``
    ),
    ``,
    `## RPC (stored procedures / functions)`,
    `Path prefix: ${rpcEndpointRoot}/{function}  (replace {function} with the actual function name)`,
    `POST passes args by parameter name via JSON body; GET uses the query string (each value is parsed as JSON first).`,
    schema !== 'public'
      ? `Functions in a non-public schema require the Content-Profile / Accept-Profile: ${schema} header.`
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
