# 工作流 LLM 节点 — 设计文档

- 日期：2026-09-11
- 状态：待评审
- 范围：项目级 LLM 连接（OpenAI 兼容 Chat Completions）+ 工作流一等 `llm` 节点（prompt / 可选 messages / 流式 / JSON 模式）。
- 相关代码：
  - `src/workflow_engine.rs`（`NodeType`、`validate_definition`、`exec_http_call_node`、dry_run）
  - `src/workflow_stream.rs`（StreamBridge、OpenAI SSE 抽文本）
  - `src/workflow_credentials.rs`（bearer / api_key 注入）
  - `src/mcp_tools.rs`（`NODE_SPEC`）
  - `src/redis_handlers.rs` / `migrations/046_redis_connections.sql`（连接登记对照）
  - `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`
  - `frontend-nextjs/components/workflow/NodeTypes.tsx`
  - `frontend-nextjs/components/workflow/WorkflowCanvas.tsx`
  - `frontend-nextjs/components/workspace/workspaceNav.ts`
- 关联：
  - `2026-09-07-endpoint-http-streaming-design.md`（复用 StreamBridge，不新开流协议）
  - `2026-09-10-project-credentials-design.md`（密钥只走项目凭证）
  - `2026-05-13-platform-evolution-design.md`（M7 `LlmProvider` 本期不实现）
  - 项目级通用 AI Provider（工作流质量审查继续使用项目配置，不使用平台内置密钥）

## 1. 目标与非目标

现状：调大模型靠 `http_call` 手写 URL / headers / body；`stream: true` 已能透传 OpenAI 兼容 SSE。体验远于 Dify 的 LLM 节点，密钥和模型散落在图里。

**目标**

1. 项目内登记 LLM 连接：`base_url` + 可选凭证 + 模型列表。密钥不写在节点上。
2. 画布新增 `llm` 节点：选连接和模型、写 system/user prompt、可选传入 messages、温度 / max_tokens、JSON 模式、流式。
3. 下游稳定消费 `{ text, json?, usage, model, finish_reason, streamed? }`。
4. debug / dry_run 默认真调模型（费用走用户自己的 key）；节点可 `skip_llm` 跳过。

### 已确认需求

| 项 | 结论 |
|---|---|
| 范围 | LLM 节点 + 项目级模型连接；不做 Agent / 知识库 / 问题分类 |
| 对话 | 单次补全；可选把上游 / trigger 的 messages 数组传入；节点不存会话 |
| 协议 | 只对接 OpenAI 兼容 `POST {base_url}/chat/completions` |
| 流式 | 复用 StreamBridge；与 `http_call.stream` 合计全图最多一个 |
| 结构化输出 | 可选 `json_object`；解析成功多 `json` 字段；失败则节点失败 |
| dry_run | 默认真调；仅节点 `skip_llm: true` 返回 mock |
| 内网 | 连接由管理员登记，允许内网 `base_url`（自建 vLLM / Ollama） |
| 平台适配层 | 不抽 `LlmProvider` trait |

### 非目标（第一期）

- Agent / function calling / 工具调用
- 知识库 / RAG / embedding
- 会话记忆表、conversation_id
- 视觉 / 多模态（`content` 只允许字符串）
- Anthropic 原生 Messages、国内厂商原生 SDK
- `json_schema` structured output
- 平台级模型目录、按 token 计费 / 配额
- 429 自动重试
- debug 页「全局跳过所有 LLM」总开关（只有节点级 `skip_llm`）
- 工作流 `max_retries` 接线（现状本就未接线，本期不顺手做）

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 形态 | 新表 + 新节点，不是 `http_call` 套壳 | dry_run / 输出形状 / 流式约束与 HTTP 节点不同，套壳会泄漏协议细节 |
| 连接入口 | **集成 → LLM**（`/events/llm-connections`） | 与 Redis / Kafka / 对象存储并列；对话里「设置 → LLM」仅指「项目内登记」，侧栏归集成 |
| 密钥 | `credential_id` → 现有 `wf_credentials` | 不在连接表再加密一份；Ollama 等可空 |
| `base_url` | OpenAI 兼容根（建议含 `/v1`），引擎拼 `/chat/completions` | 覆盖 OpenAI / DeepSeek / vLLM / Ollama / 网关；禁止节点改写 URL |
| 模型名 | 连接上的字符串列表；节点必须选列表内字面量 | 保存期就能校验；第一期不做 `{{trigger.model}}` |
| 组消息 | system_prompt → messages 数组 → user_prompt | 支持「系统人设 + 调用方历史 + 本轮问题」 |
| messages 的 role | 只允许 `system` / `user` / `assistant` | 不做 tool；非法 role 失败 |
| `json` 解析失败 | 节点硬失败（可用 `allow_failure`） | 避免下游当成功对象用 |
| 输出不含 `raw` / 完整 SSE | 只留 `text` + 可选 `json` + `usage` | 执行记录不被大模型原文撑爆 |
| dry_run 与 `http_call` | **不**走 `http_call` 的 mock 路径 | 调 prompt 必须看真实回复 |
| `prod_readonly` | 仍允许真调 LLM | 打的是用户供应商，不写业务库 |
| SSRF | 运行时 URL 只来自连接表 | 登记时可内网；节点不能把 trigger 拼进 host |
| 客户端模块 | `src/workflow_llm.rs`（或 `llm_ds`）只服务此节点 | 等真有 NL2SQL 再抽 trait |

## 3. 架构

```
集成 → LLM 连接页                    设置 → 凭证管理
management.llm_connections           wf_credentials
  name / base_url / models[]           bearer | api_key
  credential_id? ───────────────────►
        │
        ▼
llm 节点 config
  connection_id + model + prompts + 参数
        │
        ▼
exec_llm_node
  1. 模板解析  2. 按租户取激活连接  3. 组 messages
  4. skip_llm → mock
  5. POST {base_url}/chat/completions
     非流式：解析 choices[0].message.content
     流式：StreamBridge（与 http_call 同一条桥）
        │
        ▼
{ text, json?, usage, model, finish_reason, streamed? }
下游 {{llm.text}} / {{llm.json.field}}
```

新增节点按现有清单接线：`NodeType` → `exec_llm_node` → `NODE_SPEC` → `NODE_TYPE_META` / 调色板 / `NodeConfigPanel`。

## 4. 数据模型

新迁移（序号以当时仓库最大编号 +1 为准，撰写时下一号为 `067`）：

```sql
CREATE TABLE management.llm_connections (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            INTEGER NOT NULL
                         REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name      VARCHAR(100) NOT NULL,
    base_url             TEXT NOT NULL,
    credential_id        INTEGER
                         REFERENCES management.wf_credentials(id) ON DELETE SET NULL,
    models               TEXT[] NOT NULL DEFAULT '{}',
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_by           INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_llm_conn_name UNIQUE (tenant_id, connection_name)
);

CREATE INDEX idx_llm_connections_tenant
    ON management.llm_connections(tenant_id)
    WHERE is_active;
```

**字段规则**

- `connection_name`：trim 后非空，租户内唯一。
- `base_url`：trim；必须 `http://` 或 `https://`；**允许内网 / localhost**；去掉末尾 `/` 后存储。
- `credential_id`：可空；若填必须属于同一 `tenant_id`。推荐 `bearer` / `api_key`；`basic` 不禁止（少数网关用）。
- `models`：非空字符串数组，元素 trim、去空项；大小写敏感。允许先存空列表（节点此时选不了模型）。
- 删除连接：允许，不扫工作流引用（与 Redis 一致）；执行时找不到或未激活则节点失败。
- 列表 / 详情 **永不** 带出凭证密文；只回 `credential_id` 与凭证名（若 join）。

**拼 URL（执行与探活共用）**

- Chat Completions：`{base_url}/chat/completions`（`base_url` 已无尾斜杠）。
- 探活：`GET {base_url}/models`。
- `base_url` 必须是 API 根（例如 `https://api.openai.com/v1`），**不要**写成完整 `/chat/completions` 地址。实现不做「已含 completions 则不再拼接」的猜测。

## 5. 管理 API 与前端

权限对齐 Redis 连接：写操作为超管 / 租户 owner-admin；列表供工作流下拉，过滤规则与 `redis_handlers::list_connections` 相同。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/admin/llm-connections?tenant_id=` | 列表（无密钥） |
| POST | `/api/admin/llm-connections` | 创建 |
| GET | `/api/admin/llm-connections/:id` | 详情 |
| PUT | `/api/admin/llm-connections/:id` | 更新 |
| DELETE | `/api/admin/llm-connections/:id` | 删除 |
| POST | `/api/admin/llm-connections/test` | 未保存探活：body 含 `base_url` + 可选 `credential_id` |
| POST | `/api/admin/llm-connections/:id/health` | 已保存探活 |

探活：带凭证 GET `/models`。失败返回错误摘要，**不阻止保存**。`/models` 返回 404 视为探活失败（提示「供应商未实现 /models」），仍可保存。

前端：

- 侧栏「集成」增加「LLM」，页面镜像 Redis 连接页（名称、base_url、凭证下拉、模型标签编辑、启用、测试、删除）。
- 工作流调色板「集成」组加入 `llm`（在 `http_call` 旁）。
- `NodeConfigPanel`：连接下拉 → 模型下拉（随连接变）；system / user 用现有 `CodeSnippetEditor`；messages 用 JSON 字段（可 `{{trigger.messages}}`）；temperature 数字；max_tokens 可选；勾选 `json_mode` / `stream` / `skip_llm`。

第一期不做数据面 `/api/llm-connections/:id/exec`（聊天试玩台）。试 prompt 走工作流 debug。

## 6. 节点 config 与消息组装

```json
{
  "connection_id": 12,
  "model": "deepseek-chat",
  "system_prompt": "你是客服。用户等级={{trigger.level}}",
  "user_prompt": "问题：{{trigger.question}}",
  "messages": "{{trigger.messages}}",
  "temperature": 0.7,
  "max_tokens": 2048,
  "json_mode": false,
  "stream": false,
  "timeout_secs": 120,
  "skip_llm": false
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `connection_id` | 是 | 整数；运行时按 `ctx.tenant_id` 取激活连接 |
| `model` | 是 | 字面量，必须 ∈ 该连接 `models`；不做模板 |
| `system_prompt` | 否 | 字符串，走 `{{ }}`；trim 后空则不生成 system 条 |
| `user_prompt` | 否 | 同上 |
| `messages` | 否 | 见下 |
| `temperature` | 否 | 缺省 `0.7`；范围 `[0, 2]`；超出则校验/执行失败 |
| `max_tokens` | 否 | 正整数；缺省则请求体不带该字段 |
| `json_mode` | 否 | 默认 false；true 时请求带 `response_format: { "type": "json_object" }` |
| `stream` | 否 | 默认 false |
| `timeout_secs` | 否 | 与 `http_call` 相同：默认 120；`0` = 不限制，由工作流 `timeout_ms` 兜底 |
| `skip_llm` | 否 | 默认 false；true 时不发 HTTP |
| `allow_failure` | 否 | 现有节点级字段，语义不变 |

**`messages` 解析**

模板替换之后：

- 缺省 / `null` / 空串 → 视为没有历史。
- 字符串：按 JSON 解析，必须是数组。
- 已是数组：直接用。
- 其它类型：节点失败。

数组每一项必须是对象，且：

- `role` 为 `system` | `user` | `assistant`
- `content` 为字符串（第一期拒绝 array / 对象，避免视觉内容）

**组装顺序（固定）**

1. `system_prompt` 非空 → `{ "role": "system", "content": ... }`
2. 追加 `messages` 各项
3. `user_prompt` 非空 → `{ "role": "user", "content": ... }`

组完长度为 0 → 执行失败。保存期只拦**静态空**：`system_prompt`、`user_prompt` 皆缺省或空白字面量，且 `messages` 缺省 / `null` / `[]` / 空串。任一字段含 `{{` 则留给运行时（模板可能拼出内容）。`json_mode: true` 时引擎不自动往 prompt 里塞「请输出 JSON」；作者自己写，与 OpenAI 对 `json_object` 的建议一致。

**请求体（非流式示例）**

```json
{
  "model": "deepseek-chat",
  "messages": [ ... ],
  "temperature": 0.7,
  "stream": false
}
```

`json_mode` 再加 `response_format`；有 `max_tokens` 再加该字段；`stream: true` 时 `"stream": true`。不传 `user`、`n`、`tools`。

**凭证头**：复用 `inject_http_credential` 同一套规则（bearer → `Authorization: Bearer`；api_key → `header_name` 或默认 `X-API-Key`）。连接未绑凭证则不加认证头。

## 7. 输出与流式

成功输出：

```json
{
  "text": "模型回复原文",
  "json": { "order_id": "..." },
  "usage": { "prompt_tokens": 12, "completion_tokens": 40, "total_tokens": 52 },
  "model": "deepseek-chat",
  "finish_reason": "stop",
  "streamed": false
}
```

- `text`：非流式取 `choices[0].message.content`（`null` 当空串）；流式用现有 `extract_stream_text`。
- `json`：**仅当** `json_mode === true` 且 `text` 解析为 JSON 值时出现。允许对象或数组。`text` 外围 markdown 代码围栏（` ```json ... ``` `）第一期 **不** 剥，作者应靠 json_mode + prompt 拿纯 JSON；需要剥围栏留第二期。
- `usage`：供应商没返回则对象仍在、字段为 `null`。
- `model`：优先响应里的 `model`，否则用请求的 model。
- `streamed`：仅流式为 `true`；非流式可省略或 `false`。
- 不输出完整 HTTP status/headers/body、不输出组装后的 messages。

流式：

- 与 `http_call` 共用 `StreamBridge`：endpoint 触发才 `commit` 上游 status + 白名单头并推 chunk；非 endpoint 只缓冲 + 抽文本。
- 调用方断开：停写 HTTP，工作流继续跑完（与现网一致）。
- `validate_definition`：统计 `http_call.stream` + `llm.stream`，**合计 > 1 则保存失败**。错误文案改为「工作流最多只能有一个 stream: true 的 http_call 或 llm 节点」。
- `llm` 无 `async_poll`，不存在与之组合的问题。
- `stream` + `json_mode` 允许：流结束后对拼好的 `text` 做 JSON 解析。

`skip_llm` mock（dry_run 与正式跑相同）：

```json
{
  "text": "[skip_llm] mocked completion",
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "model": "<节点 model>",
  "finish_reason": "stop",
  "streamed": false
}
```

`json_mode` 时另加 `"json": {}`。不占用 StreamBridge。

## 8. 执行与错误

`exec_llm_node` 顺序：

1. 读 `connection_id` / `model` / 开关；缺字段 → 失败。
2. `fetch_active_for_tenant(pool, connection_id, tenant_id)`；无 tenant、跨租户、停用、不存在 → 失败。
3. `model` 不在 `models` → 失败。
4. 解析模板后的 prompts / messages，组装；为空或非法 → 失败。
5. `skip_llm` → 返回 mock。
6. 注入凭证，POST。超时包裹整次请求（含读 body），算法同 `http_call`。
7. HTTP 非 2xx、网络错、超时、没有 `choices` → 失败；错误信息带 status + body **截断摘要**（上限 2KiB），并走现有 env/cred 脱敏。
8. `json_mode` 且 JSON 解析失败 → 失败，消息明确「json_mode 下模型输出不是合法 JSON」。
9. 流式中途失败：结束 StreamBridge，节点失败，无 `allow_failure` 则整图停止。

`allow_failure: true`：与现网一致，下游收到 `{ error, failed, allow_failure }`。

执行记录不写入已组装的 messages、不写入 API key。节点 config 里的 prompt 模板按现有工作流定义存储（本来就可被项目成员看见）。

## 9. MCP 与 QA

- `NODE_SPEC` 节点种类改为 16；新增 `llm` 节，字段与上文一致；写明须先列出项目连接再填 `connection_id`。
- 新工具 `list_llm_connections`：返回当前项目 `{ id, connection_name, base_url, models, is_active, credential_id }`，无密钥。对标 `list_env_vars`，避免 AI 作者瞎猜 id。
- `debug_workflow` 行为：不因 dry_run 而跳过 `llm`（除非节点 `skip_llm`）。
- workflow-qa 与节点同一期交付两条规则：`llm` 缺 `connection_id` 或 `model` 为 error；prompt 字面量疑似密钥走现有 secrets 规则。不做「应用 llm 替代 http_call」的建议规则。

## 10. 测试

供应商一律 httpmock / 本地 listener，不连真实 OpenAI。

| 用例 | 期望 |
|---|---|
| 组消息：仅 system+user | 两条，顺序正确 |
| 组消息：system + messages + user | 三段拼接 |
| messages 空 / 非法 role / content 为数组 | 失败 |
| `base_url` 有无尾斜杠 | 均打到 `/chat/completions` |
| 非流式 200 | `text` / `usage` / `model` 抽出 |
| `json_mode` 合法对象 | 出现 `json` |
| `json_mode` 非 JSON | 节点失败 |
| 流式 OpenAI SSE | `text` 与 `extract_stream_text` 一致；`streamed: true` |
| 两个 `llm.stream`，或 `llm.stream` + `http_call.stream` | `validate_definition` 失败 |
| 跨租户 `connection_id` | 执行失败 |
| 模型不在列表 | 执行失败 |
| `skip_llm` | 零 HTTP，返回固定 mock |
| dry_run 且未 skip | mock 服务器收到真实 POST（证明没走 `http_call` mock） |
| 供应商 401 / 500 | 节点失败，摘要不含伪造的成功 `text` |
| 连接停用 | 执行失败 |

前端：连接 CRUD + 节点表单手工验（创建连接 → 画布选模型 → debug 看到 `text`）。无强制 Playwright 本期。

## 11. 文件边界（实现时）

| 路径 | 职责 |
|---|---|
| `migrations/067_llm_connections.sql`（号以落地时为准） | 表 |
| `src/workflow_llm.rs` | URL 拼接、组消息、请求体、响应解析、mock 输出；可单测、不碰 Axum |
| `src/llm_connection_handlers.rs` | 连接 CRUD + test/health |
| `src/workflow_engine.rs` | `NodeType::Llm`、`exec_llm_node`、流式计数校验 |
| `src/workflow_stream.rs` | 不改协议；仅被 llm 复用 |
| `src/mcp_tools.rs` | `NODE_SPEC` + `list_llm_connections` |
| `src/main.rs` | 挂路由 |
| `frontend-nextjs/app/workspace/[projectId]/events/llm-connections/page.tsx` | 连接页 |
| 工作流编辑器三件套 + `lib/api.ts` + `workspaceNav.ts` | 节点 UI / 导航 |

`workflow_engine.rs` 已很大：解析与组包必须放进 `workflow_llm.rs`，引擎只负责取连接、调客户端、写 `node_outputs`、接 StreamBridge。

## 12. 分期

| 期 | 内容 |
|---|---|
| **1（本文）** | 连接 CRUD + 探活 + `llm` 节点（含流式 / json_mode / skip_llm）+ MCP 列表 |
| **2** | 剥 markdown 围栏、模型名模板、`/models` 同步进下拉、节点内试跑台 |
| **3** | Anthropic 原生、视觉 content、会话记忆、Agent / tools |
| **以后** | 若 NL2SQL 需要，再从 `workflow_llm.rs` 抽 `LlmProvider` |
