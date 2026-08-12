//! MCP 工具集 —— 工作流创作工作台的 11 个固定工具
//!
//! 设计原则（见 .omc/plans/onebase-workflow-mcp-plan.md）：
//! - 工具直接构造 axum extractor 调用现有 handler，权限/校验/审计零重复；
//! - create 创建即启用（is_enabled=true）；update 剥离 is_enabled——启停仍留人在页面操作；
//! - debug 默认 dry_run=true；**生产实例**（RUST_ENV 非 development/staging/test，
//!   含未设置，与 auth.rs 的 fail-safe 惯例一致）注入 prod_readonly，由引擎层
//!   拦截副作用（含 Lua http / CTE 写穿透）。测试/正式独立部署，权限随实例环境走。

use axum::extract::{Path, Query, State};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::HashMap;

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::workflow_handlers::{
    self, CreateWorkflowRequest, DebugWorkflowRequest, UpdateWorkflowRequest,
};

/// 节点知识库：AI 编写工作流定义的"说明书"。
/// 内容与引擎实际行为对齐（workflow_engine.rs 各 exec_*_node + NodeType 定义）。
/// !!! 红线：新增/修改节点类型（NodeType 变体、exec_*_node 的 config 字段）
/// 必须同步更新此常量，否则 AI 编写工作流会依据过时规范产生错误定义。 !!!
const NODE_SPEC: &str = r#"# OneBase 工作流节点规范

工作流 = nodes[] + edges[] 组成的 DAG（有向无环图），引擎按拓扑序执行。
例外：loop 节点的「回边」(edge_type=loop_back) 允许成环，该回边不参与拓扑排序（见 loop 节点）。

## 定义结构
```json
{
  "nodes": [{ "id": "唯一ID", "type": "节点类型", "label": "可选展示名", "config": { ... } }],
  "edges": [{ "from": "上游节点ID", "to": "下游节点ID",
             "branch": "可选：condition 分支名 / loop 的 body|done 出口",
             "edge_type": "可选：loop_back（循环回边）",
             "target_handle": "可选：back（loop 回边落点）" }]
}
```

## 模板变量（所有 config 字符串中可用）
- `{{trigger.字段}}`：本次触发的入参（endpoint 触发 = 请求 body / query）
- `{{节点ID.字段}}`：上游节点输出，支持嵌套与下标：`{{q.rows[0].id}}`
- `{{env.变量名}}`：项目级环境变量（在「设置 → 环境变量」页面管理），可用于任意节点 config，如 http_call 的 header、email 地址等；未定义的变量解析为空串。执行历史与 debug 输出中变量值会自动脱敏为 `***`

## 节点类型（15 种）

### db_query（只读查询）
config: `{ "sql": "SELECT ...", "params": [可选绑定参数], "datasource_id": 可选整数, "dynamic_sql": 可选布尔 }`
- 仅允许 SELECT / WITH 开头；输出 `{ "rows": [...], "count": N }`
- `datasource_id`：显式指定项目内共享数据源（覆盖工作流默认绑定库），按其类型（PostgreSQL/MySQL 系）分流执行；不填则用工作流绑定的默认库
- `dynamic_sql`（默认 false）：开启后整条 sql 视为模板先解析成文本再原样执行（不参数化），用于表名/字段等标识符随上游变化、无法走绑定参数的场景；作者需自行转义拼入的用户输入。关闭时 sql 原文 + `{{}}` 走参数化绑定，防注入
- 生产实例 MCP 调试时在 READ ONLY 事务中执行，任何写入被 PostgreSQL 拒绝

### db_execute（写操作）
config: `{ "sql": "INSERT/UPDATE/DELETE ...", "params": [...], "datasource_id": 可选整数, "dynamic_sql": 可选布尔 }`
- 禁止 DROP / TRUNCATE；输出 `{ "rows_affected": N }`
- `datasource_id` / `dynamic_sql` 语义同 db_query
- dry_run / 生产库调试时不真实执行，返回 mock

### db_transaction（单事务多条 SQL）
config: `{ "statements": [{ "sql": "...", "params": [...] }, ...], "datasource_id": 可选整数 }`
- 单个数据库事务内顺序执行 statements，全成功才提交，任一失败整体回滚
- 禁止 DROP / TRUNCATE；输出 `{ "rows_affected": N, "statements_count": N }`
- 仅支持 PostgreSQL 数据源

### foreach（遍历执行子 SQL）
config: `{ "items": "上游数据路径（不含花括号，如 q.rows）", "statements": [{ "sql": "...", "params": [...] }, ...], "item_var": "可选，默认 item", "datasource_id": 可选整数 }`
- `items` 解析结果必须是数组；每个元素依次绑定为 `item_var`（config 内可用 `{{item.字段}}` 引用当前项），每个元素的 statements 在独立事务中执行
- 禁止 DROP / TRUNCATE；输出 `{ "processed": N, "rows_affected": N }`
- 仅支持 PostgreSQL 数据源

### call_workflow（调用子工作流）
config: `{ "workflow": "子工作流 slug", "input": { 可模板化的 JSON 对象 }, "allow_failure": 可选布尔 }`
- 同租户内按 slug 解析已启用的工作流，同步等待其执行结果；`input` 作为子工作流的 trigger_data
- 子工作流的 response 节点输出作为本节点输出（无 response 节点则给出全部节点输出）
- 环检测：禁止调用自身或调用链上已存在的工作流；调用深度上限 5 层
- 子工作流任一节点硬失败会让本节点也失败（可用 `allow_failure` 容错）

### redis（Redis 数据源操作）
config: `{ "connection_id": 整数, "op": "操作名", ...按 op 变化的参数 }`
- 支持的 op：get/set/del/exists/expire/ttl/incr/decr/keys/hget/hset/hgetall/lpush/rpush/lrange/sadd/smembers/zadd/zcard/zremrangebyrank
- 常用参数字段：`key`（主键）、`value`（set/hset/*push 的值）、`values`（lpush/rpush 多值数组）、`members`（sadd 多成员）、`field`（hget/hset 字段）、`ttl`（set/expire 过期秒数）、`nx`（set 是否 NX）、`pattern`（keys 匹配模式）、`start`/`stop`（lrange 区间，或 zremrangebyrank 的排名闭区间，rank 0 = score 最小/最旧）、`count`（keys 扫描上限，默认 1000 封顶 10000）、`member`（zadd 成员）、`score`（zadd 分值，由调用方/上游节点传入，节点本身不取当前时间）
- zadd：单对 key+member+score 写入，输出 `result.added` 为新增成员数；zcard：取 key 集合大小（key 不存在返回 0），输出 `result.count`；zremrangebyrank：按排名闭区间批量删除，输出 `result.removed` 为删除数量
- `connection_id` 按 `ctx.tenant_id` 校验，杜绝跨租户取数；写操作（set/del/expire/incr/decr/hset/lpush/rpush/sadd/zadd/zremrangebyrank）在 dry_run / 生产只读下返回 mock，读操作照常执行
- 输出 `{ "op": "...", "result": ... }`

### kafka（Kafka 生产消息）
config: `{ "connection_id": 整数, "op": "produce", "topic": "主题（可模板）", "key": "可选消息键（可模板）", "value": "消息体字符串或 JSON", "headers": {可选字符串键值，可模板} }`
- 首期仅支持 `op=produce`；`connection_id` 取自项目「集成 → Kafka」登记的连接，按租户校验
- `value` 为字符串时原样发送；为对象/数组时 JSON 序列化后发送
- dry_run / 生产只读下不真实发消息，返回 mock；成功输出 `{ "op": "produce", "result": { "topic", "partition", "offset", "key" } }`
- 消费侧请用 `trigger_type=kafka` 工作流触发器（非本节点）

### object_storage（对象存储操作）
config: `{ "connection_id": 整数, "op": "put|get|delete|list|presign", ...按 op 变化的参数 }`
- `connection_id` 取自项目「集成 → 对象存储」登记的连接，按 `ctx.tenant_id` 校验
- 常用参数：`key`（put/get/delete/presign）、`content`（put 正文，字符串或 base64）、`prefix`/`max_keys`（list）、`method`/`expires_in`（presign）、`keys`（delete 批量，数组）
- 写操作（put/delete/presign PUT）在 dry_run / 生产只读下返回 mock；读操作照常执行
- 输出 `{ "op": "...", "result": ... }`；body 上限等限额与数据 API 一致（见 object_storage_ds::commands）

### http_call（外部 HTTP）
config: `{ "method": "GET|POST|PUT|PATCH|DELETE", "url": "https://...", "headers": {对象}, "body": 任意 }`
- 禁止内网地址；超时 30s；输出 `{ "status", "headers", "body" }`

### email_send（邮件）
config: `{ "from": "Name <a@b.c>", "to": "x@y.z 或逗号分隔", "cc"/"bcc" 可选, "subject", "body" }`
- SMTP 由环境变量提供（ONEBASE_SMTP_* / SMTP_*）；输出 `{ "sent", "accepted", "subject" }`

### condition（条件分支）
config: `{ "conditions": [{ "branch": "分支名", "expression": "表达式" }], "default_branch": "默认分支名" }`
- 表达式：`左值 运算符 右值`，运算符 == != > >= < <=；值可为 `{{模板}}`、"字符串"、数字、true/false/null
- 也支持单值 truthy：`{{q.count}}`；`always`/`never` 恒真/恒假
- 命中分支后，只有 edges 中 branch 等于该分支名的下游链路会执行，其余分支链路整体跳过
- 输出 `{ "matched_branch": "..." }`

### loop（循环，控制流）
config: `{ "loop_mode": "while|until|count|for_each", "expression": "表达式（while/until）",
          "max_iterations": 100, "delay_ms": 0, "count": 3（count 模式，支持模板）,
          "items": "{{数组模板}}"（for_each）, "concurrency": 1（for_each，暂仅串行）,
          "allow_failure": false }`
- 出边用 branch：`"body"` = 循环体入口链路、`"done"` = 循环结束后的后续链路
- 循环体最后一个节点用回边连回本节点：`{ "from": "体末节点", "to": "loop节点", "edge_type": "loop_back", "target_handle": "back" }`
- 每个 loop 恰好 1 条 body 出边 + 1 条 loop_back 回边，done 最多 1 条；循环体必须闭合，不得与外部/其他并列 loop 共享节点
- while/until 必须有 expression 且 max_iterations>=1；所有模式服务端硬上限为 1000 次，for_each 当前仅支持 concurrency=1
- 模式：while=进体前判断（表达式真则继续）；until=执行体后判断（真则退出，至少一次）；count=定长次数；for_each=遍历数组
- 循环体内可引用：`{{loop.index}}`（从0）、`{{loop.count}}`（从1）、`{{loop.item}}`（for_each 当前元素）、`{{loop.reached_max}}`
- 输出 `{ "iterations", "index", "count", "reached_max", "results": [每轮循环体末节点输出] }`；详细 `_iterations` 最多保留前 100 轮，超出时 `_iterations_truncated=true`
- 循环体节点硬失败会中断整个工作流；配 allow_failure=true 则记录失败后继续下一轮

### transform（数据变换）
config: `{ "output": 任意 JSON 模板 }`（缺省时整个 config 即输出模板）
- 模板变量替换后原样输出，用于拼装/重命名字段

### response（HTTP 响应，endpoint 工作流必备出口）
config: `{ "status_code": 200, "body": JSON 模板, "headers": {可选} }`
- endpoint 触发的调用方收到 body 作为响应

### sse_publish（SSE 推送）
config: `{ "topic": "主题（可含模板）", "event": "事件名，默认 message", "data": "JSON 字符串或留空=触发数据" }`
- 输出 `{ "topic", "event", "delivered": 订阅者数 }`
- 对外订阅端点 `/events/:slug` 可选：`subscription_slug`、`identity_header`（默认 X-Way-UID）、
  `graceful_close_enabled`（true/false）、`graceful_close_seconds`（开启时到点先发 `event: exit` 再断开）。
  不配置 `graceful_close_enabled` 时回退全局 `SSE_GRACEFUL_CLOSE_*`（默认关，即永不断开）。

### code（脚本：Lua / JavaScript / Python，复杂逻辑兜底）
config: `{ "code": "源码", "language": "lua|javascript|python（可选，默认 lua）" }`

#### 通用
- `ctx.nodes` = 各上游节点输出（键为节点 id）；`ctx.body` = 触发数据；修改 `ctx.body` 或 `return` 普通对象作为输出
- 支持裸脚本，或定义 `function execute(ctx) { ... }` / `module.exports.execute`（JS）/ `function execute(ctx) ... end`（Lua）/ `def execute(ctx): ...`（Python）；引擎包装层自动调用 `execute(ctx)`（若存在）
- 注意：code 节点在 dry_run 下仍真实执行（分支与计算逻辑需要）

#### JavaScript（Node.js）
- 缺省启用；如需关闭设 `WORKFLOW_JS_CODE_ENABLED=false`。宿主机需安装 `node`/`npm`（可用 `WORKFLOW_NODE_BIN` / `WORKFLOW_NPM_BIN` 指定路径）
- `config.language`: `javascript` 或 `js`；省略或其它值走 Lua
- 工作流级 npm 依赖（与 `nodes`/`edges` 同级，不挂在单个节点）：
```json
"dependencies": {
  "javascript": {
    "packageJson": {
      "name": "workflow-1",
      "private": true,
      "dependencies": { "lodash": "^4.17.21" }
    },
    "packageLock": null
  }
}
```
  - `packageJson`：完整或最小 `package.json` 对象，至少含 `dependencies`
  - `packageLock`：可选 lockfile 全文字符串；有则优先 `npm ci --omit=dev`，否则 `npm install --omit=dev`
  - 依赖安装失败时工作流仍可保存，但执行 JS code 节点前须 `ready`，否则节点失败
- 宿主 API（IPC 桥，与 Lua 对齐）：`env.get(key)`、`http.get/post/put/delete`、`log.info/warn/error/debug`、`json.encode/encode_pretty/decode`、`time.now()`/`time.now_ms()`、`sse.publish`、`google.sa_assertion(project, scope)`
- `crypto`（部分实现）：`sha256`、`hmac_sha256`、`uuid`、`base64_encode`/`base64_decode`；其余 `crypto.*`（md5/aes/rsa/base64url 等）调用会报错「not implemented by JS host bridge」
- 用户代码可通过 `require()` 加载工作流 `node_modules` 中的包（CommonJS）
- 沙箱：子进程 + bwrap（若可用，`WORKFLOW_JS_SANDBOX=direct|none|raw` 可关闭）；生产库调试时 `http.*` 禁用
- 示例：
```javascript
const token = env.get('API_TOKEN');
const row = ctx.nodes?.query?.rows?.[0];
ctx.body = { ok: true, id: row?.id, hasToken: !!token };
// 或 async function execute(ctx) {
//   const r = await http.get('https://api.example.com/ping');
//   return { status: r.status, body: r.json ?? r.body };
// }
```

#### Python（CPython）
- 缺省启用；如需关闭设 `WORKFLOW_PY_CODE_ENABLED=false`。宿主机需安装 `python3`/`pip`（可用 `WORKFLOW_PYTHON_BIN` / `WORKFLOW_PIP_BIN` 指定路径）
- `config.language`: `python` 或 `py`；省略或其它值走 Lua
- `ctx` 为对象式访问：读 `ctx.body`、`ctx.nodes["nodeId"]`；改 `ctx.body` 或 `return` 普通 dict/list 作为输出
- 工作流级 pip 依赖（与 `nodes`/`edges` 同级，不挂在单个节点），`requirements` 支持字符串数组或多行字符串：
```json
"dependencies": {
  "python": {
    "requirements": ["requests==2.31.0", "numpy>=1.24"]
  }
}
```
  - 依赖以 `pip install --target site-packages` 装到工作流私有目录（可用 `WORKFLOW_PIP_INDEX_URL` 指定源、`WORKFLOW_PIP_INSTALL_TIMEOUT_MS` 调超时）
  - 依赖安装失败时工作流仍可保存，但执行 Python code 节点前须 `ready`，否则节点失败
- 宿主 API（复用同一 IPC 桥，与 Lua/JS 对齐）：`env.get(key)`、`http.get/post/put/delete`、`log.info/warn/error/debug`、`json.encode/encode_pretty/decode`、`time.now()`/`time.now_ms()`、`sse.publish`、`google.sa_assertion(project, scope)`
- `crypto`（部分实现）：`sha256`、`hmac_sha256`、`uuid`、`base64_encode`/`base64_decode`
- 沙箱：子进程 + bwrap（若可用，`WORKFLOW_PY_SANDBOX=direct|none|raw` 可关闭）；超时 `WORKFLOW_PY_TIMEOUT_MS`（默认 30s）；生产库调试时 `http.*` 禁用
- 示例：
```python
def execute(ctx):
    token = env.get('API_TOKEN')
    row = (ctx.nodes or {}).get('query', {}).get('rows', [{}])[0]
    return { "ok": True, "id": row.get('id'), "hasToken": bool(token) }
```

#### Lua（默认）
- 省略 `language` 或 `language=lua`
- 可用：json.encode/decode、log、env、http.get/post、time.now()/time.now_ms()（沙箱无 os，取时间用它）、以及 crypto：
  - 摘要/HMAC：sha256、hmac_sha256、hmac_sha256_raw_key、md5、sha1、hmac_sha1（后三者仅兼容旧系统，勿用于安全场景）
  - 编码：base64_encode/base64_decode、base64url_encode（JWT 段用）
  - 随机：uuid、random_hex
  - RSA：rsa_encrypt（PKCS#1 v1.5）、rsa_encrypt_oaep（OAEP-SHA256）、rsa_decrypt、rsa_sign_sha256（RS256 签名，返回标准 base64；可用来在 Lua 里自建 RS256 JWT，如 Google SA 换 OAuth token）
  - 对称加密：aes_encrypt(opts) / aes_decrypt(opts)。opts：mode(cbc|gcm|ecb，默认cbc)、key + key_encoding(utf8|hex|base64|base64url)、iv + iv_encoding（cbc需16字节/gcm需12字节）、padding(pkcs7|zero|none，默认pkcs7)、plaintext/ciphertext、input_encoding、output_encoding、aad(仅gcm)。gcm密文为 `密文||16字节tag`。用于精确对接外部/旧系统的加解密方案
- google.sa_assertion(project, scope) -> { assertion, project_id, client_email }：只传 project 字符串，宿主按 project+工作流tenant_id+服务端保密盐派生 K8s 密钥名、读 Service Account JSON 签出 RS256 JWT，私钥永不进 Lua（需运维配 FCM_KEY_SALT + 挂载 SA JSON 到 /app/secrets/fcm，见 .env.example）。用 assertion 去 http.post https://oauth2.googleapis.com/token 换 access_token；project_id 供 FCM v1 发送 URL（projects/{project_id}/messages:send）使用，与 token 的 SA 同源、避免 azp/project 不匹配
- `env.get("变量名")` 读项目级环境变量（同 `{{env.X}}` 的来源）：不再读进程环境变量、无 `PLUGIN_` 前缀限制；未配置的变量返回 nil（不再抛错），可写 `env.get("X") or "默认值"` 兜底
- 沙箱：无 os/io/文件系统；生产库调试时 http.* 直接报错

## 触发类型（trigger_type）
- `endpoint`：GET/POST /workflow/{database_slug}/{workflow_slug}（最常用，替代接口代码）
- `cron`：定时（trigger_config 配 cron 表达式）
- `hook`：数据变更事件（trigger_config: {table, schema, actions, database_id}）
- `notify`：pg NOTIFY 桥接
- `manual`：仅手动触发
- `kafka`：消费 Kafka topic（trigger_config: {connection_id, topic, group_id?, auto_offset_reset?, value_format?}）

## 约束
- 除 loop 回边(edge_type=loop_back)外必须无环；condition 分支边必须带 branch 标签；loop 出边用 body/done 标签
- endpoint 工作流建议以 response 节点收尾，否则返回最后一个成功节点的输出
- MCP 创建的工作流创建即启用（is_enabled=true）；如需下线由人在页面禁用
"#;

/// 11 个工具的 MCP 定义（tools/list 响应体）
pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "node_spec",
            "description": "获取工作流节点规范：15 种节点的 config 格式、模板变量语法、条件表达式、循环、触发类型与约束。编写任何工作流定义前必读。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "list_workflows",
            "description": "列出工作流（按权限过滤）。可按 database_id / tenant_id / department / category / search 关键字筛选。",
            "inputSchema": { "type": "object", "properties": {
                "database_id": { "type": "integer", "description": "按数据库筛选" },
                "tenant_id": { "type": "integer", "description": "按租户筛选" },
                "department": { "type": "string", "description": "服务/部门精确匹配（树第一级，如 共享/Acme/acme-central）" },
                "category": { "type": "string", "description": "分类精确匹配（树第二级，业务领域）" },
                "search": { "type": "string", "description": "name/slug/description 模糊匹配" }
            } }
        },
        {
            "name": "get_workflow",
            "description": "获取单个工作流完整定义（nodes/edges/trigger 配置），用于查看现状或参考已有写法。",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer", "description": "工作流 ID" }
            }, "required": ["id"] }
        },
        {
            "name": "create_workflow",
            "description": "创建工作流，创建即启用（is_enabled 默认 true）；如需下线由人在页面禁用。nodes/edges 结构见 node_spec。",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string" },
                "slug": { "type": "string", "description": "小写字母/数字/连字符" },
                "description": { "type": "string" },
                "department": { "type": "string", "description": "服务/部门（树第一级）。只用已有值（先 list_workflows 看现有 department 取值，如 共享/Acme/acme-central）；跨项目复用的归「共享」；要新增服务名必须先与人确认，不许随手造新值" },
                "category": { "type": "string", "description": "分类（树第二级），按业务领域命名（如 发帖/帖子列表/登录），不按技术来源命名（禁止「xx迁移」这类）。优先复用该 department 下已有分类，避免新造同义词；APP/web 行为差异不用分类区分，用 slug 后缀（-app/-web）区分" },
                "database_id": { "type": "integer", "description": "绑定的数据库（endpoint 路径用其 slug）" },
                "tenant_id": { "type": "integer" },
                "trigger_type": { "type": "string", "enum": ["endpoint", "hook", "cron", "manual", "notify", "kafka"] },
                "trigger_config": { "type": "object" },
                "nodes": { "type": "array" },
                "edges": { "type": "array" },
                "timeout_ms": { "type": "integer" },
                "max_retries": { "type": "integer" },
                "version_note": { "type": "string", "description": "本次保存的版本备注（展示在版本历史中）" }
            }, "required": ["name", "slug", "nodes", "edges"] }
        },
        {
            "name": "update_workflow",
            "description": "更新工作流（不能修改启用状态——发布权留人）。仅传需要变更的字段。改节点有两种方式：① 全量——传 nodes（整段替换）；② 增量——传 node_patch（按节点 id upsert，只改动的节点，未涉及节点原样保留）和/或 remove_node_ids（删节点）。node_patch/remove_node_ids 与全量 nodes 互斥。edges 仍为全量替换。",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer", "description": "工作流 ID" },
                "name": { "type": "string" },
                "slug": { "type": "string" },
                "description": { "type": "string" },
                "department": { "type": "string", "description": "服务/部门（树第一级）。只用已有值（先 list_workflows 看现有取值）；新增服务名须先与人确认" },
                "category": { "type": "string", "description": "分类（树第二级），按业务领域命名（如 发帖/帖子列表/登录）；优先复用该 department 下已有分类" },
                "database_id": { "type": "integer" },
                "trigger_type": { "type": "string" },
                "trigger_config": { "type": "object" },
                "nodes": { "type": "array", "description": "全量替换整个节点数组；与 node_patch/remove_node_ids 互斥" },
                "node_patch": { "type": "array", "description": "增量节点补丁：数组里每个节点按 id 与现有节点合并，整节点替换（id 存在则替换、不存在则新增），每个节点须带 id" },
                "remove_node_ids": { "type": "array", "items": { "type": "string" }, "description": "要删除的节点 id 列表；可与 node_patch 同时用" },
                "edges": { "type": "array" },
                "timeout_ms": { "type": "integer" },
                "max_retries": { "type": "integer" },
                "version_note": { "type": "string", "description": "版本备注；仅当本次更新改动了定义（含 nodes/node_patch/remove_node_ids，产生新版本快照）时记录，纯元信息修改不产生版本" }
            }, "required": ["id"] }
        },
        {
            "name": "duplicate_workflow",
            "description": "复制一个已有工作流为新副本。强制 is_enabled=false（启用需人在页面操作）：自动生成唯一 slug（<slug>-copy）、名字加「(副本)」后缀，tenant/database 跟随源工作流。适合基于现有工作流改造——先克隆再用 update_workflow 改动。",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer", "description": "源工作流 ID" }
            }, "required": ["id"] }
        },
        {
            "name": "debug_workflow",
            "description": "调试运行一套（可未保存的）工作流定义，返回逐节点 output/status/耗时。默认 dry_run=true（跳过写库/HTTP/邮件/SSE）。dry_run=false 真实执行：非生产实例（RUST_ENV=development/staging/test）放开全部节点；生产实例自动进入只读护栏——仅 db_query 真实执行（READ ONLY 事务），副作用节点返回 blocked_by=production_readonly，Lua http 报错。",
            "inputSchema": { "type": "object", "properties": {
                "nodes": { "type": "array" },
                "edges": { "type": "array" },
                "database_id": { "type": "integer" },
                "tenant_id": { "type": "integer" },
                "trigger_type": { "type": "string" },
                "trigger_data": { "description": "模拟触发入参（{{trigger.x}} 的数据源）" },
                "timeout_ms": { "type": "integer" },
                "dry_run": { "type": "boolean", "description": "默认 true" }
            }, "required": ["nodes", "edges"] }
        },
        {
            "name": "workflow_api_doc",
            "description": "生成工作流接口文档：扫描节点中 {{trigger.X}} 引用推导入参清单，给出调用地址与 curl 示例。交付前生成给人看。",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer", "description": "工作流 ID" }
            }, "required": ["id"] }
        },
        {
            "name": "get_workflow_runs",
            "description": "查询工作流执行历史（含每次的节点结果与错误信息），用于排错。",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer", "description": "工作流 ID" },
                "limit": { "type": "integer", "description": "默认 20，最大 100" }
            }, "required": ["id"] }
        },
        {
            "name": "list_workflow_versions",
            "description": "查询工作流版本历史（仅元信息，不含 nodes/edges 大字段）。每次保存自动产生一个版本。",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer", "description": "工作流 ID" },
                "limit": { "type": "integer", "description": "默认 50，最大 200" }
            }, "required": ["id"] }
        },
        {
            "name": "get_workflow_version",
            "description": "获取工作流某个历史版本的完整快照（含 nodes/edges），用于对比或参考旧实现。回滚（恢复版本）由人在页面操作。",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "integer", "description": "工作流 ID" },
                "version": { "type": "integer", "description": "版本号（来自 list_workflow_versions）" }
            }, "required": ["id", "version"] }
        }
    ])
}

/// tools/call 分发：返回 Ok(工具结果 JSON)；业务失败以 AppError 上抛，由 server 层转 isError 内容
pub async fn call_tool(
    pool: &PgPool,
    claims: &Claims,
    name: &str,
    args: &Value,
) -> Result<Value> {
    match name {
        "node_spec" => Ok(json!({ "spec": NODE_SPEC })),
        "list_workflows" => tool_list_workflows(pool, claims, args).await,
        "get_workflow" => {
            let id = require_id(args)?;
            let resp = workflow_handlers::get_workflow(
                State(pool.clone()),
                Path(id),
                axum::Extension(claims.clone()),
            )
            .await?;
            Ok(resp.0)
        }
        "create_workflow" => tool_create_workflow(pool, claims, args).await,
        "update_workflow" => tool_update_workflow(pool, claims, args).await,
        "duplicate_workflow" => tool_duplicate_workflow(pool, claims, args).await,
        "debug_workflow" => tool_debug_workflow(pool, claims, args).await,
        "workflow_api_doc" => tool_workflow_api_doc(pool, claims, args).await,
        "get_workflow_runs" => {
            let id = require_id(args)?;
            let mut params = HashMap::new();
            if let Some(limit) = args.get("limit").and_then(|v| v.as_i64()) {
                // 钳到 1..=100：负数会让 SQL `LIMIT` 报错、0 静默返回空集误导 AI
                params.insert("limit".to_string(), limit.clamp(1, 100).to_string());
            }
            let resp = workflow_handlers::get_workflow_runs(
                State(pool.clone()),
                Path(id),
                Query(params),
                axum::Extension(claims.clone()),
            )
            .await?;
            Ok(resp.0)
        }
        "list_workflow_versions" => {
            let id = require_id(args)?;
            let mut params = HashMap::new();
            if let Some(limit) = args.get("limit").and_then(|v| v.as_i64()) {
                // 钳到 1..=200：与 handler 上限一致；负数会让 SQL `LIMIT` 报错、0 静默返回空集误导 AI
                params.insert("limit".to_string(), limit.clamp(1, 200).to_string());
            }
            let resp = workflow_handlers::list_workflow_versions(
                State(pool.clone()),
                Path(id),
                Query(params),
                axum::Extension(claims.clone()),
            )
            .await?;
            Ok(resp.0)
        }
        "get_workflow_version" => {
            let id = require_id(args)?;
            // 与 require_id 同理：用 try_from 防止超出 i32 的值回绕命中错误版本
            let version = args
                .get("version")
                .and_then(|v| v.as_i64())
                .and_then(|v| i32::try_from(v).ok())
                .ok_or_else(|| {
                    AppError::InvalidQuery("缺少必填参数 version 或 version 超出范围".to_string())
                })?;
            let resp = workflow_handlers::get_workflow_version(
                State(pool.clone()),
                Path((id, version)),
                axum::Extension(claims.clone()),
            )
            .await?;
            Ok(resp.0)
        }
        _ => Err(AppError::NotFound(format!("未知工具: {}", name))),
    }
}

fn require_id(args: &Value) -> Result<i32> {
    // 用 try_from 而非 `as i32`：超出 i32 的值会回绕命中另一条工作流（静默操作错对象）
    args.get("id")
        .and_then(|v| v.as_i64())
        .and_then(|v| i32::try_from(v).ok())
        .ok_or_else(|| AppError::InvalidQuery("缺少必填参数 id 或 id 超出范围".to_string()))
}

async fn tool_list_workflows(pool: &PgPool, claims: &Claims, args: &Value) -> Result<Value> {
    let mut params: HashMap<String, String> = HashMap::new();
    for key in ["database_id", "tenant_id", "department", "category", "search"] {
        if let Some(v) = args.get(key) {
            let s = match v {
                Value::String(s) => s.clone(),
                // LLM 常对可选参数传显式 null；序列化成 "null" 会变成错误筛选值
                Value::Null => continue,
                other => other.to_string(),
            };
            if !s.is_empty() {
                params.insert(key.to_string(), s);
            }
        }
    }
    let resp = workflow_handlers::list_workflows(
        State(pool.clone()),
        Query(params),
        axum::Extension(claims.clone()),
    )
    .await?;
    Ok(resp.0)
}

async fn tool_create_workflow(pool: &PgPool, claims: &Claims, args: &Value) -> Result<Value> {
    let mut req: CreateWorkflowRequest = serde_json::from_value(args.clone())
        .map_err(|e| AppError::InvalidQuery(format!("create_workflow 参数错误: {}", e)))?;
    // MCP 创建即启用（创建就是为了用）；如需下线由人在页面禁用
    req.is_enabled = Some(true);
    let (_status, resp) = workflow_handlers::create_workflow(
        State(pool.clone()),
        axum::Extension(claims.clone()),
        None,
        Some(axum::Extension(crate::operation_log::OpSourceHint(
            crate::operation_log::Source::Mcp,
        ))),
        axum::Json(req),
    )
    .await?;
    let mut out = resp.0;
    if let Some(obj) = out.as_object_mut() {
        obj.insert(
            "notice".to_string(),
            json!("工作流已创建并启用；如需下线可在页面禁用"),
        );
    }
    Ok(out)
}

async fn tool_duplicate_workflow(pool: &PgPool, claims: &Claims, args: &Value) -> Result<Value> {
    let id = require_id(args)?;
    // 直接复用 handler：副本由 handler 内部强制 is_enabled=false，无需在此剥离启用状态
    let (_status, resp) = workflow_handlers::duplicate_workflow(
        State(pool.clone()),
        Path(id),
        axum::Extension(claims.clone()),
        None,
        Some(axum::Extension(crate::operation_log::OpSourceHint(
            crate::operation_log::Source::Mcp,
        ))),
    )
    .await?;
    let mut out = resp.0;
    if let Some(obj) = out.as_object_mut() {
        obj.insert(
            "notice".to_string(),
            json!("副本已创建但处于禁用状态，请在页面复审后启用"),
        );
    }
    Ok(out)
}

async fn tool_update_workflow(pool: &PgPool, claims: &Claims, args: &Value) -> Result<Value> {
    let id = require_id(args)?;
    let mut req: UpdateWorkflowRequest = serde_json::from_value(args.clone())
        .map_err(|e| AppError::InvalidQuery(format!("update_workflow 参数错误: {}", e)))?;
    // 安全语义：MCP 不可改启用状态
    req.is_enabled = None;

    let resp = workflow_handlers::update_workflow(
        State(pool.clone()),
        Path(id),
        axum::Extension(claims.clone()),
        None,
        Some(axum::Extension(crate::operation_log::OpSourceHint(
            crate::operation_log::Source::Mcp,
        ))),
        axum::Json(req),
    )
    .await?;
    Ok(resp.0)
}

/// 实例环境判定：测试/正式独立部署，权限随实例走。
/// 与 auth.rs 的 RUST_ENV 惯例一致：development/staging/test = 非生产，
/// 其余值（含未设置）按生产对待（fail-safe）。
pub fn instance_environment() -> String {
    std::env::var("RUST_ENV").unwrap_or_default()
}

/// 当前实例是否按生产对待（决定 MCP 调试的只读护栏）
pub fn instance_is_production() -> bool {
    !matches!(
        instance_environment().as_str(),
        "development" | "staging" | "test"
    )
}

async fn tool_debug_workflow(pool: &PgPool, claims: &Claims, args: &Value) -> Result<Value> {
    let mut req: DebugWorkflowRequest = serde_json::from_value(args.clone())
        .map_err(|e| AppError::InvalidQuery(format!("debug_workflow 参数错误: {}", e)))?;

    // MCP 语义：默认干跑；显式 dry_run=false 才真实执行
    let dry_run = req.dry_run.unwrap_or(true);
    req.dry_run = Some(dry_run);

    // 生产只读护栏：生产实例一律注入，与 dry_run 无关——
    // dry_run 下 code(Lua) 节点仍真实执行，Lua http 也必须被禁。
    let env = instance_environment();
    req.prod_readonly = instance_is_production();

    let resp = workflow_handlers::debug_workflow(
        State(pool.clone()),
        axum::Extension(claims.clone()),
        axum::Json(req),
    )
    .await?;
    let mut out = resp.0;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("dry_run".to_string(), json!(dry_run));
        obj.insert("environment".to_string(), json!(env));
    }
    Ok(out)
}

/// 扫描所有节点 config 中的 `{{trigger.X}}` 引用，提取顶层字段名。
/// 与前端 collectTriggerFields 同一业务规则（正则 `/\{\{\s*trigger\./`）：
/// - 容忍 `{{` 与 `trigger` 之间的空白（引擎 resolve 路径时会 trim）；
/// - 字段名允许非 ASCII（中文等，引擎与 NODE_SPEC 示例都支持），用 is_alphanumeric。
pub fn scan_trigger_fields(nodes: &Value) -> Vec<String> {
    let raw = serde_json::to_string(nodes).unwrap_or_default();
    let chars: Vec<char> = raw.chars().collect();
    let n = chars.len();
    let mut fields: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 1 < n {
        if chars[i] == '{' && chars[i + 1] == '{' {
            let mut j = i + 2;
            while j < n && chars[j].is_whitespace() {
                j += 1;
            }
            // 匹配关键字 "trigger."
            let kw: String = chars[j..n.min(j + 8)].iter().collect();
            if kw == "trigger." {
                j += 8;
                let field: String = chars[j..]
                    .iter()
                    .take_while(|c| c.is_alphanumeric() || **c == '_' || **c == '-')
                    .collect();
                if !field.is_empty() && !fields.contains(&field) {
                    fields.push(field);
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    fields
}

async fn tool_workflow_api_doc(pool: &PgPool, claims: &Claims, args: &Value) -> Result<Value> {
    let id = require_id(args)?;
    // 经 get_workflow 拿定义，顺带完成权限校验
    let resp = workflow_handlers::get_workflow(
        State(pool.clone()),
        Path(id),
        axum::Extension(claims.clone()),
    )
    .await?;
    let workflow = resp.0.get("workflow").cloned().unwrap_or(Value::Null);

    let slug = workflow.get("slug").and_then(|v| v.as_str()).unwrap_or("");
    let trigger_type = workflow
        .get("trigger_type")
        .and_then(|v| v.as_str())
        .unwrap_or("endpoint");
    let database_id = workflow.get("database_id").and_then(|v| v.as_i64());

    // endpoint 地址需要 database slug
    let db_slug: Option<String> = match database_id {
        Some(did) => sqlx::query("SELECT slug FROM management.tenant_databases WHERE id = $1")
            .bind(did as i32)
            .fetch_optional(pool)
            .await?
            .map(|r| r.get::<String, _>("slug")),
        None => None,
    };

    let fields = scan_trigger_fields(workflow.get("nodes").unwrap_or(&Value::Null));
    let sample_body: Value = fields
        .iter()
        .map(|f| (f.clone(), json!("示例值")))
        .collect::<serde_json::Map<String, Value>>()
        .into();

    let (endpoint, curl) = match (trigger_type, &db_slug) {
        ("endpoint", Some(db)) => {
            let url = format!("/workflow/{}/{}", db, slug);
            let curl = format!(
                "curl -X POST '{{BASE_URL}}{}' \\\n  -H 'Authorization: Bearer ob_你的APIKey' \\\n  -H 'Content-Type: application/json' \\\n  -d '{}'",
                url,
                serde_json::to_string(&sample_body).unwrap_or_default()
            );
            (Some(url), Some(curl))
        }
        _ => (None, None),
    };

    Ok(json!({
        "workflow_id": id,
        "name": workflow.get("name"),
        "trigger_type": trigger_type,
        "endpoint": endpoint,
        "input_fields": fields.iter().map(|f| json!({
            "field": f,
            "template": format!("{{{{trigger.{}}}}}", f),
            "type": "按业务确认（自动扫描仅能推导字段名）"
        })).collect::<Vec<_>>(),
        "sample_body": sample_body,
        "curl_example": curl,
        "note": if fields.is_empty() { "未检测到 {{trigger.字段}} 引用——本工作流不依赖外部入参，传空 body 即可。" } else { "字段来自节点中 {{trigger.X}} 引用的自动扫描，类型需按业务确认。" }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_trigger_fields_nested_and_dedup() {
        let nodes = json!([
            { "id": "q", "type": "db_query", "config": { "sql": "SELECT * FROM t WHERE a = '{{trigger.user_id}}' AND b = '{{trigger.plan.name}}'" } },
            { "id": "t", "type": "transform", "config": { "output": { "x": "{{trigger.user_id}}", "y": "{{q.rows[0].id}}" } } }
        ]);
        let fields = scan_trigger_fields(&nodes);
        // user_id 去重；plan 取顶层字段名；{{q.*}} 不属于 trigger 不收
        assert_eq!(fields, vec!["user_id".to_string(), "plan".to_string()]);
    }

    #[test]
    fn test_scan_trigger_fields_empty() {
        let nodes = json!([{ "id": "r", "type": "response", "config": { "body": {"ok": true} } }]);
        assert!(scan_trigger_fields(&nodes).is_empty());
    }

    #[test]
    fn test_scan_trigger_fields_whitespace_and_non_ascii() {
        // 引擎支持带空格 {{ trigger.x }} 与非 ASCII 字段名，扫描器必须一致
        let nodes = json!([
            { "id": "a", "type": "transform", "config": { "v": "{{ trigger.user_id }}" } },
            { "id": "b", "type": "transform", "config": { "v": "{{trigger.用户名}}" } }
        ]);
        let fields = scan_trigger_fields(&nodes);
        assert_eq!(fields, vec!["user_id".to_string(), "用户名".to_string()]);
    }

    #[test]
    fn test_require_id_rejects_out_of_i32_range() {
        // 超出 i32 的 id 必须报错，而非 `as i32` 回绕命中别的工作流
        assert!(require_id(&json!({ "id": 4_294_967_297i64 })).is_err());
        assert_eq!(require_id(&json!({ "id": 7 })).unwrap(), 7);
        assert!(require_id(&json!({})).is_err());
    }

    #[test]
    fn test_instance_production_fail_safe() {
        // 仅 development/staging/test 视为非生产，其余（含未设置）按生产
        std::env::set_var("RUST_ENV", "development");
        assert!(!instance_is_production());
        std::env::set_var("RUST_ENV", "production");
        assert!(instance_is_production());
        std::env::remove_var("RUST_ENV");
        assert!(instance_is_production()); // 未设置 = fail-safe 生产
    }

    #[test]
    fn test_tool_definitions_shape() {
        let defs = tool_definitions();
        let arr = defs.as_array().expect("tools 应为数组");
        assert_eq!(arr.len(), 11);
        for t in arr {
            assert!(t.get("name").is_some());
            assert!(t.get("description").is_some());
            assert!(t.get("inputSchema").is_some());
        }
    }
}
