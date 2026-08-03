# 工作流与定时任务失败告警 Webhook — 设计文档

- 日期：2026-07-15
- 状态：待评审
- 相关代码：`src/workflow_handlers.rs`、`src/scheduler/runner.rs`、`src/scheduler_handlers.rs`、`src/scheduler/models.rs`、`frontend-nextjs/components/workflow/WorkflowsManager.tsx`、`frontend-nextjs/components/workflow/WorkflowEditorHeader.tsx`、`frontend-nextjs/components/ScheduledTasksManager.tsx`、`frontend-nextjs/lib/api.ts`

## 1. 背景与目标

工作流和定时任务已经会记录执行失败，但目前没有面向外部 IM/机器人 Webhook 的主动告警。用户希望在每个工作流、每个定时任务上配置一个告警 Webhook 地址，并能自定义发送消息体。常见目标 Webhook 需要固定 JSON 结构，例如：

```json
{
  "msg_type": "markdown",
  "content": "### 🚨 报警\n- **服务**: 订单服务\n- **错误率**: 12%\n- **时间**: 2026-07-15 17:00"
}
```

目标：

1. 工作流和定时任务都可配置失败告警 Webhook。
2. 只在“最终失败”时发送告警，避免重试中的临时失败刷屏。
3. 支持按小时限流：同一个工作流/定时任务在 N 小时内最多发送一次告警。
4. Webhook 消息体可配置为 JSON 模板，并支持运行时变量。
5. Webhook 发送失败不影响原始工作流/任务执行结果。

非目标：

- 不做多个 Webhook 目标；v1 每个工作流/任务一个告警 Webhook。
- 不复用租户级 `management.webhooks` 事件系统配置；那套语义是数据变更事件分发，不是某个执行对象的失败告警。
- 不做成功恢复通知、连续失败次数聚合、升级策略或告警确认。
- 不做富 UI 模板构建器；v1 使用 JSON 文本框。

## 2. 用户确认的产品语义

- 告警触发：最终失败发送。
- 限流：用户可设置“多少小时内发送一次”。语义是同一个对象（workflow 或 scheduled task）在限流窗口内最多发送一次。
- 模板：使用 JSON 模板文本，默认给出飞书/企业微信类 Markdown 消息结构，并支持 `{{variable}}` 占位符。

## 3. 数据模型

新增 migration `migrations/049_alert_webhooks.sql`，分别给 `management.workflows` 与 `management.scheduled_tasks` 增加同构列：

```sql
ALTER TABLE management.workflows
  ADD COLUMN IF NOT EXISTS alert_webhook_url TEXT,
  ADD COLUMN IF NOT EXISTS alert_webhook_template JSONB,
  ADD COLUMN IF NOT EXISTS alert_throttle_hours INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS last_alert_sent_at TIMESTAMPTZ;

ALTER TABLE management.scheduled_tasks
  ADD COLUMN IF NOT EXISTS alert_webhook_url TEXT,
  ADD COLUMN IF NOT EXISTS alert_webhook_template JSONB,
  ADD COLUMN IF NOT EXISTS alert_throttle_hours INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS last_alert_sent_at TIMESTAMPTZ;
```

约束：

- `alert_webhook_url IS NULL OR length(trim(alert_webhook_url)) > 0`
- `alert_webhook_url IS NULL OR alert_webhook_url ~ '^https?://'`
- `alert_webhook_template IS NULL OR jsonb_typeof(alert_webhook_template) = 'object'`
- `alert_throttle_hours BETWEEN 0 AND 720`

`alert_throttle_hours = 0` 表示不限流。默认 24 小时，兼顾“失败后能知道”和“不会一直刷屏”。

模板使用 `JSONB` 而不是 `TEXT`：前端仍用文本框编辑，但保存时先解析为 JSON object；后端发送前对 JSON 中所有字符串递归做变量替换。这样能保证落库内容一定是合法 JSON，也能支持嵌套字段。

## 4. 默认模板与变量

默认模板：

```json
{
  "msg_type": "markdown",
  "content": "### 🚨 报警\n- **类型**: {{source}}\n- **名称**: {{name}}\n- **状态**: {{status}}\n- **错误**: {{error}}\n- **时间**: {{time}}\n- **Run ID**: {{run_id}}"
}
```

变量：

- `{{source}}`: `workflow` 或 `scheduled_task`
- `{{name}}`: 工作流/任务名称
- `{{status}}`: `failed` 或 `timeout`
- `{{error}}`: 错误信息；没有时使用 `执行失败`
- `{{time}}`: 发送时刻，RFC3339 字符串
- `{{run_id}}`: `workflow_runs.id` 或 `scheduled_task_runs.id`
- `{{object_id}}`: `workflows.id` 或 `scheduled_tasks.id`
- `{{trigger_type}}`: 工作流触发类型或定时任务 `triggered_by`
- `{{trace_id}}`: 执行链路 trace id；没有时为空字符串

替换规则：

- 仅替换 JSON 字符串值中的 `{{name}}` 形式变量。
- 未知变量保留原样，方便用户发现拼写问题。
- 非字符串 JSON 值保持原类型不变。

## 5. 后端架构

新增模块 `src/alert_webhook.rs`，负责公共发送逻辑：

```text
AlertWebhookConfig
AlertWebhookContext
send_alert_if_allowed(pool, source, object_id, config, context)
  1. 如果 url 为空，直接返回
  2. 在 DB 里做限流 claim：last_alert_sent_at 为空 / 超过窗口 / throttle=0 才更新为 NOW()
  3. claim 成功后渲染模板
  4. 用 reqwest POST JSON
  5. 发送成功/失败只写 tracing 日志，不改变原执行状态
```

限流必须由数据库原子完成，避免多实例同时最终失败时重复发送。对每个来源分别执行：

```sql
UPDATE management.workflows
SET last_alert_sent_at = NOW()
WHERE id = $1
  AND alert_webhook_url IS NOT NULL
  AND (
    alert_throttle_hours = 0
    OR last_alert_sent_at IS NULL
    OR last_alert_sent_at < NOW() - (alert_throttle_hours * INTERVAL '1 hour')
  )
RETURNING alert_webhook_url, alert_webhook_template, alert_throttle_hours;
```

`scheduled_tasks` 同理。

Webhook HTTP 发送：

- method 固定 `POST`
- body 为渲染后的 JSON
- header 固定 `Content-Type: application/json`
- timeout 使用 5 秒默认值
- 不做重试，避免告警出口本身放大流量；后续如需要可单独加 `alert_retry_count`

## 6. 工作流接入点

`execute_workflow_internal` 已经有三个失败收口路径：

1. 整体执行超时
2. 节点执行结果中存在失败，整体状态写为 `failed`
3. engine 返回 `Err`

在这些路径中，写完 `workflow_runs`、完成 `execution_index` 后，调用 `alert_webhook::send_workflow_failure_alert(...)`。告警不阻塞返回：可直接 `tokio::spawn` 后台发送，但发送前的 DB 限流 claim 仍在模块内完成。

最终失败定义：

- 对工作流：本次 run 状态写为 `failed` 时即为最终失败。工作流当前没有自动重试链，`max_retries` 字段未在执行链里实际重试，因此无需等待额外状态。
- `WorkflowRunGuard` 的 Drop 兜底收口也会把 run 置为 failed；v1 不在 Drop 中发送告警，避免异步 Drop 场景复杂化。周期性/手动清理残留 running 也不发送告警，它们属于运维修复动作而不是一次真实执行的即时失败。

## 7. 定时任务接入点

`SchedulerRunner::execute_one` 会计算 `attempt` 并在 `compute_next_run_at` 中决定是否继续重试。定时任务的最终失败定义：

- `status` 为 `failed` 或 `timeout`
- 且 `attempt >= task.max_retries`

满足最终失败后，在 `finalize_run` 和 `update_task_after_run` 完成后发送告警。`cancelled`（overlap skip）不告警；dry-run 不落 run，也不告警；写 run 起始记录失败不告警。

注意当前 retry 语义里 `max_retries = 0` 时第一次失败即最终失败；`max_retries = 3` 时 attempt 1、2 会继续重试，attempt 3 失败后告警。

## 8. API 与前端

### 8.1 后端请求/响应

扩展已有 create/update 请求结构：

- `CreateWorkflowRequest` / `UpdateWorkflowRequest`
- `CreateTaskReq` / `UpdateTaskReq`

新增字段：

```ts
alert_webhook_url?: string | null
alert_webhook_template?: Record<string, unknown> | null
alert_throttle_hours?: number
```

列表和详情响应直接返回这些字段。`last_alert_sent_at` 可返回，用于 UI 展示“上次发送时间”，但不允许前端修改。

### 8.2 工作流 UI

在工作流编辑器 Header 的元信息区域增加“失败告警”设置：

- Webhook URL 输入框
- JSON 模板 textarea
- 限流小时数 number input，默认 24，0 表示不限流
- 简短变量说明

保存时把 JSON 模板解析为 object，解析失败则阻止保存。

### 8.3 定时任务 UI

在定时任务表单运行控制区域附近增加“失败告警 Webhook”折叠/分组：

- Webhook URL 输入框
- JSON 模板 textarea
- 限流小时数 number input
- 编辑已有任务时回填配置

`buildCreatePayload` 负责统一校验并构建 create/update payload。

## 9. 安全与可靠性

- 告警模板渲染使用已经落库的 masked error（工作流路径中已有 env 掩码），不额外读取节点输出或 secret 字段。
- 不在告警 payload 中默认包含完整 output/node_results，避免把业务数据或密钥带出系统。
- Webhook URL 仅允许 `http`/`https`。如果生产需要禁止内网或 http，可后续加全局开关；v1 与现有 HTTP 任务能力保持接近。
- 告警发送失败只记日志，不改变 run 的失败状态，也不触发重试。
- 限流 claim 先更新 `last_alert_sent_at` 再发送；如果发送失败，本窗口内不会反复重试。这是刻意选择，优先防刷屏。

## 10. 测试计划

后端单元测试：

- 模板渲染：字符串替换、嵌套 JSON、未知变量保留、非字符串值不变。
- 限流判定：未发送过、窗口外、窗口内、`alert_throttle_hours = 0`。
- 定时任务最终失败判断：`max_retries = 0` 首次失败告警；重试未耗尽不告警；最后一次失败告警。

集成/行为测试：

- 创建/更新工作流能保存告警字段并返回。
- 创建/更新定时任务能保存告警字段并返回。
- 工作流执行失败后触发一次 Webhook。
- 定时任务最终失败后触发一次 Webhook。
- 同一对象限流窗口内第二次最终失败不发送。

前端检查：

- JSON 模板非法时保存被阻止并提示。
- 编辑已有工作流/定时任务时能回填告警配置。
- `0` 小时限流文案明确表示“不限流”。
