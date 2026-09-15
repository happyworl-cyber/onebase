# 工作流草稿 / 发布 — 设计文档

- 日期：2026-09-14
- 状态：已通过
- 范围：保存与运行时解耦。保存只写草稿；线上继续跑已发布定义；显式发布后本次修改才生效。启用/禁用仍只控制流量。
- 相关代码：
  - `migrations/022_workflows.sql`、`migrations/029_workflow_versions.sql`
  - `src/workflow_handlers.rs`、`src/workflow_engine.rs`、`src/workflow_trigger.rs`、`src/workflow_cron_trigger.rs`、`src/workflow_kafka_trigger.rs`、`src/workflow_notify_trigger.rs`、`src/scheduler_workflow.rs`、`src/sse.rs`
  - `src/mcp_tools.rs`、`mcp-server/src/index.ts`
  - `frontend-nextjs/components/workflow/WorkflowsManager.tsx`、`WorkflowEditorHeader.tsx`、`list/`
- 关联：`docs/superpowers/specs/2026-08-20-workflow-version-browser-design.md`

## 1. 背景与目标

今天编辑器一点「保存」就覆盖 `management.workflows` 的 nodes/edges。运行时（HTTP / cron / kafka / notify / `call_workflow`）立刻用新图。`is_enabled` 只负责开/关流量。`workflow_versions` 是每次保存的审计快照，不能让线上继续跑旧版。

作者改完经常不确定对不对，但保存已经生效。需要：不发布就还用原版本；只有发布了，本次修改才进入运行时。

### 已确认需求

| 项 | 结论 |
|---|---|
| 保存未发布时线上流量 | 继续跑上一版已发布定义（工作流若已启用则保持在线） |
| 新建 | 从未发布过则不能被调用；启用开关也调不起来 |
| MCP | `create` / `update` 只写草稿；新增 `publish_workflow` |
| 丢弃草稿 | 已发布的回到线上版；从未发布的删草稿后画布为空，主表 name/slug 仍保留 |
| 落库 | `workflows` 继续当线上版；草稿单独存 |

### 非目标

- 草稿 diff、审批流、定时发布、多草稿分支
- 按「未发布」做列表筛选
- 第三种 `is_enabled` 状态（草稿不是停用）
- 改公开文档分享、告警 webhook、租户/库绑定的即时语义

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 线上读哪 | 仍读 `management.workflows` | 触发器多，漏改一处时草稿不会进运行时 |
| 运行时闸门 | `is_enabled AND published_version IS NOT NULL` | 未发布与未启用对外同一 404 |
| 版本快照时机 | 只在发布时写入 `workflow_versions` | 历史 = 曾上线过的定义，不再每次保存刷一版 |
| 恢复历史版 | 写入草稿，必须再发布才上线 | 与「保存不影响线上」一致 |
| 依赖安装 | 发布成功后对线上定义安装 npm/pip | 草稿保存不装，避免未上线包污染 |
| `version_note` | 挂在发布上（草稿可暂存） | 备注对应一次上线，不是一次保存 |

## 3. 数据模型

### 3.1 主表

`management.workflows` 增加可空列：

```sql
ALTER TABLE management.workflows
  ADD COLUMN published_version INTEGER;
```

- `NULL`：从未发布，任何触发都当不存在
- 有值：线上正在跑的版本号，对应 `workflow_versions.version`

未发布行的 `nodes` / `edges` 保持空数组（`'[]'`），完整定义只在草稿。`name` / `slug` 仍写在主表以占唯一约束 `(database_id, slug)`。

### 3.2 草稿表

`management.workflow_drafts`，与工作流 1:1（`workflow_id` 主键，`ON DELETE CASCADE`）。

覆盖字段与今天编辑器保存会进版本快照的一致：

- `name`, `slug`, `description`, `category`, `department`
- `trigger_type`, `trigger_config`, `input_schema`
- `nodes`, `edges`, `dependencies`
- `timeout_ms`, `max_retries`
- `note`（待发布的版本备注，可空）
- `updated_by`, `updated_at`

**不进草稿**（仍直接改主表、立刻生效）：`is_enabled`、`tenant_id` / `database_id`、告警 webhook、文档分享。

列表「移动分类」仍直接改主表 `department` / `category`；若已有草稿则同步这两列，避免打开编辑器被旧分类盖回去。

### 3.3 已有数据

迁移时把当前主表定义视为已发布：

1. 没有 `workflow_versions` 行的，按当前主表补一条快照（note：`迁移标记已发布`）
2. `published_version = MAX(version)`
3. 不创建草稿

现网请求行为不变。

### 3.4 Slug

线上 URL 与 `call_workflow` 解析主表 slug。草稿改 slug 要等发布才换地址。保存草稿时对草稿 slug 做唯一性校验（相对其它工作流的主表 slug 与其它草稿 slug），冲突 409，不必等到发布。

## 4. 行为

```
编辑器 / MCP
  保存/update  → upsert workflow_drafts（不改线上、不打版本）
  发布         → 草稿拷进 workflows → 打版本 → published_version=新版本 → 删草稿
  丢弃         → DELETE 草稿；编辑器重新加载主表

运行时
  只读 workflows WHERE is_enabled AND published_version IS NOT NULL
```

| 操作 | 结果 |
|---|---|
| 新建 | 插入主表（`published_version=NULL`，nodes/edges=`[]`）+ 草稿；`is_enabled` 默认 true |
| 保存 | upsert 草稿 |
| 发布 | 见上；无草稿则 409 |
| 丢弃 | 删草稿。已发布的编辑器回到主表定义。从未发布的：主表 `name`/`slug` 保留，`nodes`/`edges` 仍为空，不会凭空出现线上版；此时发布返回 409 |
| 恢复 vN | 把该快照写入草稿（可覆盖已有草稿），不上线 |
| 复制 | 新工作流未发布；拷源的编辑稿（有草稿用草稿）；`is_enabled=false` 与现网一致 |
| 批量导入（新建或覆盖） | 写入草稿，不发布、不替换线上 |
| 删除工作流 | 草稿级联删除 |

发布与保存并发：发布在同一事务内拷贝 + 打版本 + 删草稿；失败整单回滚。发布以当时库中草稿为准。

DAG 校验：保存草稿与发布都校验；发布失败不改线上、不删草稿。

## 5. API

权限与现有 update 相同。

### 5.1 读：编辑稿叠草稿

`GET /api/admin/workflows/:id` 与列表项增加：

- `published_version`: `number | null`
- `has_unpublished`: `boolean`

有草稿时，返回体里的定义字段（`name/slug/nodes/edges/...`）是草稿；不再另拆 `published` 对象。编辑器加载逻辑基本不变。

`workflow_api_doc`：已发布则按**线上**定义出文档；从未发布则标明「尚未发布，无线上接口」，文档按草稿生成供预览。

### 5.2 写

| 接口 | 行为 |
|---|---|
| `POST /api/admin/workflows` | 主表未发布 + 草稿 |
| `PATCH /api/admin/workflows/:id` 定义字段 | 只 upsert 草稿。`node_patch` 相对当前编辑稿（草稿优先）合并 |
| `PATCH` 仅 `is_enabled` / 库绑定 / 告警 / 文档分享 | 仍直接改主表 |
| `POST /api/admin/workflows/:id/publish` | body 可选 `{ "version_note": "..." }`，缺省用草稿 `note` |
| `POST /api/admin/workflows/:id/discard-draft` | 删草稿 |
| `POST /:id/versions/:version/restore` | 写入草稿，不改 `published_version`，不立刻打新版本（发布时再打，备注可写「恢复自 vN」） |

### 5.3 错误

| 情况 | 响应 |
|---|---|
| 发布但无草稿 | 409 没有未发布的修改 |
| 从未发布且无草稿就发布 | 409 没有可发布的定义 |
| 丢弃但无草稿 | 409 没有可丢弃的草稿 |
| 草稿 slug 冲突 | 409（保存时） |
| 发布 DAG 校验失败 | 400，线上不动、草稿保留 |
| 对外触发未发布/未启用 | 404「不存在或未启用」（不泄露草稿） |
| 管理端手动触发未发布 | 409 尚未发布 |

## 6. MCP

- `create_workflow` / `update_workflow`：只写草稿。文案去掉「创建即启用 / 更新即生效」。`update` 仍不碰 `is_enabled`。
- 新增 `publish_workflow`：`id`，可选 `version_note`。
- 新增 `discard_workflow_draft`：`id`。
- `get_workflow` / `list_workflows`：带 `has_unpublished`、`published_version`；定义字段为编辑稿。
- `debug_workflow`：不变，继续跑传入定义，不必先发布。
- 工作台技能说明改为：`node_spec` → `create_workflow`（创建即草稿）→ `debug_workflow`（默认干跑）→ `publish_workflow` → `workflow_api_doc`。已启用工作流的启停仍由人在页面操作。

独立 `mcp-server` 同步封装新 HTTP。

## 7. 编辑器与列表

顶栏「保存」语义改为只存草稿。同一组按钮增加：

- **发布**（主按钮）：把当前画布变成线上版。若画布有未点保存的改动，先写入草稿再发布。从未发布或 `has_unpublished` 时可点；已与线上一致则禁用，文案「已发布」。
- **丢弃草稿**：仅 `has_unpublished` 时出现。已发布的确认后回到线上定义；从未发布的确认后画布为空（名称仍在）。

备注输入框改挂发布（写入版本历史）。

徽章：

- 从未发布：「未发布」（启用也调不起来）
- 已发布且有草稿：「有未发布修改」
- 已发布且无草稿：不额外徽章，沿用启用/禁用

启用开关仍只改 `is_enabled`。从未发布时打开开关，旁注「发布后才会接收请求」。端点路径展示**线上 slug**；草稿改了 slug 时加「发布后地址变为 …」。

调试、规范预检、保存前 QA 仍针对当前画布，不必先发布。发布若先写入脏画布，走与保存相同的 QA；已存草稿直接发布不再跑一遍。

版本历史只列出已发布快照。恢复确认文案改为「恢复到草稿，不会立刻上线」。

列表名称旁小徽章「未发布」或「有修改」。筛选仍是全部/启用/禁用。行菜单在有草稿时提供「发布 / 丢弃草稿」。

公开文档分享仍绑线上定义。

## 8. 运行时改动面

所有按 slug/`is_enabled` 加载可执行工作流的查询，加上 `published_version IS NOT NULL`。至少：

- `workflow_trigger.rs`（endpoint / hook）
- `workflow_cron_trigger.rs`
- `workflow_kafka_trigger.rs`
- `workflow_notify_trigger.rs`
- `workflow_engine.rs` 的 `call_workflow`
- `scheduler_workflow.rs` / `scheduler_handlers.rs`
- `sse.rs` 中按启用工作流扫 slug 的查询

抽一个共用条件或辅助函数，避免漏改。子工作流只解析已发布且启用的目标；子流程上的草稿不影响父流程。

## 9. 测试

最小集（后端集成测试优先，前端手测顶栏/列表徽章）：

1. 保存草稿后，endpoint / cron / `call_workflow` 仍跑旧版。
2. 发布后新定义生效，`published_version` 前进，草稿行消失。
3. 新建未发布：`is_enabled=true` 时对外仍 404。
4. 丢弃草稿后 GET 回到线上定义。
5. 恢复历史版只进草稿；发布后才上线并追加新版本。
6. MCP：`create`/`update` 不发布；`publish_workflow` 后可调；`debug` 不依赖发布。
7. 迁移：旧行有 `published_version`，现网请求不变。
8. 草稿 slug 冲突在保存时 409。
9. 发布校验失败则线上不变、草稿仍在。

## 10. 文件地图（实现时）

| 路径 | 职责 |
|---|---|
| 新 migration（下一号） | `published_version`、`workflow_drafts`、回填已有数据 |
| `src/workflow_handlers.rs` | 叠草稿的 GET/列表、PATCH 改写草稿、publish/discard、restore 改草稿、create 拆主表+草稿 |
| 各 trigger / engine / scheduler / sse | 运行时闸门 |
| `src/mcp_tools.rs` | 工具描述 + `publish_workflow` / `discard_workflow_draft` |
| `mcp-server/src/index.ts` | HTTP 封装 |
| `WorkflowEditorHeader.tsx` / `WorkflowsManager.tsx` | 保存/发布/丢弃、徽章、备注 |
| `list/WorkflowRow.tsx` 等 | 列表徽章与行菜单 |
| `list/types.ts` / `lib/api.ts` | `has_unpublished`、`published_version` |
