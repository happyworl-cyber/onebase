# Session Rules（项目级 RPC 会话钩子规则）能力设计

> 状态：design 待 user review（2026-05-27，合并 dev_lua_plugins 分支后第 2 次修订）。
>
> 上游背景：当前 `src/session_hooks.rs` 已落地 API Key 级声明式 hook（仅写在 `api_keys.permissions` JSON 里，无 UI）；shirehub 项目验证可用。本设计把它**升级**为项目级显式资源，带 CRUD UI，是 v1 阶段。
>
> 显式不做：Lua / 脚本钩子。**注意**：这次合并已经把另一条产品线"DAG 工作流引擎 + Lua 沙盒"落地（`src/workflow_engine.rs` + `workflow_handlers.rs` + `workflow_trigger.rs` + `lua_engine.rs`），覆盖**异步**触发场景（hook on Auto API CRUD 事件、HTTP endpoint trigger、manual、cron）。session_rules 与之**显式不重叠**——边界见 §1.3。

## 1. 目标与非目标

### 1.1 目标

把"上游可信网关 → onebase RPC session GUC 注入"的规则提升为一等公民：

- **声明式**：JSON 形态规则，无脚本，无沙盒成本。
- **项目级**：规则绑定到 `tenant_databases.id`，同项目下所有 API Key 共享。
- **UI 化**：在 workspace 的项目工作区里"会话规则"二级菜单可视化管理。
- **可审计**：任何 CRUD 写一条 audit log，含 before/after JSON snapshot。
- **向后兼容**：现存 `api_keys.permissions.session_hooks` 不破坏，作为细粒度覆盖保留。

### 1.2 非目标

| 不做 | 替代/理由 |
|---|---|
| Lua / 任何脚本钩子 | 已由 workflow 引擎覆盖（异步场景）；session_rules 保持声明式 |
| Auto API CRUD 生命周期钩子 | 已由 workflow `trigger_type='hook'` 覆盖（异步）；session_rules 不接 Auto API |
| Auto API 请求级 GUC 注入 | v1 只覆盖 RPC inject；Auto API 走另一条 `auto_api_handlers::inject_session_user_id`，v2 看需求再统一 |
| JWT 主体也走规则 | JWT 已是可信用户身份；header-driven GUC 覆盖只对 API Key 这一类"网关投喂"链路有意义 |
| 规则版本号 / 回滚 | audit_logs 里 before/after snapshot 已足够，需要回滚就基于 audit 手动 PATCH |
| 规则 dry-run / 模拟测试 | 工程量大，v1 用真实 curl + RPC 日志即可定位；v2 加 |
| 规则模板 / 跨项目复制 | UI 上加一个"复制到其它项目"按钮即可，v2 视需求加 |
| 平台级（跨租户）规则 | 鉴权语义复杂，且当前业务也不需要 |
| 非 `app.*` 命名空间的 GUC | 安全护栏，避免误写 PG 内置 GUC |
| 复用 workflow 的 audit / runs 表 | session_rules 执行是高频低危，不入 runs 表；规则 CRUD 走通用 audit_logs |

### 1.3 与已有 workflow 引擎的分工（关键决策）

合并 `origin/dev_lua_plugins` 后，仓库已存在 DAG workflow 引擎。session_rules **不**复用它，原因：

| 维度 | session_rules | workflow |
|---|---|---|
| 触发时机 | RPC 请求 enter，inject GUC 之前（**同步**，在 hot path 上） | data change event 后 / HTTP slug endpoint / manual / cron（**异步**） |
| 执行体 | 声明式 JSON（header → GUC 映射） | DAG + 7 类节点（含 Lua Code 节点） |
| 失败影响 | 阻塞当次 RPC 请求 | 不影响业务请求（spawn 异步任务） |
| 性能上限 | < 1ms（在 hot path 上） | 100ms 量级可接受 |
| 安全模型 | 服务端可信数据；GUC 名走 `^app\.` 白名单 | mlua 沙盒 + 网络黑名单 |

**何时选 session_rules**：需要在 RPC 调用进入 PG 之前把"请求级身份/项目列表"投喂给 `current_setting('app.*')`，业务函数同事务内立刻读用。

**何时选 workflow**：数据变更后做后续动作（通知 / 联动外部系统 / 复杂数据 ETL），或通过专属 slug URL 暴露一个可编程端点。

把 session_rules 折进 workflow 等价于"每个 RPC 请求 enter 时同步跑一段 Lua"——延迟 / 失败面 / 安全模型全部劣化，已被否决。

## 2. 关键决定

| 决定 | 取值 | 理由 |
|---|---|---|
| 触发面 | 仅 **RPC** session inject | v2 再覆盖 Auto API；不引入兼容性面 |
| 绑定层级 | **仅 project**（`tenant_databases.id`） | 与"按项目设置"诉求一致；UI 最简 |
| 主体范围 | 仅 **API Key** 主体 | JWT 已可信，覆盖语义错乱；headers 投喂仅对网关链路有意义 |
| 规则类型 | 仅 **header → PG GUC** | 复用 `session_hooks::SessionHook` 已有类型 |
| 多规则合并顺序 | 按 `id` 升序合并，同 GUC 写后者覆盖前者 | 简单、可预测；UI 列表也以 id 排序 |
| 与 api_key 级 hooks 关系 | **api_key > project**（细覆盖粗） | 现存 shirehub key 不影响；project 提供项目默认 |
| 审计 | 规则 CRUD 写 audit_logs；规则执行不写 | 写规则是高危低频；执行是低危高频，不可入 audit |
| 权限 | 超管 / 该 tenant 的 owner-admin | 与 scheduler / webhook 同档；不下放给普通成员 |

## 3. 架构

### 3.1 模块布局

```
src/session_rules_handlers.rs   HTTP API 层（CRUD）—— 新增
src/session_hooks.rs            纯函数库（已存在，本次仅暴露 parse_hooks_from_value 给 handler 复用）
src/rpc.rs                      inject_rpc_session_context —— 改造，多读一次 project rules 并合并

migrations/021_session_rules.sql                                schema 迁移
frontend-nextjs/app/workspace/[projectId]/session-rules/page.tsx UI 页面
frontend-nextjs/components/workspace/WorkspaceSidebar.tsx       侧栏加菜单项
```

不新建 `src/session_rules.rs` 模型层模块——表只有一张，handler 里直接走 sqlx，与 webhooks / scheduler 同款。

**与 workflow 模块的边界**（合并后明确）：

| 边界 | session_rules | workflow |
|---|---|---|
| migration 号 | 021 | 已有 `migrate_workflow.rs`（独立 binary）|
| 表 | `management.session_rules` | `management.workflows` + `management.workflow_runs` |
| handler 模块 | `session_rules_handlers.rs` | `workflow_handlers.rs` |
| Rust 依赖 | 仅 sqlx / serde / axum / session_hooks | + workflow_engine + lua_engine + lua_builtins |
| 路由 prefix | `/api/admin/session-rules` | `/api/admin/workflows` |
| 公开端点 | 无（不暴露给业务调用方） | `/workflow/:db/:slug` |
| 触发模型 | 同步在 RPC inject 内 | 异步 EventBus / HTTP endpoint |
| 跨模块调用 | 无（彼此不调用） | 无（彼此不调用）|

### 3.2 数据模型

```sql
-- migrations/021_session_rules.sql
CREATE TABLE management.session_rules (
    id            BIGSERIAL PRIMARY KEY,
    database_id   INTEGER NOT NULL REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
    name          VARCHAR(100) NOT NULL,
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    hooks         JSONB NOT NULL,    -- 与 session_hooks::SessionHook 同形态
    created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (database_id, name)
);

CREATE INDEX idx_session_rules_active
    ON management.session_rules(database_id)
    WHERE is_active = true;
```

`hooks` 列存数组，结构与现存 `permissions.session_hooks` 一字不差：

```json
[
  { "header": "X-Way-UID",     "guc": "app.current_user_id", "type": "text",    "max_length": 256 },
  { "header": "X-Project-IDs", "guc": "app.project_ids",     "type": "int_csv", "max_count": 1000 }
]
```

### 3.3 注入路径改造

`inject_rpc_session_context` 当前签名 `(tx, subject, headers)`。改造后内部多一步：

```
1. 算 default GUCs（current_user_id / project_ids，来自 subject）
2. 若 subject 是 ApiKey 且 headers 存在：
   a. 查 management.session_rules WHERE database_id = key.database_id AND is_active = true ORDER BY id
   b. 把所有 rule 的 hooks 拼成一个大 Vec<SessionHook>（按 id 升序）
   c. apply_hooks(...) 套到 headers 上，结果覆盖/追加 default
   d. 再把 key.permissions.session_hooks 套一遍，结果覆盖步骤 c 的结果（api_key > project）
3. set_config 每条 GUC
```

合并函数放 `session_hooks::merge_hooks_from_sources(project_hooks, key_hooks)` 或者直接在 inject 里两次调用 `apply_hooks`——倾向后者，少一层抽象。

`database_id` 从哪儿拿？`ApiKeyAuth.database_id` 已经有。`SchedulerRunner` 路径 `execute_rpc_inner` 走 `RpcAuthSubject::User`，project rules 不生效（与 D1 一致），所以不需要为它特殊处理。

### 3.4 HTTP API

路径风格参照 workflow 现有 `/api/admin/workflows`，但鉴权更严：

```
GET    /api/admin/session-rules?database_id=:id       -- 列表（必填 database_id）
POST   /api/admin/session-rules                       -- 创建（body 带 database_id）
GET    /api/admin/session-rules/:id                   -- 详情
PATCH  /api/admin/session-rules/:id                   -- 更新
DELETE /api/admin/session-rules/:id                   -- 删除
```

鉴权（**与 workflow 当前的"仅 Claims" 不同，更严**，避免越权写规则）：
- 走 `auth_middleware` 拿 Claims
- handler 顶部 `validate_can_manage(&claims, tenant_id_of(database_id), &pool)` —— 与 scheduler 同款
- 平台级 DB（`tenant_id IS NULL`）只允许超管

Request / Response：
- POST/PATCH body：`{ name, description?, is_active?, hooks: [...] }`
- `hooks` 落库前过一遍 `session_hooks::parse_hooks_from_permissions` 等价的校验函数（实际复用：把 hooks 数组包成 `{"session_hooks": <hooks>}` 再丢给 parse_hooks_from_permissions，返回结果非空且条数与输入一致才接受；否则 400 列出具体出错的索引）
- GET 列表默认按 id 升序，不分页（同项目规则数预期 < 50）

### 3.5 audit

所有 POST/PATCH/DELETE 在 handler 末尾调 `audit_handlers::log_action(...)`，action 字段：
- `session_rule.create`
- `session_rule.update`
- `session_rule.delete`

before/after 写 hook 数组的 JSON snapshot。审计 actor 就是当前 claims.sub。

### 3.6 前端

- 路由：`/workspace/{projectId}/session-rules`（接现有 `app/workspace/[projectId]/` 目录树）
- 侧边栏：在 workspace sidebar 加一个二级菜单"**会话规则**"（独立菜单项，不与 workflow 合并；workflow 维持现状挂在 `dashboard/workflows`）
- 列表页：表格显示 name / 启用开关 / 命中的 header 列表 / 修改时间 / 操作
- 编辑页（modal）：
  - 表单模式：name / description / is_active / 多条 hook（header / guc / type / 上限），每条 hook 一行可增删
  - JSON 模式：tab 切换，直接编辑 hooks 数组 raw JSON（高级用户）
- 没有 dry-run，但右侧固定显示一段"如何验证"提示（curl 示例 + 期望 log 行），降低用户上手摩擦
- **不与 workflow 共享组件**：workflow 用 react-flow 拖拽 DAG，session_rules 是简单表格，UI 不共用任何组件以免相互拉扯演进节奏

## 4. 安全 / 风险

- **新增攻击面**：管理员可以把 hook 配成把某个 header 写到某个 GUC。GUC 名白名单已限制在 `^app\.[a-z_][a-z0-9_]{0,63}$`，写不到 `role` / `search_path` 这类敏感 GUC。
- **越权可能**：能创建规则的人 = tenant owner/admin，他们本来就能改 RBAC，不引入新越权路径。
- **DoS**：每条 hook header 值有 `max_length` / `max_count`；规则数量预期低（< 50/项目），不做硬上限。
- **性能**：每次 RPC inject 多一次 `SELECT ... WHERE database_id = $1 AND is_active = true`。规则数小、有 partial index、应该 < 1ms；若线上观察到瓶颈，加 in-memory 缓存（带 invalidate 机制，类似 `permission_cache`）。v1 不加缓存。
- **审计完整性**：audit_logs 已有，前后 snapshot 进去；不需要额外存档。

## 5. v1 工作切分

| 模块 | 估时 |
|---|---|
| migration 021 + `session_rules` schema | 0.5 天 |
| session_hooks.rs 暴露 `parse_hooks_from_value(&Value) -> Result<Vec<SessionHook>, Vec<HookError>>` 给 handler 校验用 | 0.5 天 |
| session_rules_handlers.rs + 路由 + 鉴权 + audit | 1.5 天 |
| rpc.rs inject 路径合并 project rules（含 sqlx 查询）+ 单元/集成测试 | 1 天 |
| 前端列表 + 编辑（表单 + JSON 双模式） + 侧栏菜单 | 2 天 |
| 联调 + 文档 + audit 接线核查 | 0.5-1 天 |

合计 **~6-7 个工作日**。与原估时基本持平——workflow 引擎已经存在但不复用，工作量没节省也没增加。

## 6. 未来 v2 入口（设计预留）

这些已经预留，但**不在 v1 实现**：

- 加新规则类型（e.g. `body_field_default`）：`session_hooks::HookKind` 加变体 + parse/apply 分支，前端表单 type 下拉新增项。
- Auto API 路径接入：在 `auto_api_handlers::inject_session_user_id` 旁边读同一张 `session_rules` 表（一行不改 schema）。
- 规则触发面字段：表里如果要加更细粒度（如 `scope = 'rpc' | 'auto_api' | 'both'`），单加一列 `applies_to TEXT[] NOT NULL DEFAULT '{rpc}'`，老数据自动是 rpc，不破坏 v1。
- 与 workflow 的导航融合：v2 可考虑在 workspace 侧栏建一个"自动化"二级目录，把 session-rules 和（项目化后的）workflow 都收进去；v1 阶段不强求。

## 7. 开放问题（user review 时确认）

- 表的 schema 名沿用 `management.session_rules`，还是想叫 `management.project_session_rules` 让命名更具体？
- 列表 UI 是否需要"复制到其它项目"按钮？（v1 不做，但 UI 留个灰按钮也行？）—— 倾向不留，避免误导。
- audit_logs 的 action 字段当前是字符串约束 / 枚举？需要确认能塞 `session_rule.*`。
- workflow_handlers 当前鉴权偏松（只取 Claims、不做 tenant 归属校验）—— 是否顺手补一下？如果不补，session_rules 的严鉴权可能让"两个相邻能力风格不一致"。倾向独立 PR 修 workflow，不放进本次 v1 范围。
