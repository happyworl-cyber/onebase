---
name: workflow-qa
description: Reviews OneBase workflows with local rules, call_workflow parent/child contract checks, and the project's default AI Provider. Use when the user asks to 检测、审查、质量检查 a workflow, worries editing a child will break parents, or mentions review_workflow / review_workflows / 保存前预警.
---

# 工作流 AI 检测

只出报告，不改工作流。用户没说「改掉」时，禁止 `update_workflow` / `node_patch`。

## 选哪个入口

| 场景 | 调用 |
|---|---|
| 已保存、已知 `id` | MCP `review_workflow`，参数 `{ "id" }` |
| 按项目 / 部门批扫 | MCP `review_workflows`（`database_id` / `tenant_id` / `department` / `category` / `search`，`max_ai` 默认 20） |
| 编辑器里未保存的图 | `POST /api/admin/workflows/qa`，带 `nodes`、`edges`、`trigger_type`、`input_schema`、`slug`、`id`（编辑已有流时） |

保存页预检会自动跑同一套本地规则 + 调用方契约，不调用 AI Provider；有发现项仍可保存。

## 怎么跑

1. 用 `list_workflows` / `get_workflow` 确认 `id`、权限范围内。
2. 调 `review_workflow` 或 `review_workflows`，等完整 JSON，不要自己扫 `nodes` 重写规则。
3. 按 `rules` + `ai_findings` 汇报。`ai_status=skipped` 表示项目未配置可用的 AI Provider，规则结果仍有效。
4. 不要根据发现项自动改流。

## 读结果

严重度：`crit` > `high` > `med` > `low`。先讲会跑挂或密钥的，再讲规范。

跨工作流（改子流影响父流）：

| code | 含义 |
|---|---|
| `caller.missing_required_input` | 父流 `call_workflow.input` 缺了本流必填入参 |
| `caller.unknown_output_field` | 父流还在读本流 `response.body` 里已经没有的字段 |
| `caller.slug_changed` | 本流改了 slug，父节点仍指向旧名 |
| `call_workflow.missing_required_input` | 本流去调子流时少传了字段 |
| `call_workflow.unknown_output_field` | 本流引用了子流不存在的输出 |
| `call_workflow.target_missing` / `target_disabled` | 子流不存在或未启用 |

`input` 若是整段模板（如 `{{upstream}}`）不会报缺字段，静态看不出来。

其它常见规则：`hardcoded_secret`、`empty_code`、`isolated_node`、`endpoint_no_response`、`noop_b64_roundtrip`、`manual_object_storage`、`huge_code`、`style.*`。

## 汇报格式

- 一句话结论（能否安全改 / 有几条会打断调用方）
- 按严重度列发现项：`code`、标题、涉及节点或父流 slug、建议（只建议，不落盘）
- 批扫用 `summary`（`scanned` / `rules_hit` / `sent_to_ai`），只展开有问题的项

## 新能力

同类助手能力不要改本文件。在 `skills/<name>/SKILL.md` 新增，并在 `src/ai_skills.rs` 的 `BUNDLED` 注册。
