# OneBase MVP（前 4 周）实施总览

> **For agentic workers**: 本文档是**索引**，不是可执行 plan。每个 milestone 对应一份独立的 plan 文件，请按依赖顺序选择执行。

**Goal**: 在第 1-4 周交付 MVP——开发者能从 0 自助完成「登录 → 建项目 → 建表 → 查 API → 看大盘」。

**Spec 来源**: `docs/superpowers/specs/2026-05-13-platform-evolution-design.md` 第 2、3 节

**当前阶段**: M0 + MVP（前 4 周）

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

### Plan 2：M2 自助开通向导（MVP，1 周）

**待写**：M1 完成后撰写。预期文件 `2026-05-13-m2-onboarding-wizard.md`。

**预期改动**:
- 单一后端端点 `POST /api/projects/provision`（幂等，返回 `project_id`）
- 5 步前端 wizard：选场景 → 命名项目 → 挂载 PG（从超管"PG 池"选）→ 选模板（空白/博客/任务/社区）→ 完成
- 数据迁移 `015_*.sql`：项目模板元数据 + "PG 池"管理表

**依赖**: Plan 1 的 `Project` 模型必须落定。

---

### Plan 3：M3 可视化建表（MVP，1.5 周）

**待写**：M1 完成后撰写。预期文件 `2026-05-13-m3-visual-schema.md`。

**预期改动**:
- 复用 `schema_handlers` `index_handlers` 已有 API
- 前端新增 ER 图表组件（`@dbml/core` 渲染或自研轻量版）
- DDL 预览面板 + 一键 commit 按钮（走现有 `schema_handlers` 的安全校验）
- 仅落地"裸最小集"：单表 CRUD、字段类型选择、外键、索引；JSONB/Array/Enum 等高级类型 v1.x 再加

**依赖**: Plan 1 的 workspace 路由 + 项目权限校验。

---

### Plan 4：M6 项目级简化大盘（MVP，0.5 周）

**待写**：M1 完成后撰写。预期文件 `2026-05-13-m6-dashboard-simplified.md`。

**预期改动**:
- 复用 `monitor_handlers` `query_perf_handlers` `audit_handlers` 现有 API
- 6 个核心卡片：QPS / P95 / 错误率 / 慢查询数 / 活跃 API Key / 每日调用量
- 项目维度聚合（按 `project_id` group by）
- "异常访问告警"留到 Beta 阶段（M6 完整版）

**依赖**: Plan 1 的 `CurrentProjectId` middleware 提取。

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
| Plan 1 (M1) | 📝 撰写中 | `2026-05-13-m1-project-workspace.md` |
| Plan 2 (M2) | ⏳ 待 M1 完成 | – |
| Plan 3 (M3) | ⏳ 待 M1 完成 | – |
| Plan 4 (M6) | ⏳ 待 M1 完成 | – |

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
