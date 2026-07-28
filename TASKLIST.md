# OneBase 开发任务清单

> 基于 [VISION.md](./VISION.md) 拆解的可执行任务列表。每个任务标注预估工时和依赖关系。
> 状态标记：⬜ 待做 | 🔵 进行中 | ✅ 已完成 | ⏸️ 阻塞

---

## Phase 1: RBAC 权限引擎 🔴 最高优先级

> **目标**：用应用层 RBAC 替代 Supabase 的 RLS，实现可缓存、可横向扩展的权限体系。
> **前置条件**：无，在现有代码基础上直接开始。

### 1.1 数据库层

- ⬜ **1.1.1** 创建 RBAC 数据表迁移脚本 `migrations/001_rbac.sql`
  - `management.roles` — 角色表（id, tenant_id, name, description, is_system, created_at）
  - `management.permissions` — 权限表（id, tenant_id, resource, action, conditions, allowed_columns, denied_columns, description）
  - `management.role_permissions` — 角色-权限关联（role_id, permission_id）
  - `management.user_roles` — 用户-角色关联（user_id, role_id, tenant_id）
  - 系统预设角色种子数据：`superadmin`, `admin`, `editor`, `viewer`
  - 索引：role_permissions 联合索引、user_roles(user_id, tenant_id) 索引
  - **工时**：1h

- ⬜ **1.1.2** 创建迁移二进制 `src/bin/migrate_rbac.rs`
  - 读取并执行 `migrations/001_rbac.sql`
  - 支持幂等执行（IF NOT EXISTS）
  - **工时**：0.5h
  - **依赖**：1.1.1

### 1.2 后端模型层

- ⬜ **1.2.1** 新增 `src/rbac_models.rs` — RBAC 数据结构
  - `Role` struct（对应 management.roles）
  - `Permission` struct（对应 management.permissions，含 conditions/columns 解析）
  - `UserRole` struct
  - `PermissionCheck` — 权限校验请求（user_id, tenant_id, resource, action）
  - `PermissionResult` — 校验结果（allowed, row_conditions, allowed_columns）
  - **工时**：1h

### 1.3 后端 API 层

- ⬜ **1.3.1** 新增 `src/rbac_handlers.rs` — 角色管理 API
  - `GET    /api/rbac/roles`             — 列出当前租户的角色
  - `POST   /api/rbac/roles`             — 创建角色
  - `PATCH  /api/rbac/roles/:id`         — 更新角色
  - `DELETE /api/rbac/roles/:id`         — 删除角色（禁删系统角色）
  - `GET    /api/rbac/roles/:id/permissions` — 获取角色的权限列表
  - `PUT    /api/rbac/roles/:id/permissions` — 设置角色的权限（全量替换）
  - **工时**：2h
  - **依赖**：1.1.1, 1.2.1

- ⬜ **1.3.2** 权限配置 API（续）
  - `GET    /api/rbac/permissions`       — 列出当前租户的权限定义
  - `POST   /api/rbac/permissions`       — 创建权限定义
  - `PATCH  /api/rbac/permissions/:id`   — 更新权限（含 conditions、columns）
  - `DELETE /api/rbac/permissions/:id`   — 删除权限
  - **工时**：1.5h
  - **依赖**：1.2.1

- ⬜ **1.3.3** 用户角色分配 API
  - `GET    /api/rbac/users/:user_id/roles`           — 查看用户角色
  - `POST   /api/rbac/users/:user_id/roles`           — 给用户分配角色
  - `DELETE /api/rbac/users/:user_id/roles/:role_id`  — 移除用户角色
  - **工时**：1h
  - **依赖**：1.3.1

### 1.4 权限校验中间件（核心）

- ⬜ **1.4.1** 新增 `src/rbac_middleware.rs` — RBAC 校验中间件
  - 实现 `rbac_middleware` 函数：
    1. 从请求扩展提取 `Claims`（user_id）
    2. 从路径提取 `schema.table`（resource）
    3. 从 HTTP Method 映射 action（GET→SELECT, POST→INSERT...）
    4. 查询 DB：user_roles → role_permissions → permissions
    5. 将 `PermissionResult` 注入请求扩展
  - 无权限时返回 403 Forbidden
  - **工时**：2h
  - **依赖**：1.2.1

- ⬜ **1.4.2** Auto API 集成权限校验
  - 修改 `src/auto_api_handlers.rs`：
    1. 从请求扩展读取 `PermissionResult`
    2. 行过滤：将 `conditions` 追加到 WHERE 子句
    3. 列过滤：SELECT 时只取 `allowed_columns`
    4. INSERT/UPDATE 时校验提交的字段是否在允许范围内
  - **工时**：3h
  - **依赖**：1.4.1

- ⬜ **1.4.3** 将 RBAC 中间件挂载到 Auto API 路由
  - 修改 `src/main.rs`：auto_api_routes 添加 `rbac_middleware` 层
  - 在 `auth_middleware` 之后、handler 之前执行
  - **工时**：0.5h
  - **依赖**：1.4.1, 1.4.2

### 1.5 前端：权限管理界面

- ⬜ **1.5.1** 角色管理页面 `frontend-nextjs/app/dashboard/roles/page.tsx`
  - 角色列表（名称、描述、关联权限数、用户数）
  - 创建/编辑角色弹窗
  - 删除角色（含确认）
  - **工时**：3h
  - **依赖**：1.3.1

- ⬜ **1.5.2** 权限配置页面 `frontend-nextjs/app/dashboard/rls/page.tsx`
  - 权限列表（resource、action、conditions、columns）
  - 可视化编辑权限条件（表单而非写 SQL）
  - 列选择器（从表结构元数据获取列名）
  - **工时**：4h
  - **依赖**：1.3.2

- ⬜ **1.5.3** 前端 API 层扩展 `frontend-nextjs/lib/api.ts`
  - 添加 `rbacAPI`：roles CRUD、permissions CRUD、user-role 管理
  - **工时**：0.5h
  - **依赖**：1.3.1, 1.3.2, 1.3.3

---

## Phase 2: Redis 集成 🔴 高优先级

> **目标**：引入 Redis 做权限缓存、查询缓存、会话管理和限流。
> **前置条件**：Phase 1 完成（权限数据存在后才有缓存意义）。

### 2.1 基础集成

- ⬜ **2.1.1** 添加 Redis 依赖
  - `Cargo.toml` 添加 `redis = { version = "0.25", features = ["tokio-comp", "cluster-async"] }`
  - **工时**：0.5h

- ⬜ **2.1.2** 新增 `src/redis_manager.rs` — Redis 连接管理
  - `RedisConfig` struct（mode: standalone/sentinel/cluster, urls, password）
  - `Config` 扩展：添加 `REDIS_URL`、`REDIS_MODE` 环境变量
  - `RedisManager` 封装：根据 mode 创建不同客户端
  - 连接健康检查
  - 作为 Axum State 注入
  - **工时**：2h
  - **依赖**：2.1.1

- ⬜ **2.1.3** 修改 `src/main.rs` — 初始化 Redis 并注入 State
  - 启动时创建 RedisManager
  - 将 `(PgPool, RedisManager)` 作为 AppState 注入（需重构 State 类型）
  - **工时**：1.5h
  - **依赖**：2.1.2

### 2.2 权限缓存

- ⬜ **2.2.1** 新增 `src/permission_cache.rs`
  - key 格式：`rbac:{tenant_id}:{user_id}` → 序列化的权限集合
  - `get_permissions(user_id, tenant_id)` → 先查 Redis，miss 则查 DB 并写入
  - `invalidate_user(user_id, tenant_id)` → 删除单用户缓存
  - `invalidate_role(role_id)` → 删除该角色下所有用户的缓存
  - TTL：5 分钟
  - **工时**：2h
  - **依赖**：2.1.2, Phase 1 完成

- ⬜ **2.2.2** RBAC 中间件接入缓存
  - 修改 `src/rbac_middleware.rs`：权限查询优先走 Redis
  - RBAC handlers 写操作后调用 `invalidate_*` 清缓存
  - **工时**：1h
  - **依赖**：2.2.1

### 2.3 查询结果缓存

- ⬜ **2.3.1** 新增 `src/query_cache.rs`
  - key 格式：`cache:{db_id}:{schema}:{table}:{hash(params+permissions)}`
  - 仅缓存 GET 请求结果
  - TTL 可按表配置（默认 60s，后续可在管理面板配）
  - **工时**：1.5h
  - **依赖**：2.1.2

- ⬜ **2.3.2** Auto API 读路径接入查询缓存
  - `list_records` / `get_record` → 先查缓存
  - **工时**：1h
  - **依赖**：2.3.1

- ⬜ **2.3.3** Auto API 写路径自动失效缓存
  - `create_record` / `update_record` / `delete_record` → 清除 `cache:{db_id}:{schema}:{table}:*`
  - **工时**：1h
  - **依赖**：2.3.1

### 2.4 限流

- ⬜ **2.4.1** 新增 `src/rate_limiter.rs`
  - 滑动窗口算法（Redis ZSET）
  - 可按 tenant / user / IP 分别限流
  - 配置：`RATE_LIMIT_PER_MINUTE` 环境变量
  - **工时**：2h
  - **依赖**：2.1.2

- ⬜ **2.4.2** 限流中间件挂载
  - 创建 `rate_limit_middleware`，挂在 Gateway 层（auto_api_routes 之前）
  - 返回 429 Too Many Requests + Retry-After header
  - **工时**：1h
  - **依赖**：2.4.1

---

## Phase 3: SSO / 社交登录 🟡 中优先级

> **目标**：支持 Google、Facebook、GitHub 等第三方登录。
> **前置条件**：Phase 1 (RBAC) 完成，新用户需自动分配默认角色。

### 3.1 数据库层

- ⬜ **3.1.1** 创建 SSO 相关表迁移 `migrations/002_sso.sql`
  - `management.sso_providers` — 租户 SSO 配置（provider, client_id, client_secret_encrypted, redirect_uri, tenant_id）
  - `management.user_sso_links` — 用户 SSO 绑定（user_id, provider, provider_user_id, email, profile_data）
  - 扩展 `users` 表：添加 `avatar_url`, `display_name` 字段（可选）
  - **工时**：1h

### 3.2 后端 OAuth2 框架

- ⬜ **3.2.1** 添加 OAuth2 依赖
  - `Cargo.toml` 添加 `reqwest` (HTTP 客户端), `url` (URL 解析)
  - **工时**：0.5h

- ⬜ **3.2.2** 新增 `src/sso.rs` — OAuth2 核心逻辑
  - `SsoProvider` trait：`authorization_url()`, `exchange_code()`, `get_user_profile()`
  - `GoogleProvider` 实现
  - `FacebookProvider` 实现
  - `GitHubProvider` 实现
  - **工时**：3h
  - **依赖**：3.2.1

- ⬜ **3.2.3** 新增 `src/sso_handlers.rs` — SSO API 端点
  - `GET  /auth/sso/:provider/authorize`  — 生成授权 URL，重定向到第三方
  - `GET  /auth/sso/:provider/callback`   — 接收回调，换 token，创建/查找用户，签发 JWT
  - `GET  /auth/sso/providers`            — 列出当前租户启用的 SSO provider
  - `POST /auth/sso/link`                 — 将当前登录用户绑定到 SSO 账号
  - `DELETE /auth/sso/link/:provider`     — 解绑 SSO 账号
  - **工时**：3h
  - **依赖**：3.2.2, 3.1.1

- ⬜ **3.2.4** SSO 管理 API（管理员配置 provider）
  - `GET    /api/admin/sso/providers`         — 列出 SSO 配置
  - `POST   /api/admin/sso/providers`         — 添加 SSO provider 配置
  - `PATCH  /api/admin/sso/providers/:id`     — 更新配置
  - `DELETE /api/admin/sso/providers/:id`     — 删除配置
  - **工时**：1.5h
  - **依赖**：3.1.1

### 3.3 前端

- ⬜ **3.3.1** 登录页面添加 SSO 按钮 `frontend-nextjs/app/login/page.tsx`
  - Google / Facebook / GitHub 登录按钮
  - 点击跳转 `/auth/sso/:provider/authorize`
  - 回调处理：从 URL 获取 JWT，存入 localStorage
  - **工时**：2h
  - **依赖**：3.2.3

- ⬜ **3.3.2** SSO 管理页面（管理员）
  - 配置 Client ID / Secret
  - 启用/禁用 provider
  - **工时**：2h
  - **依赖**：3.2.4

---

## Phase 4: PostgreSQL 横向扩展 🟡 中优先级

> **目标**：支持读写分离，让 SELECT 自动路由到只读副本。
> **前置条件**：Phase 2 (Redis) 完成，缓存 + 读写分离联合降低 Primary 压力。

### 4.1 连接池重构

- ⬜ **4.1.1** 重构 `src/pool_manager.rs` — 支持 Primary + Replica
  - `DatabaseConfig` 扩展：`replicas: Vec<ReplicaConfig>`
  - `PoolManager` 扩展：每个 database_id 维护 `primary_pool` + `replica_pools`
  - `get_read_pool(db_id)` → 从 replica_pools 中轮询选择
  - `get_write_pool(db_id)` → 返回 primary_pool
  - **工时**：3h

- ⬜ **4.1.2** 扩展 `management.tenant_databases` 表
  - 添加 `role` 字段：`primary` / `replica`
  - 添加 `primary_id` 字段：replica 指向其 primary
  - 迁移脚本 `migrations/003_read_replicas.sql`
  - **工时**：1h

- ⬜ **4.1.3** Auto API 读写分离
  - 修改 `src/auto_api_handlers.rs`：
    - `list_records` / `get_record` → `get_read_pool()`
    - `create_record` / `update_record` / `delete_record` → `get_write_pool()`
  - **工时**：1.5h
  - **依赖**：4.1.1

- ⬜ **4.1.4** 动态中间件适配
  - 修改 `src/middleware.rs` 的 `dynamic_db_middleware`：区分读写池
  - **工时**：1h
  - **依赖**：4.1.1

### 4.2 前端

- ⬜ **4.2.1** 连接管理页面支持 Replica 配置
  - 添加连接时可选 role（Primary / Replica）
  - Replica 需绑定 Primary
  - 连接状态面板显示主从拓扑
  - **工时**：2h
  - **依赖**：4.1.2

---

## Phase 5: 消息通知系统 🟢 常规优先级

> **目标**：数据变更时自动触发 Webhook、WebSocket 推送、消息队列。
> **前置条件**：Phase 2 (Redis) 完成（Redis Stream 作为消息队列）。

### 5.1 事件系统

- ⬜ **5.1.1** 新增 `src/events.rs` — 事件定义与分发
  - `DataChangeEvent` struct：tenant_id, db_id, schema, table, action, old_data, new_data, user_id, timestamp
  - `EventBus` trait：`publish(event)`
  - 基于 tokio broadcast channel 的进程内事件总线
  - **工时**：1.5h

- ⬜ **5.1.2** Auto API 集成事件发布
  - 写操作（INSERT/UPDATE/DELETE）成功后 publish DataChangeEvent
  - **工时**：1h
  - **依赖**：5.1.1

### 5.2 Webhook

- ⬜ **5.2.1** 创建 Webhook 表 `migrations/004_webhooks.sql`
  - `management.webhooks`：tenant_id, event_pattern, url, headers, retry_count, is_active
  - **工时**：0.5h

- ⬜ **5.2.2** 新增 `src/webhook_manager.rs`
  - 监听 EventBus → 匹配 event_pattern → 异步 HTTP 回调
  - 指数退避重试
  - 执行日志记录
  - **工时**：2h
  - **依赖**：5.1.1, 5.2.1

- ⬜ **5.2.3** Webhook 管理 API
  - CRUD: `/api/admin/webhooks`
  - 测试 Webhook: `POST /api/admin/webhooks/:id/test`
  - **工时**：1.5h
  - **依赖**：5.2.1

### 5.3 WebSocket 实时推送

- ⬜ **5.3.1** 新增 `src/realtime.rs` — WebSocket 管理
  - `GET /realtime/ws` → WebSocket 升级
  - 客户端订阅格式：`{ "subscribe": "public.posts" }`
  - 服务端推送：`{ "event": "INSERT", "table": "public.posts", "data": {...} }`
  - 使用 tokio broadcast channel 做订阅分发
  - **工时**：3h
  - **依赖**：5.1.1

- ⬜ **5.3.2** WebSocket 认证
  - 连接时通过 URL query 传递 JWT：`/realtime/ws?token=xxx`
  - 订阅时校验 RBAC 权限（需要对该表有 SELECT 权限才能订阅）
  - **工时**：1h
  - **依赖**：5.3.1, Phase 1

---

## Phase 6: 日志与审计 🟢 常规优先级

> **目标**：全链路结构化日志，支持审计追溯。
> **前置条件**：Phase 5 (事件系统) 中的 EventBus 可复用。

### 6.1 审计日志

- ⬜ **6.1.1** 创建审计日志表 `migrations/005_audit_log.sql`
  - `management.audit_logs`：id, tenant_id, user_id, action, resource, request_method, request_path, request_body(JSONB), response_status, ip_address, user_agent, duration_ms, created_at
  - 按月分区（可选）
  - **工时**：1h

- ⬜ **6.1.2** 新增 `src/audit_middleware.rs` — 审计日志中间件
  - 记录所有写操作（POST/PATCH/DELETE）
  - 异步写入，不阻塞主请求
  - **工时**：2h
  - **依赖**：6.1.1

- ⬜ **6.1.3** 审计日志查询 API
  - `GET /api/admin/audit-logs` — 分页查询，支持按时间/用户/表/操作过滤
  - **工时**：1h
  - **依赖**：6.1.1

### 6.2 慢查询追踪

- ⬜ **6.2.1** Auto API 请求耗时记录
  - 在 auto_api_handlers 中记录每次查询的 SQL + 耗时
  - 超过阈值（如 500ms）的自动标记为慢查询
  - **工时**：1h

- ⬜ **6.2.2** 慢查询日志 API
  - `GET /api/admin/slow-queries` — 查看慢查询列表
  - **工时**：0.5h
  - **依赖**：6.2.1

### 6.3 前端

- ⬜ **6.3.1** 审计日志面板 `frontend-nextjs/app/dashboard/audit/page.tsx`
  - 日志列表 + 高级筛选
  - **工时**：3h
  - **依赖**：6.1.3

---

## Phase 7: 网关增强 🟢 常规优先级

> **目标**：精细化流量控制与 API 管理。
> **前置条件**：Phase 2 (Redis 限流) 已有基础。

- ⬜ **7.1** 精细化限流配置
  - 支持在管理面板按 tenant/user/endpoint 配置限流规则
  - 规则存储在 `management.rate_limit_rules` 表
  - **工时**：2h
  - **依赖**：Phase 2

- ⬜ **7.2** 熔断降级
  - 当后端 DB 连续超时时自动触发熔断
  - 返回 503 + 降级响应
  - 自动恢复（半开状态探测）
  - **工时**：2h

- ⬜ **7.3** API 版本管理
  - 支持 `/api/v2/` 路由前缀
  - 版本路由策略配置
  - **工时**：1h

---

## 总览：工时与里程碑

| Phase | 名称 | 任务数 | 预估总工时 | 里程碑标志 |
|-------|------|--------|-----------|-----------|
| **1** | RBAC 权限引擎 | 13 | ~20h | Auto API 按角色权限返回不同数据 |
| **2** | Redis 集成 | 10 | ~14h | 查询结果缓存命中、限流生效 |
| **3** | SSO 社交登录 | 8 | ~13h | 用 Google 账号登录并访问 API |
| **4** | PG 横向扩展 | 5 | ~8.5h | SELECT 自动路由到 Replica |
| **5** | 消息通知 | 7 | ~10.5h | 数据变更触发 Webhook 回调 |
| **6** | 日志审计 | 6 | ~8.5h | 管理面板查看操作日志 |
| **7** | 网关增强 | 3 | ~5h | 按配置限流和熔断 |
| **合计** | | **52** | **~80h** | |

---

## 执行顺序建议

```
Phase 1 (RBAC)
  │
  ├──→ Phase 2 (Redis)
  │      │
  │      ├──→ Phase 4 (PG 扩展)
  │      │
  │      └──→ Phase 5 (通知) ──→ Phase 6 (日志)
  │
  └──→ Phase 3 (SSO)
                                   Phase 7 (网关) ← Phase 2 完成后可并行
```

**推荐立即开始**：Phase 1.1.1 → 1.2.1 → 1.3.1 → 1.4.1 → 1.4.2，这是从 DB 表到权限中间件的最短路径。
