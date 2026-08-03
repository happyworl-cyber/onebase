# OneBase MVP（前 4 周）实施总览

> **For agentic workers**: 本文档是**索引**，不是可执行 plan。每个 milestone 对应一份独立的 plan 文件，请按依赖顺序选择执行。

**Goal**: 在第 1-4 周交付 MVP——开发者能从 0 自助完成「登录 → 建项目 → 建表 → 查 API → 看大盘」。

**Spec 来源**: `docs/superpowers/specs/2026-05-13-platform-evolution-design.md` 第 2、3 节

**当前阶段**: 🚧 **Beta 阶段进行中**（MVP 已交付，M4 已落地）

| MVP 出口检查 | 状态 |
|---|---|
| 登录 | ✅ 既有 |
| 建项目 | ✅ M2 自助开通向导 |
| 建表 | ✅ M3 可视化建表（sidebar + 空状态 CTA） |
| 查 API | ✅ auto API 既有 |
| 看大盘 | ✅ M6 项目首页 6 卡 + sparkline + 活动 feed |

### Beta 阶段进度

| 模块 | 状态 | plan 文件 |
|---|---|---|
| M4 RBAC 可视化（权限矩阵 + 结构化条件 + 列控制 + 5 模板） | ✅ 已完成 | `2026-05-19-m4-rbac-visualization.md` |
| M5 Webhook / Realtime 配置面板 | ⏳ 待开始 | – |
| M6 完整版（异常访问告警） | ⏳ 待开始 | – |
| M7 NL2SQL 只读 | ⏳ 待开始 | – |

**下一站**: M5 Webhook 面板（~0.5 周，前端补齐重试历史 + Realtime endpoint UI），然后 M6 完整版（告警 evaluator + 通知 fan-out 复用 M5）或直接进 M7 NL2SQL。

---

## 阶段范围（来自 spec §3）

| 阶段 | 累计周 | 模块 | 对应 plan 文件 |
|---|---|---|---|
| M0 Foundation | 第 1-2 周 | M1 项目工作空间 + 控制台拆分 | `2026-05-13-m1-project-workspace.md` |
| MVP | 第 3-4 周 | + M2 开通向导 + M3 裸建表 + M6 简化大盘 | 3 个并行 plan（M1 完成后写） |

---

## 4 个 sub-plan 的依赖关系

```
        ┌──────────────────────────────┐
        │ Plan 1: M1 项目工作空间       │  独占第 1-2 周
        │ (tenants 表扩展 / project     │  必须先完成
        │  middleware / workspace 路由) │
        └──────────────┬───────────────┘
                       │
                       │ 完成后解锁
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌──────────┐  ┌──────────────┐ ┌──────────┐
  │ Plan 2   │  │ Plan 3       │ │ Plan 4   │
  │ M2 向导  │  │ M3 建表      │ │ M6 大盘  │
  │ (1 周)   │  │ (1.5 周)     │ │ (0.5 周) │
  └──────────┘  └──────────────┘ └──────────┘
       第 3-4 周可三线并行（如有人手）
```

---

## 各 plan 的概要

### Plan 1：M1 项目工作空间（前置，2 周）

**文件**: `2026-05-13-m1-project-workspace.md`（与本文同时产出）

**核心改动**:
- DB migration `014_*.sql`：`management.tenants` 表扩展 `kind` + `workspace_config` 列；seed 3 个内置 RBAC 角色（`project_owner` / `project_developer` / `project_viewer`）
- 后端新增 3 个模块：`project_models.rs` / `project_handlers.rs` / `project_middleware.rs`；`main.rs` 注册新路由；保留现有 `tenant_handlers` 兼容
- 前端新增 `app/workspace/[projectSlug]/*` 路由 + `WorkspaceSidebar` 组件；现有 `app/dashboard/*` 不动；`lib/api.ts` 新增 `X-Project-Slug` 请求头
- 测试：`project_models` Rust 单测 + `tests/m1_workspace_test.sh` shell 集成测试

**Demo 出口**：用户登录后能进入 `/workspace/<slug>` 页面，看到项目首页，菜单仅显示该项目允许的功能；超管控制台 `/dashboard` 无回归。

---

### Plan 2：M2 自助开通向导（MVP，1 周）— ✅ 已完成

**文件**: `2026-05-19-m2-onboarding-wizard.md`

**实施摘要**（commit 范围 `1xxxxxx`..`59c6d78`，5 phase / 5 commit）:
- Migration `018_pg_pools_and_templates.sql`：新增 `management.pg_pools` + `management.project_templates`，seed 4 模板（blank 可用 + blog/tasks/community 标 `is_coming_soon=true`）
- 后端：`pg_pool_helpers.rs` + `pg_pool_handlers.rs` —— 超管 CRUD（list/create/update/soft-delete/test）+ 用户视角只读 `/api/pg-pools/available`
- 后端：`POST /api/projects/provision` 单端点（auth_middleware 通路），幂等键 = `(caller_user_id, slug)`；CREATE DATABASE 用 pool admin 凭据，写 management 表后跑模板 DDL；caller 自动成为 owner
- 前端：`/platform/pg-pools` 超管页（表格 + 添加 drawer + test 按钮）
- 前端：`/workspace/provision` 5 步 wizard（场景 → 命名 → 池 → 模板 → 确认）；项目选择页 + no-projects 页都加入口
- 测试：`tests/m2_provisioning_test.sh`（7 case，自动加 pool 兜底）

**决策摘要（plan §0）**:
- PG 池严格不允许 escape hatch（用户不能自填 host/port）
- v1 模板只做 blank；blog/tasks/community 占位
- 幂等键用 (caller_user_id, slug) 而非全局唯一 idempotency-key

**已知遗留**:
- CREATE DATABASE 跨连接事务做不掉，失败留孤儿库（v1 用 tracing + status='failed_provisioning' 兜底，待 M4 saga）
- 项目 DB 仍复用 pool admin 凭据（M4 RBAC 完整版会改成每个项目独立 PG ROLE）

**依赖**: Plan 1 的 `Project` 模型 + W4 PASE Stage E 的 require_tenant_admin / owner helper

---

### Plan 3：M3 可视化建表（MVP，✅ 已完成）

**文件**: `2026-05-19-m3-visual-schema.md`

**实际情况**：写 plan 前盘点发现 M3 已"做了 70%"——`schema_handlers` / `index_handlers` 完整、前端 `/database/table-designer`（682 行 DDL 生成器）和 `/database/visualizer`（reactflow ER 图）都在；真正缺的是**入口和真正的 ALTER**。

**关键决策（实施前已对齐）**：
- **ALTER 范围**：极简安全集——加列 / 删列 / 改 NOT NULL / 改 DEFAULT。**不做**改列名 / 改列类型 / 重排序（留 v1.x 配迁移预览再做）
- **Discoverability**：sidebar 加"表设计器"入口 + tables/visualizer 空状态 CTA。项目首页不动
- **ER 交互**：v1 保持只读；不做点击节点跳转
- **DDL 权限闸**：member+（owner/admin/member）。viewer 只读。新建 endpoint 而不是放宽 /query（后者保持仅超管 raw-SQL 通道）

**实际改动**：
- 后端：
  - `permissions::require_tenant_member` / `require_database_member` —— member+ helper
  - 新模块 `src/ddl_handlers.rs`（~520 行）：3 个 handler，结构化 body + 数据类型 / FK 动作 / 默认表达式 / schema 黑名单白名单双重防护，6 个单元测试
  - 路由：`POST /api/ddl/tables` / `DELETE /api/ddl/tables/:s/:t` / `PATCH /api/ddl/tables/:s/:t`，挂在已有 schema_routes 业务路由组
- 前端：
  - `lib/api.ts` 加 `ddlAPI` + DdlColumnDef / AlterOp 类型
  - 复用既有 `canWriteDatabase`（member+，文档里就写着"建表/改 schema"）—不新增 capability
  - `WorkspaceSidebar.tsx` 加"表设计器"入口
  - `table-designer/page.tsx` 大改：URL 参数支持 `?mode=create` / `?mode=edit&table=foo`；从 `/query` 切到 `ddlAPI`；edit 模式真正 diff originalColumns → AlterOp[]；原始列名/类型锁死；执行按钮按 canWriteDatabase gate
  - `tables/page.tsx` 顶部 "+ 新建表" CTA + 空状态"建第一张表" CTA + 行级"编辑结构"按钮
  - `visualizer/page.tsx` 空状态加"去建一张表" CTA
- 测试：`tests/m3_ddl_test.sh` 10 个 scenarios（建 / 重建 / ALTER / 未知 op / 黑名单 schema / 非法 ident / 非法类型 / DROP CASCADE / viewer 403 / 缺 X-Database-Id）

**已知遗留**：
- 改列名 / 改列类型 / 重排序列（v1.x）
- ER 图节点点击 → designer 跳转（v2 ER 编辑器范畴）
- COMMENT ON TABLE / COMMENT ON COLUMN（v1.x）
- M4 RBAC 完整版可能进一步收紧 member 的 DDL 范围（如表级 grant / approval flow）

**依赖**: Plan 1 的 workspace 路由 + W4 PASE 的 `user_role` / `canWriteDatabase` capability。

---

### Plan 4：M6 项目级简化大盘（MVP，✅ 已完成）

**文件**: `2026-05-19-m6-simplified-dashboard.md`

**关键决策（实施前已对齐）**：
- **大盘落点**：项目首页 `/workspace/[projectId]`——把 W1/W2 时代的 4 张 placeholder 卡换掉，避免新开 sidebar 项
- **趋势图**：内嵌 SVG sparkline（QPS 24h），不引第三方图表库
- **最近活动**：顺手做 sanitized feed，复用首页的 placeholder 区
- **鉴权**：viewer 也能看——大盘是纯聚合数字 + 路径前缀，无行级业务数据。新增 `require_tenant_membership_any` helper

**实际改动**：
- 后端：
  - `permissions::require_tenant_membership_any`（最宽——含 viewer）
  - 新模块 `src/dashboard_handlers.rs`（~270 行）：
    - `GET /api/dashboard/overview?tenant_id=N` —— 单 CTE 一次拿全 6 指标 + 24 个 hourly bucket
    - `GET /api/dashboard/recent-activity?tenant_id=N&limit=10` —— sanitized projection（去掉 IP / user_agent / request_body）
  - hourly bucket 填补：PG 返回稀疏数组，handler 端补齐 24 槽位（最旧的 23 小时前 → 当前小时）
  - 3 个单元测试（hourly padding 的 empty / sparse / malformed 三种输入）
- 前端：
  - `lib/api.ts` 加 `dashboardAPI` + 类型
  - `app/workspace/[projectId]/page.tsx` 重写：6 卡 + sparkline + 最近活动 + 30s 自动刷新
  - 空数据态显眼引导：项目刚开通 / 没流量时提示去建表 / 试 API
- 测试：`tests/m6_dashboard_test.sh` 7 个 scenarios（字段完整 / activity 形状 / 缺 tenant_id / viewer 读 / 非成员 403 / hourly 长度 24 / sanitized 字段）

**已知遗留**：
- 异常访问告警（spec 明确推 Beta M6 完整版）
- 自定义大盘 / 自定义指标（v2）
- 按 endpoint 维度的 top calls（v2，需要 path 归一化）
- 错误率 / P95 趋势叠加图（v2 大盘）

**依赖**: M1 的 workspace 路由 + M3 后保证项目能有 audit_logs 流量（验证 sparkline）。

---

## 写作时机决策

**现在写**：`mvp-overview.md`（本文档）+ `m1-project-workspace.md`

**M1 接近完成时再写**：Plan 2/3/4

**理由**：M1 落地后会发现一些与现在假设不同的细节（例如 project slug 的命名规则、`CurrentProjectId` 的具体注入方式、前端 layout 的认证逻辑边界），这些细节会影响 Plan 2/3/4 的接口设计。提前写完会有 30% 的重写概率。

---

## 进度追踪

| Plan | 状态 | 文件 |
|---|---|---|
| MVP 总览 | ✅ 已完成 | `2026-05-13-mvp-overview.md`（本文） |
| Plan 1 (M1) | ✅ 已完成 | `2026-05-13-m1-project-workspace.md` + W1/W2/W3/W4 系列 follow-up |
| Plan 2 (M2) | ✅ 已完成 | `2026-05-19-m2-onboarding-wizard.md` |
| Plan 3 (M3) | ✅ 已完成 | `2026-05-19-m3-visual-schema.md` |
| Plan 4 (M6) | ✅ 已完成 | `2026-05-19-m6-simplified-dashboard.md` |

---

## 参考文档

- Spec: `docs/superpowers/specs/2026-05-13-platform-evolution-design.md`
- 上游可行性研究: `docs/superpowers/specs/2026-05-13-platform-feasibility-study.md`
- 现有架构（在仓库中）：
  - `src/middleware.rs` - 现有 auth / dynamic_db / require_superadmin 中间件
  - `src/tenant_models.rs` - 现有 `Tenant` / `TenantDatabase` 模型
  - `src/tenant_handlers.rs` - 现有 tenant CRUD（M1 不动它，新建 project handlers 与之并列）
  - `migrations/003_create_management_schema.sql` - `management.tenants` 表的原始建表 SQL
  - `frontend-nextjs/app/dashboard/layout.tsx` / `app/platform/layout.tsx` - 现有两套 layout
  - `frontend-nextjs/lib/api.ts` - 现有 API 客户端（含 `X-Database-Id` 注入逻辑）
