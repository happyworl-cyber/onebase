# 定时任务直接调用工作流 — 设计文档

- 日期：2026-08-31
- 状态：草案
- 相关代码：
  - `src/scheduler/runner.rs`、`src/scheduler/executors.rs`、`src/scheduler/models.rs`
  - `src/scheduler_handlers.rs`
  - `src/workflow_handlers.rs`（`execute_workflow_internal`）
  - `frontend-nextjs/components/ScheduledTasksManager.tsx`
  - `migrations/014_scheduled_tasks.sql`（kind 约束，后续 migration 扩展）

## 1. 背景与目标

项目「定时任务」只有 HTTP / RPC / Shell。要跑工作流只能手填 URL 打接口（鉴权、HTTPS、超时各管各的）。工作流自己另有 `trigger_type=cron`，和本功能独立。

**目标**：定时任务新增 `kind=workflow`，在本项目下拉选择已启用工作流，可选 JSON 入参，调度器进程内调用 `execute_workflow_internal`，不再走 HTTP。

### 已确认需求

1. 新类型，不是 HTTP 快捷填 URL。
2. 下拉：本项目全部**已启用**工作流（不限 `trigger_type`）。
3. 可选 JSON 入参，作为 `trigger_data`。
4. 工作流自带 cron 不改。
5. 平台级（`tenant_id` 为空）不提供该类型。

### 非目标（YAGNI）

- 不改工作流 `trigger_type=cron`。
- 平台级无租户任务不能选工作流。
- 不做从任务页跳进画布调试。
- 不把任务超时和工作流 `timeout_ms` 合成一个字段。
- 不新增权限点。

## 2. 关键决定

| 决定 | 选择 | 理由 |
|------|------|------|
| 执行 | `execute_workflow_internal(..., "scheduler", ...)` | 与 hook/cron 同路，无 URL/鉴权 |
| 引用 | `workflow_id` 必填 + `workflow_slug` 冗余 | id 精确；slug 便于展示/排查 |
| 入参 | JSON 对象，可 `{}` | 对齐现 HTTP body |
| 身份 | `user_id = task.created_by` | 与 RPC 任务一致 |
| 重叠 | 只看本任务的 `scheduled_task_runs` | 与现 HTTP 任务相同 |
| 平台 | 无 `tenant_id` 则禁止 kind=workflow | 无法圈定项目工作流 |

## 3. 架构

```
ScheduledTasksManager  kind=workflow
        │  workflow_id, workflow_input
        ▼
POST /api/admin/scheduled-tasks
        │  校验 tenant + 工作流启用
        ▼
management.scheduled_tasks
        │
SchedulerRunner.execute_one
        │  kind == "workflow"
        ▼
WorkflowExecutor
        │  再查 Workflow（租户一致、is_enabled）
        │  trigger_data = workflow_input ∪ { fired_at }
        ▼
execute_workflow_internal(pool, wf, "scheduler", data, created_by, ApiKeyWriteGuard::Off)
        │
        ├─ workflow_runs
        └─ scheduled_task_runs.output = { workflow_run_id, status }
```

`WorkflowExecutor` 放在 `src/scheduler/executors.rs`（或同目录新文件），由 `runner.rs` 与 rpc/http/shell 并列 dispatch。`SchedulerRunner` 需能拿到 `PgPool`（已有）并调用 `execute_workflow_internal`。

## 4. Schema

下一号 migration（当前最高业务号为 060，实现时取下一个未占用号）：

- `kind` CHECK 增加 `'workflow'`
- 列：
  - `workflow_id INTEGER REFERENCES management.workflows(id) ON DELETE SET NULL`
  - `workflow_slug VARCHAR(200)`
  - `workflow_input JSONB`
- CHECK：`kind='workflow'` 时 `tenant_id IS NOT NULL` 且 `workflow_id IS NOT NULL`
- 工作流删除后 `workflow_id` 变 NULL，下次执行失败并写明「工作流已删除」

## 5. API 与校验

创建/更新（`scheduler_handlers.rs`）：

- `kind` 允许 `workflow`
- `kind` 创建后仍不可改
- `workflow`：`tenant_id` 必填；`workflow_id` 属于该 `tenant_id` 且 `is_enabled=true`；写入 `workflow_slug`（从行拷贝）
- `workflow_input`：缺省 `{}`；必须是 JSON object，否则 400
- 平台创建（`tenant_id` 空）若 kind=workflow → 400

dry-run：加载工作流，确认存在且启用，不跑 DAG。

立即执行：与 cron 同一 `WorkflowExecutor`，`triggered_by=manual`。

列表/详情 JSON 带上 `workflow_id` / `workflow_slug` / `workflow_input`。

## 6. 执行语义

1. 加载 `Workflow`；缺失、跨租户、`!is_enabled` → 本次 run `failed`，不改任务 `is_active`。
2. `trigger_data`：以 `workflow_input` 为对象浅合并 `fired_at`（RFC3339 UTC）。用户若也传了 `fired_at`，以调度写入的为准。
3. `execute_workflow_internal` 失败/超时：映射到任务 run 的 `failed` / `timeout`；`error_message` 带引擎错误。
4. 成功：`output = { "workflow_run_id": <id>, "status": "success" }`（run id 从刚插入的 `workflow_runs` 读取；若内部 API 暂不返回 id，executor 按 `workflow_id + trace/时间` 查最新一条）。
5. 外层 `tokio::timeout(task.timeout_secs)` 保留；工作流 `timeout_ms` 仍在引擎内生效。
6. `overlap_policy=skip`：仅当本任务已有 `running` 的 `scheduled_task_runs` 时跳过。

`ApiKeyWriteGuard::Off`：调度触发不是 API key 调用。

## 7. 前端

`ScheduledTasksManager`：

- 项目页（`lockedTenantId` 有值）kind 增加「工作流」
- 平台页未选租户：不出现该选项
- 下拉：现有工作流列表 API，过滤 `is_enabled` 且 `tenant_id` 匹配；展示 `name (slug)`
- 入参用现有 JSON 编辑控件（`CodeSnippetEditor` language=json，若该页已引入；否则保持与 HTTP body 同一套 textarea/编辑器）
- 切换 kind 时清空对方字段（与现网一致）
- 列表 kind 文案：「工作流」；详情显示 slug

`lib/api.ts`：`ScheduledTask` / create input 增加三个字段。

## 8. 测试

1. 项目任务 kind=workflow，选启用工作流，入参 `{"x":1}`，立即执行：`workflow_runs.trigger_type=scheduler`，`trigger_data` 含 `x` 与 `fired_at`。
2. `scheduled_task_runs.output.workflow_run_id` 能对上该 run。
3. 禁用工作流后再立即执行：任务 failed，原因含未启用。
4. HTTP / RPC 创建与执行不变。
5. 平台页不选租户：无「工作流」选项；API 对 `tenant_id=null` + kind=workflow 返回 400。
6. dry-run 在工作流启用时通过，不产生 `workflow_runs`。
