# 工作流入参 `input_schema` — 设计文档

- 日期：2026-09-07
- 状态：待评审
- 范围：A 档（存储 + 文档生成 + JSON 编辑；不做运行时校验、不做表单面板）
- 相关代码：
  - `migrations/022_workflows.sql`、`migrations/029_workflow_versions.sql`
  - `src/workflow_handlers.rs`（`Workflow` / create / update / snapshot / restore / `build_doc_model`）
  - `src/mcp_tools.rs`（`scan_trigger_fields`、`workflow_api_doc`、create/update tool schema）
  - `frontend-nextjs/components/workflow/WorkflowDocContent.tsx`
  - `frontend-nextjs/components/workflow/WorkflowsManager.tsx`
  - `frontend-nextjs/components/workflow/WorkflowEditorHeader.tsx`

## 1. 背景与目标

接口文档靠扫描节点里的 `{{trigger.xxx}}` 推断入参。首节点是 code、直接读 HTTP body 的工作流扫不到字段，文档会写成「不依赖外部入参，传空 body」，调用方按文档传 `{}` 必然失败。

用 transform 节点「骗扫描器」会引入拓扑噪音，且 code 实际读取的字段会和声明漂移。扫描本质是猜作者意图。

**目标**：工作流顶层增加显式 `input_schema`（JSON Schema 子集）。作者声明入参；文档 / MCP / 公开分享页优先读它，零猜测。未声明时保持现有扫描，旧工作流行为不变。

### 已确认需求

1. 存独立列，不塞进 `trigger_config`。
2. 文档三处（编辑器弹窗、公开分享页、MCP `workflow_api_doc`）同一套解析：有 schema 用 schema，没有则扫描。
3. 编辑器本档只提供 JSON 文本框，不造表单。
4. 改 `input_schema` 算定义变更，写入版本快照；回滚一并恢复。

### 非目标（YAGNI）

- 不扫描 code 节点 AST（Lua / Python）。
- 不做 Endpoint 运行时 JSON Schema 校验（400）。
- 不做「入参定义」表单面板，不按 schema 生成调试表单。
- 不给已有工作流自动补 schema（例如账号密码登录需作者自行声明）。
- 不引入 `jsonschema` crate，不做完整 JSON Schema 合法性校验。
- 不从 `description` 提取入参（人工同步会漂移）。

后续（B/C 档，不在本次）：入口校验、表单编辑、调试页自动表单、SDK 类型生成。本设计把字段放对，那些消费方以后只读同一列。

## 2. 架构

```
作者声明                         文档消费
─────────                         ────────
workflows.input_schema  ──┐
  (JSONB, 可 NULL)        │     resolve_doc_inputs(schema, nodes)
                          ├────▶  input_source + input_fields[]
nodes 里 {{trigger.X}} ──┘              │
                                        ▼
                          DocModel / MCP workflow_api_doc
                          （编辑器弹窗 · 公开 /doc/:token · MCP）
```

`trigger_config` 继续只表示「怎么触发」（cron / hook / kafka / `graceful_error_response`）。入参契约是工作流级字段。

### 解析规则

| `input_schema` | 行为 |
|---|---|
| `NULL` / 未存 | `input_source = scan`，沿用 `scan_trigger_fields` / `collectTriggerFields` |
| JSON object | `input_source = schema`，**只信 schema**，不再扫节点。`properties` 为空 = 作者声明无入参 |
| 非 object（array / string / number / bool） | 保存拒绝，400 |

本档只消费这些键（其余键原样保存，文档忽略）：

- `properties.<name>.type` / `description` / `example`
- 顶层 `required: string[]`
- property 上的 `required: true`（兼容作者示例写法，视为该字段必填）
- 顶层 `oneOf` / `anyOf` 里的 `required`（文档标「条件必填」，本档不做运行时校验）

嵌套 `properties` 不展开。文档只列顶层字段，与现有扫描「`{{trigger.plan.name}}` → `plan`」一致。

## 3. 数据模型

新增 migration（编号按仓库当时最大序号 +1；与 develop 的 `062_workflow_runs_failed_index` 撞号后改挂 `063_workflow_input_schema.sql`）：

```sql
ALTER TABLE management.workflows
  ADD COLUMN IF NOT EXISTS input_schema JSONB DEFAULT NULL;

ALTER TABLE management.workflow_versions
  ADD COLUMN IF NOT EXISTS input_schema JSONB DEFAULT NULL;
```

- 默认 `NULL`：旧行、旧版本快照都走扫描，行为不变。
- 不建 GIN 索引：本档只按主键读写，不按 schema 内容查询。

### 写路径语义

**创建**

- 省略或 `null` → 存 `NULL`
- object → 原样存
- 非 object → 400：`input_schema 必须是 JSON object 或 null`

**更新**（与 `alert_webhook_url` 同类：能区分「没传」和「显式清空」）

| 请求 | 结果 |
|---|---|
| 字段缺失 | 不变（`COALESCE` / 跳过） |
| `input_schema: null` | 置 `NULL`（回到扫描） |
| `input_schema: { ... }` | 覆盖 |
| 非 object | 400 |

编辑器空文本框 → 发 `null`。

**复制**：`duplicate_workflow` 拷贝源工作流的 `input_schema`。

**导入**：批量导入若带该字段则写入，规则同创建。

### 版本快照与回滚

`input_schema` 属于定义，与 `nodes` / `edges` / `dependencies` 同等对待：

1. `snapshot_workflow_version` 写入该列。
2. 更新时若请求带了 `input_schema`（含显式 `null`），打新版本。编辑器整单保存本来就会带 nodes，也会带上当前 schema。
3. `restore_workflow_version` 从快照写回 `input_schema`。迁移前的历史行是 `NULL`，恢复它们等于清掉后来补的 schema——正确，那些版本从未声明过。

## 4. DocModel 与文档展示

`DocModel.input_fields` 从 `string[]` 改为对象数组。编辑器弹窗与公开分享页同发，不保留旧 `string[]` 形状。

```ts
type InputRequired = 'yes' | 'no' | 'conditional'

interface DocInputField {
  field: string
  type?: string          // string / number / boolean / object / array / integer …
  description?: string
  required: InputRequired
  example?: unknown
  template: string       // {{trigger.email}}
}

interface DocModel {
  // …现有字段不变…
  input_source: 'schema' | 'scan'
  input_fields: DocInputField[]
}
```

`required` 判定：

1. 字段名在顶层 `required` 里 → `yes`
2. 该 property 的 `required === true` → `yes`
3. 出现在任一 `oneOf` / `anyOf` 分支的 `required` 里，且尚未 `yes` → `conditional`
4. 否则 → `no`

### 文案

| `input_source` | 有字段 | 无字段 |
|---|---|---|
| `schema` | 「以下字段来自工作流入参定义（input_schema）。」表头：字段 / 类型 / 必填 / 说明 | 「本工作流已声明无外部入参，传空 body 即可。」 |
| `scan` | 保持现状：「来自节点中 `{{trigger.X}}` 引用（自动扫描…）」表头：字段 / 模板引用 | 保持现状：「未检测到 `{{trigger.字段}}` 引用…」 |

`conditional` 在「必填」列显示「条件必填」。扫描路径的 `type` / `description` / `example` 为空，`required` 一律 `no`（与现在「类型需按业务确认」一致，不假装能推断必填）。

### curl / sample body

对 `input_fields` 逐个取值，组成 JSON object：

1. 有 `example` → 用 example
2. 否则按 `type` 占位：`string` → `"<field>"`，`number` / `integer` → `0`，`boolean` → `false`，`object` → `{}`，`array` → `[]`，未知 → `"<field>"`
3. 必填与可选都进入示例，调用方能看见完整形状

扫描路径无 example / type，继续用 `"<field>"`（前端）或 `"示例值"`（MCP 现状可统一成 `"<field>"`，避免两套占位）。

### 实现落点

抽一个共享函数，三处调用，禁止再各写一套：

- 后端：`resolve_doc_inputs(input_schema, nodes) -> (source, fields)`<br>
  `build_doc_model` 与 `tool_workflow_api_doc` 都走它。`build_doc_model` 增加 `input_schema` 参数。
- 前端：`deriveDocModel` 从 `meta.input_schema` 走同一规则；`collectTriggerFields` 仅作 scan fallback。扫描规则仍与 `scan_trigger_fields` 对齐（空白、`_`、`-`、非 ASCII）。本档把前端 regex 补到与 Rust 一致，避免编辑器文档漏字段。

MCP `workflow_api_doc` 的 `input_fields` 改为上述对象；增加 `input_source`；`note` 区分 schema / scan。工具描述改为：优先读 `input_schema`，否则扫描 `{{trigger.X}}`。

## 5. 编辑器与 MCP

### 编辑器

`Workflow` / `WorkflowFormMeta` / `EditorDraft` / `WorkflowListItem` / `WorkflowVersionSnapshot` 增加 `input_schema`。

Header 在「用途说明」旁加 **入参定义**：多行 JSON，交互与 `trigger_config` 相同。

- 空 → 保存发 `null`
- 合法 object → 原样保存
- 非法 JSON 或非 object → 保存前拦截，提示格式错误（与 `trigger_config` 一致）

所有 `trigger_type` 都显示（hook / kafka 的 trigger 数据同样需要文档）。占位示例：

```json
{
  "type": "object",
  "properties": {
    "email": { "type": "string", "description": "邮箱（与 phone 二选一）" },
    "phone": { "type": "string", "description": "手机号（与 email 二选一）" },
    "password": { "type": "string", "description": "密码" }
  },
  "required": ["password"],
  "oneOf": [{ "required": ["email"] }, { "required": ["phone"] }]
}
```

调试页本档仍是手填 JSON，不按 schema 生成表单。

### MCP / `node_spec`

- `create_workflow` / `update_workflow` 增加可选 `input_schema`（object 或 null）。
- `update_workflow` 的 `version_note` 说明：改 `input_schema` 也会打版本。
- `node_spec` 增加一节：工作流可声明 `input_schema`；有则接口文档以它为准，节点不必再写 `{{trigger.x}}` 给扫描器用。
- TypeScript MCP（`mcp-server/`）若仍暴露 create/update，同样加上该字段，避免两套协议。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 创建/更新传入非 object | HTTP 400，中文错误信息，不写库 |
| 编辑器 JSON 解析失败 | 不发请求，alert 提示 |
| schema 缺 `properties` 但仍是 object | 合法；视为无顶层字段（声明无入参） |
| schema 含文档不认识的键（`$schema`、`additionalProperties` 等） | 原样保存，文档忽略 |
| 公开文档接口 | 继续只下发 DocModel，不下发 nodes；`input_fields` 已是提炼结果 |
| 旧客户端读到对象数组而非 `string[]` | 公开页与编辑器同发；无独立旧客户端要兼容 |

不在执行路径返回新错误：本档不改 `endpoint_trigger`。

## 7. 测试

后端单测（放在 `mcp_tools` 或与 `resolve_doc_inputs` 同模块）：

1. `NULL` schema → 结果与 `scan_trigger_fields` 相同，`input_source = scan`
2. 有 `properties` → 字段名 / type / description / example 来自 schema，忽略节点里的 `{{trigger.other}}`
3. `properties: {}` → 空列表，`input_source = schema`（不是「未检测到引用」）
4. 顶层 `required` + property `required: true` → `yes`；`oneOf.required` → `conditional`
5. sample body：有 example 用 example，否则按类型占位
6. 创建/更新拒绝非 object（handler 或校验函数单测）

前端：`deriveDocModel` 对上述 1–3 做对等用例（若现有 doc 测试文件方便加；没有则以后端单测为主，前端靠类型与手工过一遍文档弹窗）。

## 8. 风险与后续

- **契约漂移**：schema 与 code 节点实际读取仍可能不一致。本档接受，因为作者声明是唯一真实来源；B 档校验能挡住一部分错误入参，挡不住「声明了但 code 没读」。
- **DocModel 形状变更**：公开分享 JSON 不兼容旧 `input_fields: string[]`。分享页与后端同仓同发，可接受。
- B 档入口校验、C 档表单编辑都只读这一列，不必再改表结构。
