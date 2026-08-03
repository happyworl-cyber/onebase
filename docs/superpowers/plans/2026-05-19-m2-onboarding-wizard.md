# M2 自助开通向导（Onboarding Wizard）

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development / superpowers:executing-plans

**目标：** 解锁 MVP 出口的关键一环——普通用户能在 Web 上自助走完 "选场景 → 命名项目 → 挂载 PG → 选模板 → 完成"，30 分钟内拿到一个可用的项目（含 DB + 默认 RBAC + API），不再需要超管走 `/api/admin/tenants/create` 手工配置。

**关联：**
- 母 spec `docs/superpowers/specs/2026-05-13-platform-evolution-design.md` §2.3 M2
- 上游 `mvp-overview.md` Plan 2 占位
- 依赖：M1 全套（W1-W4）已落地

---

## 0. 决策摘要（实施前已对齐）

| 决策点 | 选定方案 | 含义 |
|---|---|---|
| PG 池边界 | **严格不允许 escape hatch** | 普通用户 wizard 只能从池里选；想自填 host/port 走 `/platform`（现有 `/api/admin/tenants/create`，超管路径） |
| 模板范围 | **v1 只做"空白"一种** | 博客 / 任务管理 / 社区 在 UI 里以 stub 形式显示（灰掉 + "即将推出"），不写 DDL，留给 M3 ER 编辑器联动 |
| 幂等键 | **`(caller_user_id, slug)` 组合** | 同一用户重发同一 slug → 返回上次同一项目；不同用户用相同 slug → 第二个 409 |
| Plan 拆分 | **单 plan / 5 phase / 5 commit** | 每 phase 一个独立 commit，便于回滚 / 分批 review |

---

## 1. 范围

### 做（v1）

**后端**：

| 路径 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/admin/pg-pools` | GET POST | 仅超管 | 列 / 加 PG 池条目（admin 凭据加密存） |
| `/api/admin/pg-pools/:id` | PATCH DELETE | 仅超管 | 改 / 删（删走软删 is_active=false） |
| `/api/admin/pg-pools/:id/test` | POST | 仅超管 | 用 admin 凭据测连（不写库） |
| `/api/pg-pools/available` | GET | 任意已登录 | 用户视角：返回 active pool 的 host/port/note（**不含密码** / 不含 admin_user），让 wizard step 3 渲染下拉 |
| `/api/project-templates` | GET | 任意已登录 | 返回模板列表（`slug / name / description / scenario / is_coming_soon`） |
| `/api/projects/provision` | POST | 任意已登录 | M2 主端点；详见 §3.4 |

**数据库**：

- `migrations/018_pg_pools_and_templates.sql`：
  - `management.pg_pools`（id / name / db_host / db_port / admin_user / admin_password_encrypted / note / is_active）
  - `management.project_templates`（id / slug UNIQUE / name / description / scenario / ddl_sql / is_coming_soon / is_active）
  - seed 1 个 "blank" 模板（is_coming_soon=false, ddl_sql=''），3 个 stub（is_coming_soon=true）

**前端**：

| 页面 | 路径 | 鉴权 |
|---|---|---|
| 平台 PG 池管理 | `/platform/pg-pools` | 超管 |
| 用户开通向导 | `/workspace/provision` | 任意已登录 |
| 入口 | `/workspace/page.tsx`（项目选择页）顶部加"+ 新建项目"按钮 + `/workspace/no-projects/page.tsx` 加"立即创建"主 CTA |

### 不做

- **自动新建 PG 实例**（子系统 B 范畴，spec 明确 v1 不做）
- **用户自填 PG host/port**（escape hatch，决策点 1）
- **博客 / 任务 / 社区 模板 DDL**（决策点 2 留给 M3）
- **PG 池容量配额**（按 license 限制 → M8）
- **审批 / 配额 / 配置市场**（v2+）
- **wizard 多语言**：硬编码中文，沿用 spec §2.4

---

## 2. 数据模型

### 2.1 `management.pg_pools`

```sql
CREATE TABLE IF NOT EXISTS management.pg_pools (
    id                          SERIAL PRIMARY KEY,
    name                        VARCHAR(100) NOT NULL UNIQUE,
    db_host                     VARCHAR(255) NOT NULL,
    db_port                     INTEGER      NOT NULL DEFAULT 5432,
    admin_user                  VARCHAR(100) NOT NULL,
    admin_password_encrypted    TEXT         NOT NULL,
    note                        TEXT,
    is_active                   BOOLEAN      NOT NULL DEFAULT true,
    created_at                  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pg_pools_active ON management.pg_pools(is_active);
CREATE TRIGGER update_pg_pools_updated_at
    BEFORE UPDATE ON management.pg_pools
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();
```

**字段语义**：
- `name`：超管命名，如 "aliyun-prod-rds-shared"
- `admin_user / admin_password_encrypted`：用于在该 PG 上 `CREATE DATABASE`；密码走 `crypto::encrypt_secret`（与 `tenant_databases.db_password_encrypted` 同处理）
- `is_active=false` 后用户视角 GET 时不再返回

### 2.2 `management.project_templates`

```sql
CREATE TABLE IF NOT EXISTS management.project_templates (
    id              SERIAL PRIMARY KEY,
    slug            VARCHAR(50)  NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    scenario        VARCHAR(50)  NOT NULL DEFAULT '通用',
    ddl_sql         TEXT         NOT NULL DEFAULT '',
    is_coming_soon  BOOLEAN      NOT NULL DEFAULT false,
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    sort_order      INTEGER      NOT NULL DEFAULT 0,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 种 4 个模板（决策点 2：v1 只做 blank）
INSERT INTO management.project_templates (slug, name, description, scenario, ddl_sql, is_coming_soon, sort_order) VALUES
    ('blank',     '空白项目',  '不预置任何业务表，建好就是干净的 DB；自己用 ER 编辑器 / SQL 建表',  '通用',         '', false, 10),
    ('blog',      '博客系统',  '内置文章 / 评论 / 标签 / 作者 表（v1.x 即将推出）',                  '内容应用',     '', true,  20),
    ('tasks',     '任务管理',  '内置项目 / 任务 / 分配 表（v1.x 即将推出）',                          '内部工具',     '', true,  30),
    ('community', '社区论坛',  '内置话题 / 回复 / 用户档案 表（v1.x 即将推出）',                      '内容应用',     '', true,  40)
ON CONFLICT (slug) DO NOTHING;
```

### 2.3 与现有表的关系

不引入新外键到 `tenants`——`tenant.workspace_config` JSONB 里加一个软引用：

```json
{ "provisioned_from_template": "blank", "provisioned_pg_pool_id": 1, "provisioned_at": "2026-05-19T...", "provisioned_by_user_id": 7 }
```

`workspace_config` 已经在 W1 时加上了（migration 017）。

---

## 3. 后端详细设计

### 3.1 共享 helper：`pg_pool_helpers.rs`（新模块）

放在 `src/pg_pool_helpers.rs`：

```rust
pub struct PgPoolEntry {
    pub id: i32,
    pub name: String,
    pub db_host: String,
    pub db_port: i32,
    pub admin_user: String,
    pub note: Option<String>,
}

pub async fn list_active_pools(pool: &PgPool) -> Result<Vec<PgPoolEntry>>;
pub async fn get_pool(pool: &PgPool, id: i32) -> Result<PgPoolEntry>;

/// 用 admin 凭据在指定 pool 上 CREATE DATABASE；不写 management 表。
/// 返回新建库名（可能含随机后缀避免冲突）。
pub async fn create_database_on_pool(
    pool: &PgPool,
    pool_id: i32,
    requested_db_name: &str,
) -> Result<String>;

/// 用 admin 凭据连指定 pool 跑 ddl；自动 BEGIN/COMMIT。
pub async fn apply_template_ddl_on_pool(
    pool: &PgPool,
    pool_id: i32,
    db_name: &str,
    ddl_sql: &str,
) -> Result<()>;
```

### 3.2 PG 池超管 CRUD（`pg_pool_handlers.rs` 新模块）

| Handler | 鉴权 | 行为 |
|---|---|---|
| `list_pg_pools` | `require_super_admin` | 返回所有（含 inactive），admin_password **不返回** |
| `create_pg_pool` | `require_super_admin` | body: name/host/port/admin_user/admin_password/note；密码 `crypto::encrypt_secret` |
| `update_pg_pool` | `require_super_admin` | PATCH name/note/is_active；改密码用 `admin_password` 字段（空字符串不改） |
| `delete_pg_pool` | `require_super_admin` | 软删 is_active=false；不级联删除已经 provisioned 出去的 tenant_databases |
| `test_pg_pool` | `require_super_admin` | 用 admin 凭据连一下 + `SELECT 1`；返回 `{ok: bool, error?: string}` |

### 3.3 用户视角 PG 池只读（`tenant_handlers.rs` 末尾或新 module）

```rust
/// GET /api/pg-pools/available
/// 返回 active 池的 { id, name, db_host, note }（不含 admin_user / 密码）
pub async fn list_available_pg_pools(...) -> Result<Json<Vec<...>>>
```

### 3.4 模板只读

```rust
/// GET /api/project-templates
/// 返回所有 is_active=true 的模板（含 is_coming_soon=true 的 stub）
pub async fn list_project_templates(...) -> Result<Json<Vec<...>>>
```

### 3.5 主端点：`POST /api/projects/provision`

```rust
#[derive(Deserialize)]
pub struct ProvisionRequest {
    pub name: String,        // 1-200 char
    pub slug: String,        // 1-50 char, [a-z0-9_-], 唯一
    pub pg_pool_id: i32,
    pub template_slug: String, // 必须是 templates 里 is_coming_soon=false 的
    pub scenario: Option<String>,  // metadata，只写进 workspace_config
}

pub async fn provision_project(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Json(req): Json<ProvisionRequest>,
) -> Result<Json<ProvisionResponse>>
```

**执行流程**（高位串行，关键步骤幂等 / 可重试）：

1. **校验输入**：
   - slug 正则 `^[a-z][a-z0-9_-]{0,49}$`
   - name 长度 1..=200
   - template 必须存在 + `is_coming_soon=false` + `is_active=true`
   - pg_pool 必须存在 + `is_active=true`

2. **幂等检查**：
   - 查 `management.tenants` 是否已有 slug=$1 的项目
   - 如果有：再查 `user_tenants` 这个 caller 是不是 owner；是 → 返回现有 project_id（200 OK + `{ provisioned: false, project_id, ... }`）；不是 → 409 "slug 已被占用"

3. **CREATE DATABASE**（在 pg_pool 上，**先于 management 表写入**）：
   - DB 名：`{slug}_{random_6}`（避免和已有库冲突，也避免 slug 改名后老库变成孤儿）
   - 失败 → 直接 4xx/5xx，不留半成品

4. **management 表写入**（事务内）：
   - `INSERT management.tenants (name, slug, kind='project', workspace_config=...)` —— `workspace_config` 写 `{provisioned_*}` metadata
   - `INSERT management.tenant_databases (tenant_id, db_host, db_port, db_name, db_user, db_password_encrypted, is_primary=true, is_active=true)` —— **db_user / db_password 怎么设？** 选项：
     - **方案 A（v1 选）**：复用 pg_pool 的 admin_user / admin_password；简单但用户拿到的 DB 凭据是 admin 级别
     - 方案 B：在新库里 `CREATE USER {slug}_user PASSWORD ...` 后用普通用户连——v1 不做，等 M4 RBAC 完整版联动
   - `INSERT management.user_tenants (user_id=caller, tenant_id, role='owner', is_active=true)`

5. **应用模板 DDL**（如果非空）：
   - 用 admin 凭据连新建的库 → 跑 `template.ddl_sql`（BEGIN/COMMIT 包起来）
   - 失败 → 标记 tenant 为 `status='failed_provisioning'`（新枚举值），返回 500 + 提示用户找超管删项目（v1 不做自动 rollback）

6. **RBAC 默认**：
   - `crate::rbac_handlers::seed_tenant_rbac_defaults(&pool, tenant_id).await`
   - `permissions::sync_default_rbac_role(&pool, redis, caller, tenant_id, "owner").await`

7. **审计**：
   - `tracing::info!(target="provisioning", "user {} provisioned project {} (slug={}, db={}, template={}, pg_pool={})", ...)`
   - `audit_middleware` 会自动写一条 audit_log（action `PROVISION_PROJECT` 在 audit_middleware 现有 derive 逻辑里走 default path）

8. **返回**：
   ```json
   {
     "provisioned": true,
     "project_id": 42,
     "slug": "my-blog",
     "database_id": 78,
     "db_name": "my-blog_a3f9c2",
     "user_role": "owner"
   }
   ```

**事务边界**：步骤 3（CREATE DATABASE）和步骤 4（写 management 表）跨两个 DB 连接，无法走单一事务。失败模式：
- 3 成功、4 失败 → 留下孤儿 DB；记录到 tracing；用户报错"创建失败请重试"；超管手工清理
- 3 成功、4 成功、5 失败 → tenant.status='failed_provisioning'；用户看到错误页；超管手工删

**这不是完美方案**，但 v1 接受；v2 可以用 saga / outbox 改进。

---

## 4. 前端详细设计

### 4.1 平台超管页 `/platform/pg-pools/page.tsx`

类似 W3 的 `/platform/monitor` 风格。表格 + 添加/编辑 drawer + 测试连接按钮。

字段：name / db_host:port / admin_user / note / is_active / 操作（编辑 / 测试 / 软删）

### 4.2 用户向导 `/workspace/provision/page.tsx`

5 步式 wizard，每步独立组件：

```
Step 1: 选场景       → 一组 cards（通用 / 内容应用 / 内部工具 / 数据分析）
                      选中后 step 4 的模板列表会按 scenario 过滤
Step 2: 命名项目     → name 输入 + slug 输入（slug 自动从 name 拼音首字母派生，可改）
                      实时校验 slug 唯一（debounced GET /api/projects?slug=...）
Step 3: 挂载 PG      → 从 /api/pg-pools/available 拉下拉；显示 host:port + note
                      若 0 个可用 → 显示"请联系平台管理员开通 PG 池"+ 链接到联系人
Step 4: 选模板       → 卡片列表；is_coming_soon=true 的灰掉 + "v1.x 即将推出" 角标
                      v1 实际只有"blank"可选
Step 5: 确认 + 完成   → review summary + [创建] 按钮 → POST /api/projects/provision
                      成功 → 跳 /workspace/{project_id}（layout 自动设 currentProject）
                      失败 → 显示错误 + 留在该步可重试
```

进度条 + 上一步 / 下一步导航。每步本地状态存 `useState`；切换页面不持久化（v1 用户刷新就重来）。

### 4.3 入口

- `app/workspace/page.tsx`（多项目选择页）：顶部新增 "+ 新建项目" 按钮 → `/workspace/provision`
- `app/workspace/no-projects/page.tsx`：主 CTA 改为 "立即创建项目" → `/workspace/provision`
- `PlatformSidebar`：加 "PG 池" 入口（指向 `/platform/pg-pools`）

### 4.4 API client

`lib/api.ts` 加：

```ts
export const pgPoolAPI = {
  // 超管：完整 CRUD
  listAll: () => api.get('/api/admin/pg-pools'),
  create: (body) => api.post('/api/admin/pg-pools', body),
  update: (id, body) => api.patch(`/api/admin/pg-pools/${id}`, body),
  remove: (id) => api.delete(`/api/admin/pg-pools/${id}`),
  test: (id) => api.post(`/api/admin/pg-pools/${id}/test`),

  // 用户视角
  listAvailable: () => api.get('/api/pg-pools/available'),
}

export const projectTemplateAPI = {
  list: () => api.get('/api/project-templates'),
}

export const projectProvisionAPI = {
  provision: (body) => api.post('/api/projects/provision', body),
}
```

---

## 5. 实施顺序（5 phase / 5 commit）

### Phase 1 — Migration + 模板 seed（~0.5 day）

- [ ] 1.1 `migrations/018_pg_pools_and_templates.sql`：建两表 + seed 4 模板
- [ ] 1.2 `bin/migrate_all.rs` 注册 018
- [ ] 1.3 跑 `cargo run --bin migrate_all`，验证两表 + 4 行 templates
- [ ] 1.4 Commit："feat(m2): add pg_pools + project_templates tables, seed 4 templates"

### Phase 2 — 超管 pg-pool CRUD API + helper（~0.5-1 day）

- [ ] 2.1 `pg_pool_helpers.rs`：list / get / create_database_on_pool / apply_template_ddl_on_pool
- [ ] 2.2 `pg_pool_handlers.rs`：5 个 handler（list / create / update / delete / test）
- [ ] 2.3 `main.rs`：注册路由 + 加进现有 superadmin router 组
- [ ] 2.4 `cargo build` 干净 + 写一个简易 shell smoke（list / create / test 三条）
- [ ] 2.5 Commit："feat(m2): backend — pg_pools CRUD for superadmin"

### Phase 3 — `/platform/pg-pools` 页面（~0.5-1 day）

- [ ] 3.1 `lib/api.ts`：`pgPoolAPI` 完整版
- [ ] 3.2 `app/platform/pg-pools/page.tsx`：表格 + 添加 drawer + 编辑 drawer + 测试按钮
- [ ] 3.3 `PlatformSidebar` 加"PG 池"入口
- [ ] 3.4 tsc + 浏览器手工 smoke（建一条池条目，测试连接）
- [ ] 3.5 Commit："feat(m2): frontend — /platform/pg-pools admin page"

### Phase 4 — `POST /api/projects/provision` 端点（~1 day）

- [ ] 4.1 `tenant_handlers.rs` 末尾加 `provision_project` handler
- [ ] 4.2 `main.rs` 注册路由（在 `auth_middleware` 链路里，不在 superadmin）
- [ ] 4.3 加 `/api/pg-pools/available` + `/api/project-templates` 只读接口
- [ ] 4.4 `tests/m2_provisioning_test.sh`：5 个场景
  - 普通用户成功 provision（slug=`m2_smoke`，blank 模板）→ 200 + project_id
  - 同用户同 slug 重发 → 200 + provisioned=false（幂等）
  - 不同用户同 slug → 409
  - 非法 slug（含大写）→ 400
  - 选了 is_coming_soon=true 的模板 → 400
- [ ] 4.5 `cargo build` + 跑测试
- [ ] 4.6 Commit："feat(m2): backend — POST /api/projects/provision endpoint"

### Phase 5 — `/workspace/provision` 5 步 wizard + 入口（~1-1.5 day）

- [ ] 5.1 `lib/api.ts`：`projectTemplateAPI` + `projectProvisionAPI`
- [ ] 5.2 `app/workspace/provision/page.tsx`：5 步 wizard 主框架（step indicator + 各 step props）
- [ ] 5.3 各 step component（5 个）
- [ ] 5.4 `/workspace/page.tsx` 和 `/workspace/no-projects/page.tsx` 加入口按钮
- [ ] 5.5 tsc + 浏览器手工 smoke 5 步完整流（建一个真实项目）
- [ ] 5.6 Commit："feat(m2): frontend — /workspace/provision 5-step wizard + entry"

### 收尾

- [ ] 6.1 W4 / M2 plan 都加"实施记录"
- [ ] 6.2 `mvp-overview.md` 把 Plan 2 状态从 "待 M1 完成" 改成 "✅ 已完成"
- [ ] 6.3 master spec §2.1 M2 加完成标记

---

## 6. 风险与开放问题

| 风险 | 严重度 | 缓解 |
|---|---|---|
| CREATE DATABASE 跨 DB，事务失败留孤儿库 | 中 | tracing 记录全部失败；超管页加一个"清理孤儿库"工具（Phase 6+） |
| pg_pool 的 admin 密码泄露 | 高 | `crypto::encrypt_secret` (AES-256-GCM)；不在任何用户视角接口返回 |
| 用户走 provision 时把 pool 撑爆（QPS / 容量） | 低 | v1 不做配额；超管在 PG 池表加 `max_databases` hint 字段，运营时手工监控 |
| 模板 DDL 改坏 → 已开通项目无影响 | 低 | 模板 DDL 只在 provision 时跑一次；改模板不回溯 |
| wizard 切到 step 5 才报错（如 slug 已被占用）| 低 | step 2 实时 debounce 校验 slug；step 5 再做最终 check |
| 普通用户能枚举所有 pg_pool host | 低 | host 在企业内网；spec §2 接受这个泄露面 |

### 开放问题（不阻塞 Phase 1 启动）

- [ ] **默认 schema 名**：新项目的 DB 里要不要预建一个 `public` 之外的 schema？v1 不做，DDL 模板里如需要自己 CREATE SCHEMA。
- [ ] **是否给新项目配 RPC 默认函数**？v1 不做，schema_handlers / rpc handlers 已经能让 owner 自己加。
- [ ] **`scenario` 字段是否做"我推荐你模板"逻辑**？v1 仅做过滤，不做推荐。

---

## 7. 验收标准

- ✅ 超管能在 `/platform/pg-pools` 加一个 PG 池条目，测试连接通过
- ✅ 普通用户登录 → `/workspace/no-projects` 点 "立即创建" → 走完 5 步 → 落到新项目首页，能直接看到 0 张表的工作空间
- ✅ 同一用户用相同 slug 二次提交 → 返回同一项目（不报错）
- ✅ 不同用户用相同 slug → 409
- ✅ 新建项目后 caller 是 owner，能在 `/settings/members` 加成员（W4 通路打通）
- ✅ `cargo build` 干净；`tsc --noEmit` 干净（除既有 TableEditor lint）
- ✅ `tests/m1_workspace_test.sh` + `tests/m1_workspace_members_test.sh` + 新加的 `tests/m2_provisioning_test.sh` 全绿

---

*本 plan 衔接 mvp-overview.md Plan 2 占位；落地后 MVP 出口距离 100% 完成只剩 M3（ER 编辑器）+ M6 完整版大盘。*

---

## 8. 实施记录

### 8.1 Commit 列表（5 phase / 5 commit）

| Phase | Commit (short) | 内容 |
|---|---|---|
| 1 | `7d6b260` | migration 018 + 4 模板 seed |
| 2 | `56b14b2` | `pg_pool_helpers.rs` + `pg_pool_handlers.rs` + 6 个 admin/user 路由 |
| 3 | `87cb550` | `/platform/pg-pools` 超管页 + `pgPoolAPI` + PlatformSidebar 入口 |
| 4 | `e00139d` | `POST /api/projects/provision` + 模板只读接口 + 7 case shell smoke |
| 5 | `59c6d78` | `/workspace/provision` 5 步 wizard + 入口（项目选择页 + no-projects） |

### 8.2 决策摘要

| 决策 | 选定方案 | 理由 |
|---|---|---|
| PG 池边界 | 严格不允许 escape hatch | 母 spec 原话；普通用户绝不接触 host/port 自填 |
| 模板范围 | v1 只做 blank，其余 3 个 is_coming_soon | 最快收口；DDL 设计留到 M3 ER 编辑器一起做 |
| 幂等键 | `(caller_user_id, slug)` | 简单、可预测；HTTP `Idempotency-Key` 留到 v2 |
| 项目 DB 凭据 | v1 复用 pool admin | 简化；M4 RBAC 完整版改成 per-project PG ROLE |

### 8.3 收尾验证

- ✅ `cargo build --bin onebase` 干净（只剩 pre-existing warnings）
- ✅ `tsc --noEmit` 干净（只剩 pre-existing TableEditor downlevelIteration 错误）
- ✅ `bash -n tests/m2_provisioning_test.sh` 语法干净
- ⏸️ `bash tests/m2_provisioning_test.sh` 需要在 live server + 可连通的 PG 上跑一次确认（本地未执行，待用户在 staging 触发）

### 8.4 已知遗留 / 留给后续模块

1. **孤儿库清理**：CREATE DATABASE 跨连接事务做不掉。成功建库但写 management 表失败时，PG 那台机器上留下空库。v1 用 tracing 记录 + 平台超管手工 `DROP DATABASE`；后续可在 `/platform/pg-pools` 加个"清理孤儿库"工具，或者引入 outbox / saga 模式。
2. **`failed_provisioning` 状态**：模板 DDL 失败的项目 status 会被标为 `failed_provisioning`，但前端目前没特别 UI 区分——下次项目列表加 status 字段过滤 / 警告角标。
3. **PG ROLE per project**：v1 决定项目库凭据复用 pool admin，等于把根权限给到了项目库的 connection。M4 RBAC 完整版要改成 provision 时 `CREATE USER ...` 并在 `tenant_databases` 写入业务账号。
4. **`/api/admin/pg-pools` 缺 GET :id**：超管要单查一条池只能 list 全量后过滤；列表小时无碍，但生产环境上千条时需要补单查端点。
5. **wizard 数据持久化**：用户在 step 4 刷新页面，前 3 步的输入全丢。v1 用户体验上接受（5 步流程不长）；如果要做也可以塞 sessionStorage。
6. **`coming_soon` 模板的"敬请期待"实现**：M3 ER 编辑器落地后，应该把 blog/tasks/community 三个模板的 DDL 用 ER 自带格式写出来，再切回 `is_coming_soon=false`。这是 M3 主要范畴。

