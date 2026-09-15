# 项目凭证管理 — 设计文档

- 日期：2026-09-10
- 状态：已通过
- 范围：项目级类型化凭证库；密钥不回显；工作流可下拉引用或 `{{cred.名称.字段}}` / `cred.get`；收编现有数据源凭证。
- 相关代码：
  - `migrations/046_workflow_datasources.sql`
  - `src/datasource_handlers.rs`
  - `src/workflow_engine.rs`
  - `src/lua_builtins.rs`
  - `src/js_host_bridge.rs`
  - `src/py_runner.rs`
  - `src/mcp_tools.rs`
  - `frontend-nextjs/app/workspace/[projectId]/events/datasources/page.tsx`
  - `frontend-nextjs/app/workspace/[projectId]/settings/env-vars/page.tsx`
  - `frontend-nextjs/components/workspace/workspaceNav.ts`
  - `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`
  - `frontend-nextjs/lib/api.ts`
- 关联：环境变量仍独立（`031_project_env_vars.sql` / `{{env.X}}`），本期不改其明文回显。

## 1. 目标与非目标

环境变量适合非敏感配置，但设置页明文回显；数据源里已有「凭证管理」（`basic` / `bearer`，密钥不回显），却只能绑数据源，HTTP / 模板 / 代码节点用不上。

**目标**

1. 项目内一份类型化凭证库：`basic`、`bearer`、`api_key`。
2. 密钥加密入库，列表 / 详情 / 编辑框永不回显；更新留空表示不改密文。
3. 工作流用两种方式引用：节点下拉 `credential_id`，以及 `{{cred.名称.字段}}` / `cred.get("名称", "字段")`。
4. 收编「集成 → 数据源 → 凭证」：入口迁到「设置 → 凭证管理」，数据源只选项目凭证。

### 已确认需求

| 项 | 结论 |
|---|---|
| 形态 | 独立凭证库，不并进环境变量 |
| 第一期引用面 | 工作流 + 收编数据源凭证 |
| 类型 | `basic` / `bearer` / `api_key` |
| 引用 | 下拉 + 模板 / `cred.get` 都做 |
| 入口 | 设置 → 凭证管理 |
| 存储 | 在 `management.wf_credentials` 上演进，不迁密文 |

### 非目标

- OAuth、SMTP 等新类型
- 对象存储 / Redis / Kafka / ES 改成引用凭证
- 环境变量改脱敏或加「密钥」标记
- 保存后再揭开 / 复制明文
- 新建 `project_credentials` 表或把整份字段打成加密 JSON

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 表 | 继续 `management.wf_credentials` | 数据源外键已指向它；避免搬密文 |
| `api_key` 额外列 | `header_name`（明文、可回显） | 非机密；空则默认 `X-API-Key` |
| 密文列 | 仍用 `secret_encrypted` | 密码 / Token / API Key 三选一 |
| 主 API | `/api/projects/:id/credentials` | 与设置入口一致 |
| 旧 API | `/wf-credentials` 做别名 | 已有脚本不立刻断 |
| 模板字段解析 | 最后一段是字段名 | 兼容已有中文凭证名 |
| HTTP 同名头 | 凭证写入的头覆盖节点 Headers | 选了凭证就以凭证为准 |
| 数据源可绑类型 | 仅 `basic` | 库连接只要账号密码 |
| 列表权限 | `require_tenant_member` | 成员都能拉元数据供下拉；比现在的 admin-only 放宽；不含密钥 |
| 写权限 | `require_tenant_admin` | 与环境变量同档 |

## 3. 数据模型

新迁移（序号以当时仓库最大迁移 +1 为准）只做两件事：

1. `kind` 允许 `basic | bearer | api_key`（已有行不用改）。
2. 增加可空列 `header_name VARCHAR(128)`。仅 `api_key` 使用；写入时 trim，空则存 `NULL`，读取时按默认 `X-API-Key` 解释。

其余列不变：`tenant_id`、`name`（项目内唯一）、`username`、`secret_encrypted`、`description`、审计字段。`wf_datasources.credential_id` 外键不改。

**字段与类型**

| `kind` | 可回显 | 密文（`secret`） | 模板 / `cred.get` 字段 |
|---|---|---|---|
| `basic` | `username` | 密码 | `username`、`password` |
| `bearer` | — | Token | `token` |
| `api_key` | `header_name` | API Key | `api_key`、`header_name` |

`basic` 创建 / 改为 `basic` 时用户名必填。`bearer` / `api_key` 的 `username` 置空。`header_name` 只允许 HTTP 头名：字母数字、`_`、`-`，最长 128；含冒号、空格则 400。

名称规则维持现状：非空、最长 100 字、项目内唯一，不强制英文标识符。

## 4. API

主路径与旧路径共用同一组 handler。

| 方法 | 路径 | 权限 | 行为 |
|---|---|---|---|
| `GET` | `/api/projects/:id/credentials` | 项目成员 | 列表，无密钥 |
| `POST` | 同上 | 项目 admin / owner / 超管 | 新建，`secret` 必填非空 |
| `PUT` | `/api/projects/:id/credentials/:cred_id` | 同上写权限 | 更新；`secret` 缺省或空字符串 = 不改密文 |
| `DELETE` | 同上 | 同上写权限 | 仍被本项目数据源引用则 400 |

旧路径 `/api/projects/:id/wf-credentials`（及 `/:cred_id`）继续挂同一 handler。

**列表 / 写成功响应**（无 `secret`、无 `secret_encrypted`）：

```json
{
  "id": 1,
  "name": "生产库只读",
  "kind": "basic",
  "username": "app_ro",
  "header_name": null,
  "description": null,
  "has_secret": true,
  "ref_count": 2,
  "created_at": "...",
  "updated_at": "..."
}
```

`ref_count` 仍只统计数据源引用。工作流节点只存 `credential_id`，不做反向扫描。

删除被引用的凭证：拒绝，提示先在数据源里解绑。工作流里仍写着已删 id 时，执行该节点失败（见 §5.3），不在删除时拦工作流。

写操作记操作日志（名称、kind、id，不含密文），对齐环境变量审计。

## 5. 执行期引用

工作流开跑时按 `tenant_id` 解密装入 `ExecutionContext`，与 `env_vars` 同一时机。上下文按 **名称** 和 **id** 各建一份索引（模板 / `cred.get` 用名称，节点下拉用 id），带 kind 与字段表。手写 `Debug`：只打「N credentials masked」，不打任何字段值。

### 5.1 模板 `{{cred.名称.字段}}`

在现有 `resolve_path` 的 `env.` 旁增加 `cred.`：

- 去掉前缀后，**最后一段**必须是 `username` / `password` / `token` / `api_key` / `header_name`，前面整段是凭证名。
- 例：`{{cred.生产库账号.password}}` → 名称 `生产库账号`，字段 `password`。
- 名称不存在、字段与 kind 不匹配、缺少字段段：渲染空串，打 warn。与 `{{env.X}}` 未定义行为一致。
- `header_name` 在库中为 `NULL` 时，模板得到 `X-API-Key`。

`db` / `code` / `call_workflow` 等对部分 key 跳过模板的规则不变；跳过的 key 里写 `{{cred.*}}` 不会被替换。

### 5.2 代码节点 `cred.get`

`code` 字段不走模板，因此 Lua / JS / Python 宿主增加 `cred.get(name, field)`：

- 命中返回字符串。
- 未配置、字段不对：返回 `nil` / `null` / `None`，不抛错。可写 `cred.get("生产库账号", "password") or ""`。
- 与 `env.get` 一样只读项目凭证，不读进程环境。

### 5.3 节点下拉 `credential_id`

**http_call** 增加可选 `credential_id`（整数）。解析模板之后、发请求之前，按凭证 kind 写入头（覆盖节点 Headers 里的同名键）：

| kind | 写入 |
|---|---|
| `basic` | `Authorization: Basic base64(username:password)` |
| `bearer` | `Authorization: Bearer <token>` |
| `api_key` | `<header_name>: <api_key>` |

id 不属于本项目或不存在：该节点失败，错误只含 id / 名称，不含密钥。

**数据源** 继续用现有 `wf_datasources.credential_id`。创建 / 更新时若带了 id，该凭证必须是本项目且 `kind=basic`，否则 400。已有 `bearer` 凭证仍可供 HTTP 与模板使用，不能新绑到数据源。历史行若已绑非 `basic`，测试连接与 db 节点执行失败并提示改绑，避免把 Token 当成数据库密码。

### 5.4 脱敏

扩展现有 `mask_env_values`：把已装入的凭证密文字段（`password` / `token` / `api_key`）与环境变量值一起替换为 `***`。`username`、`header_name` 不脱敏。

覆盖面与环境变量相同：执行历史、debug 入参、`http_call` 记录里的请求头。`Authorization` 与 API Key 头若等于注入值，一并打码。

解密失败：管理 API 不解密密文，不受影响。开跑装载时单条失败则跳过该条（不写入上下文），其它凭证照常用；模板 / `cred.get` 视作未定义，带该 `credential_id` 的节点失败，错误为「凭证解密失败」，不含密文。

干跑：`http_call` 仍不实发；解析并注入后的头在记录里已脱敏。数据源「测试连接」仍只在服务端用解密密码，响应不回显密码。

## 6. 页面

**设置 → 凭证管理**（`/settings/credentials`）

- 侧栏与环境变量并列；`canManageMembers` 才显示管理页。
- 卡片布局沿用现数据源「凭证」Tab：类型、用户名或 `header_name`、密钥固定 `••••••••`、数据源引用数。
- 新建 / 编辑弹窗：先选 kind，再出对应字段。密钥只写；编辑占位「留空则不修改」。
- 删除需确认；仍被数据源引用则禁止并提示解绑。
- 页内说明模板与 `cred.get` 写法。

**数据源页**

- 去掉「凭证管理」Tab 与「新增凭证」。
- 表单凭证下拉只列 `basic`；旁路链接到 `/settings/credentials`。

**HTTP 节点**

- 「凭证」下拉（三种类型）。
- 选中后注明将按类型自动加认证头，并覆盖同名 Headers。
- Headers / URL / Body 仍可用 `{{cred.名称.字段}}`。

工作流编辑器通过 `GET /credentials` 拉下拉数据（成员即可）。MCP 节点说明补上 `{{cred.*}}` 与 `cred.get`。

## 7. 错误处理

| 情况 | 行为 |
|---|---|
| 非法 kind / 名称空 / 重名 | 400 |
| `basic` 无用户名 | 400 |
| `api_key` 的 `header_name` 非法 | 400 |
| 新建无 `secret` | 400 |
| 数据源绑非 `basic` | 400 |
| 删除仍被数据源引用 | 400 |
| 模板名称或字段对不上 | 空串 + warn |
| `cred.get` 未命中 | `nil` |
| `http_call` / 数据源执行时凭证缺失 | 该节点失败 |
| 单条解密失败 | 引用它的节点失败；错误无密文 |

## 8. 测试

后端：

- 列表 / 详情 JSON 不含 `secret`、`secret_encrypted`；更新 `secret` 留空后密文不变。
- `kind=api_key` 可建；`header_name` 空则运行时当 `X-API-Key`。
- 被数据源引用时删除失败。
- 数据源更新绑 `bearer` / `api_key` 失败；绑 `basic` 成功。
- `{{cred.NAME.password}}` 命中、未定义、字段与 kind 不匹配各一条。
- 中文名称 `{{cred.生产库账号.password}}` 解析正确。
- `http_call` 三种 kind 注入头正确；节点手写同名头被覆盖；记录中对应头为 `***`。
- Lua / JS / Python `cred.get` 命中与未命中。
- 项目成员可 `GET`，不可 `POST`/`PUT`/`DELETE`；非成员不可 `GET`。

前端不单独加单测：卡片不回显密钥、数据源无凭证 Tab、HTTP 节点有下拉。

## 9. 模块边界

| 单元 | 职责 | 依赖 |
|---|---|---|
| 迁移 | `kind` + `header_name` | 现表 |
| `datasource_handlers` 凭证部分 | CRUD、永不回显、数据源只绑 `basic` | `crypto`、`permissions` |
| `ExecutionContext` 凭证装载 | 开跑解密、按名索引、Debug 打码 | `wf_credentials` |
| `resolve_path` `cred.` | 模板取值 | 上下文 |
| Lua / JS / Python `cred.get` | 代码节点取值 | 同一装载结果 |
| `mask_env_values`（扩） | 执行输出打码 | 环境变量值 + 凭证密文字段 |
| `exec_http_call_node` | 按 `credential_id` 注入头 | 上下文 |
| 设置页 / 数据源页 / HTTP 配置 | 入口与下拉 | 新 API |

改凭证 handler 内部实现时，数据源执行路径（已有 JOIN 解密）只多校验 `kind=basic`，连接语义不变。
