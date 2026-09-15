# 工作流列表「最近修改人」— 设计文档

- 日期：2026-09-15
- 状态：已通过
- 范围：列表增加「最近修改人」列，并按该人做下拉筛选。作者（创建人）列与现有「作者」筛选保持不变。
- 相关代码：
  - `migrations/022_workflows.sql`、`src/migrate.rs`、`src/bin/migrate_workflow.rs`
  - `src/workflow_handlers.rs`（`Workflow`、`list_workflows`、`publish_workflow`、创建/导入/复制 INSERT）
  - `src/workflow_draft.rs`（`upsert_draft`）
  - `frontend-nextjs/components/workflow/list/`（`types.ts`、`listApi.ts`、`WorkflowListToolbar.tsx`、`WorkflowListHeader.tsx`、`WorkflowRow.tsx`、`constants.ts`、`WorkflowListView.tsx`）
- 关联：`docs/superpowers/specs/2026-09-14-workflow-draft-publish-design.md`

## 1. 背景与目标

列表「作者」列和「作者」下拉都绑定 `workflows.created_by`（创建人）。`updated_at` 会因启停、移动分类等元信息改动而变化，主表没有「谁最后改过定义」。用户要看最近谁在维护，并筛出某人最近动过的流。

草稿表已有 `workflow_drafts.updated_by`，版本表有 `workflow_versions.created_by`（发布人），主表没有对应列，列表无法高效筛选。

### 已确认需求

| 项 | 结论 |
|---|---|
| 列布局 | 保留「作者」（创建人），旁边新增「最近修改人」 |
| 查询方式 | 工具栏下拉筛选（对齐现有「作者」），不把人名并进顶部搜索框 |
| 何谓修改 | 最后一次保存草稿或发布的人 |
| 不算修改 | 启停、移动文件夹/分类、只改告警、丢弃草稿 |
| 两人同名列 | 作者与最近修改人相同也两列都显示，不合并 |

### 非目标

- 顶部搜索框匹配用户名。
- 改 MCP 工具参数（`list_workflows` 已走同一 handler，JSON 多字段即可）。
- 操作日志新文案、审计事件新类型。
- 按最近修改人排序（已有按 `updated_at` 排序）。
- 显示邮箱；列上 `title` 可挂邮箱，与作者列一致。

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 落库 | 主表加 `updated_by` | 分页、COUNT、下拉 DISTINCT 都只需一次 JOIN，与 env_vars / datasources 一致 |
| 写入口 | `upsert_draft` 同步写主表；`publish` 的 UPDATE 显式写 | 保存/导入/复制/恢复都走 `upsert_draft`；发布不走它 |
| 查询参数 | `updater` = 用户名（含「未知」） | 对齐现有 `author`（用户名）而不是用户 id |
| 下拉数据 | `include_updaters=1` 返回当前筛选范围内 DISTINCT 用户名 | 对齐 `include_authors` |
| 丢弃草稿 | 不改 `workflows.updated_by` | 丢弃不是保存/发布；那人已经维护过 |

## 3. 数据模型

### 3.1 主表

新迁移 `migrations/069_workflow_updated_by.sql`，并挂进 `src/migrate.rs`。与 develop 的 `068 llm connections` 并行时曾占用 068，合并后改挂 069。`022_workflows.sql` 与 `src/bin/migrate_workflow.rs` 的建表语句同步加列，保证全新库一致。

```sql
ALTER TABLE management.workflows
  ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workflows_updated_by
  ON management.workflows(updated_by);
```

`Workflow` 增加：

- `updated_by: Option<i32>`（表列，`SELECT *` 带出）
- `updated_by_name` / `updated_by_email`：仅列表 JOIN `users` 填充，`#[sqlx(default)]`

### 3.2 存量回填

迁移内一次性：

```sql
UPDATE management.workflows w
SET updated_by = COALESCE(
  (SELECT d.updated_by FROM management.workflow_drafts d WHERE d.workflow_id = w.id),
  (SELECT v.created_by FROM management.workflow_versions v
    WHERE v.workflow_id = w.id ORDER BY v.version DESC LIMIT 1),
  w.created_by
)
WHERE w.updated_by IS NULL;
```

优先级：当前草稿维护人 → 最新已发布版本的发布人 → 创建人。从未被他人改过的流，最近修改人 = 作者。

### 3.3 写入规则

| 操作 | `workflows.updated_by` |
|---|---|
| 创建（含 MCP create） | 当前用户（INSERT 或紧随的 `upsert_draft`） |
| 保存定义草稿（PATCH 含 nodes/name/slug 等） | 当前用户（`upsert_draft`） |
| 导入新建 / 覆盖 / 复制 | 当前用户（`upsert_draft`） |
| 恢复历史版本到草稿 | 当前用户（`upsert_draft`） |
| 发布 | 当前用户（publish 的 `UPDATE ... SET` 加上 `updated_by`） |
| 只改分类 / 批量移动 | 不变 |
| 启停、改告警、改 `database_id` | 不变 |
| 丢弃草稿 | 不变 |

实现约束：

1. `upsert_draft` 在写完草稿后，若 `draft.updated_by` 为 `Some(id)`，再执行<br>
   `UPDATE management.workflows SET updated_by = $1 WHERE id = $2`。<br>
   为 `None` 时不把主表列清空。
2. 分类-only 的 `UPDATE workflow_drafts SET category/department` **不得**改 `drafts.updated_by`，也不得走完整 `upsert_draft`（现状已是针对性 UPDATE，保持）。
3. `publish_workflow` 把草稿拷到主表的那条 `UPDATE` 必须带 `updated_by = claims.sub`。不在发布路径调用 `upsert_draft`，因此不能指望草稿钩子。
4. 主表 `updated_at` 触发器照旧；本功能不改变「何时碰 `updated_at`」，只保证启停等操作不改 `updated_by`。

## 4. 列表 API

`GET /api/admin/workflows` 保持现有权限 scope。

### 4.1 查询 SQL

现有：

```sql
SELECT w.*, cu.username AS created_by_name, cu.email AS created_by_email
FROM management.workflows w
LEFT JOIN users cu ON cu.id = w.created_by
```

改为再 JOIN 一次：

```sql
LEFT JOIN users uu ON uu.id = w.updated_by
```

SELECT 增加 `uu.username AS updated_by_name, uu.email AS updated_by_email`。

所有走 `push_list_filters` 的语句（COUNT、列表、`include_authors`、`include_updaters`）都必须 JOIN `cu` 与 `uu`。只筛作者时也要有 `uu`，只筛最近修改人时也要有 `cu`，否则缺别名。

### 4.2 新参数

| 参数 | 含义 |
|---|---|
| `updater` | 按最近修改人用户名精确匹配。值为 `未知` 时匹配 `uu.username IS NULL` |
| `include_updaters` | `1` 时额外返回 `updaters: string[]`（当前 scope + 已应用筛选项下的 DISTINCT `COALESCE(uu.username, '未知')`，按名排序） |

`author` / `include_authors` 行为不变。`search` 仍只匹配 ID / 名称 / slug / 描述 / 部门 / 分类，不匹配用户名。

`push_list_filters` 在 `author` 之后增加对称的 `updater` 条件。作者筛与最近修改人筛可同时生效（AND）。

列表响应每条工作流多三个字段：`updated_by`、`updated_by_name`、`updated_by_email`。缺用户时 name 为 `null`，前端显示「未知」。

## 5. 前端

### 5.1 状态与请求

`WorkflowListPageState` 增加 `updater: string | null`（默认 `null`）。重置筛选时与 `author` 一起清掉。

`WorkflowListItem` 增加 `updated_by` / `updated_by_name` / `updated_by_email`。

`buildListQueryParams`：有 `updater` 则带 `updater=`；每次列表请求带 `include_updaters=1`（可与现有 `include_authors=1` 并行）。

### 5.2 工具栏

「作者」下拉右侧增加「最近修改人」下拉：交互、内嵌搜人名、清空按钮、空态「无匹配」均复用作者下拉模式。未选时按钮文案「最近修改人」；选中后显示该用户名。

「清空筛选」把 `updater` 一并清掉。激活筛选判断包含 `!!state.updater`。

### 5.3 紧凑列表与卡片

表头在「作者」与「更新时间」之间加「最近修改人」。`COMPACT_LIST_GRID_CLASS` 在 `md` 增加一列，宽度与作者列同级（约 `minmax(0,5rem)`）；必要时略缩作者列，避免操作列被挤。`hidden md:flex` 与作者列同一断点。

行单元格显示 `updated_by_name || '未知'`，`title` 优先邮箱。卡片底部现为 `节点 · 作者 · 相对时间`，改为 `节点 · 作者 · 最近修改人 · 相对时间`。

## 6. 测试

- 迁移回填：有草稿用草稿人；无草稿有版本用最新版本发布人；否则用创建人。
- `upsert_draft` 把 `updated_by` 写到主表；`updated_by = None` 不把已有值清空。
- 保存定义后列表 `updated_by_name` 为保存者；只 PATCH `is_enabled` 或 taxonomy-only 后不变。
- 发布后为发布者（即使草稿是别人保存的）。
- `GET ...&updater=<username>` 只返回该人维护的流；`updater=未知` 返回无用户的行。
- `include_updaters=1` 返回去重排序后的名单。
- 前端：筛选项出现在 query；两列都渲染；同名不合并。

## 7. 错误与边界

- 用户被删：`ON DELETE SET NULL`，列表显示「未知」，可被 `updater=未知` 筛到。
- MCP / API Key 创建或保存：沿用现有 Claims 映射（Key 创建者），`updated_by` 与 `created_by` 同一套身份。
- 从未发布且草稿人缺失：回填落到 `created_by`。
- 并发保存：以最后成功写入草稿或发布的请求为准，不加锁。
