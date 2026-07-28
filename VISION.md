# OneBase — 产品架构愿景

> **一句话定位**：面向百万级用户互联网产品的**零代码数据网关**——开发者只需设计数据库表结构，即可获得完整的 CRUD API、RBAC 鉴权、缓存、消息通知、日志与网关管理能力，无需编写任何业务读写代码。

---

## 一、为什么不是 Supabase

Supabase 是优秀的开源 BaaS，但它的核心设计存在**无法通过补丁修复的结构性缺陷**：

| 问题 | 根因 | 后果 |
|------|------|------|
| **RLS 策略爆炸** | 鉴权逻辑用 SQL 表达式写在 Postgres 策略里 | 几十张表 × 多种角色 → 数百条 Policy，无法维护 |
| **性能天花板** | 每次请求都要 `SET LOCAL role`、注入 JWT claims、走 Postgres 执行计划检查 Policy | 高并发下 Postgres CPU 被鉴权逻辑吃满，无法横向扩展 |
| **权限模型僵化** | 只有 `anon` / `authenticated` 两种 Postgres role，复杂业务靠堆 Policy | 无法表达"管理员 A 只能编辑自己部门的数据"这类动态条件 |
| **认证与数据耦合** | GoTrue 是独立服务，JWT 要通过 PostgREST 注入 Postgres session | 无法统一管控，SSO 扩展困难 |
| **无法横向扩展** | 单 Postgres 实例，无原生读写分离 / 分片 | 不适合百万级用户 |
| **无缓存层** | 所有读请求直达数据库 | 热点数据重复查询，浪费资源 |

**OneBase 的回答**：把鉴权、缓存、通知、网关、日志全部上提到**应用层**，让 Postgres 只做它最擅长的事——**存储和查询数据**。

---

## 二、核心理念

```
┌──────────────────────────────────────────────────────────────────┐
│                  开发者只需做一件事：设计表结构                      │
│                                                                  │
│  CREATE TABLE posts (                                            │
│    id         BIGSERIAL PRIMARY KEY,                             │
│    author_id  BIGINT REFERENCES users(id),                       │
│    title      TEXT NOT NULL,                                     │
│    content    TEXT,                                               │
│    status     VARCHAR(20) DEFAULT 'draft',                       │
│    created_at TIMESTAMPTZ DEFAULT now()                          │
│  );                                                              │
│                                                                  │
│  → 自动获得：REST API + RBAC 权限 + 缓存 + 日志 + 通知           │
│  → 无需编写任何业务读写代码                                        │
└──────────────────────────────────────────────────────────────────┘
```

### 五大核心服务

| # | 服务 | 职责 | 关键特性 |
|---|------|------|----------|
| 1 | **鉴权服务 (Auth)** | 身份认证 + RBAC 授权 | 注册/登录、JWT、SSO (Google/Facebook/GitHub)、RBAC 角色-权限-资源模型、应用层权限校验（可缓存、可横向扩展） |
| 2 | **消息通知 (Notification)** | 事件驱动的消息推送 | 数据变更事件、Webhook、WebSocket 实时推送、邮件/短信通知、消息队列 |
| 3 | **缓存管理 (Cache)** | 智能缓存层 | Redis / Redis Cluster、查询结果缓存、权限缓存、自动失效策略、缓存预热 |
| 4 | **网关管理 (Gateway)** | API 网关与流量治理 | 路由管理、限流/熔断、API Key 管理、请求转发、多租户路由、负载均衡 |
| 5 | **日志管理 (Logging)** | 全链路可观测性 | 请求日志、审计日志、慢查询追踪、操作回溯、结构化日志 |

### 一个不变量

> **对数据库的读写操作走框架的 Auto API，开发者不需要写任何代码。**
>
> OneBase 的 Auto API 根据数据库元数据（表、列、外键、约束）自动生成 CRUD 端点。开发者通过**配置**而非**编码**来控制访问行为：
> - 谁可以访问？→ RBAC 角色配置
> - 哪些字段可见？→ 列级权限配置
> - 哪些行可见？→ 行级过滤条件配置
> - 需要缓存吗？→ 缓存策略配置
> - 需要通知吗？→ 事件订阅配置

---

## 三、系统架构

```
                          ┌─────────────────────┐
                          │     客户端应用       │
                          │  Web / Mobile / API  │
                          └──────────┬──────────┘
                                     │ HTTPS
                          ┌──────────▼──────────┐
                          │    API Gateway 层    │
                          │                      │
                          │  · 路由分发           │
                          │  · 限流 / 熔断        │
                          │  · API Key 校验       │
                          │  · 请求日志           │
                          └──────────┬──────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
    ┌─────────▼─────────┐ ┌─────────▼─────────┐ ┌─────────▼─────────┐
    │    Auth 服务       │ │   Auto API 服务    │ │  管理控制台 API    │
    │                    │ │                    │ │                    │
    │ · 注册 / 登录      │ │ · GET  (查询)      │ │ · 租户管理         │
    │ · JWT 签发/验证    │ │ · POST (创建)      │ │ · 角色/权限配置    │
    │ · SSO OAuth2      │ │ · PATCH(更新)      │ │ · 缓存策略配置     │
    │ · RBAC 权限校验    │ │ · DELETE(删除)     │ │ · 日志查看         │
    │ · 密码重置        │ │ · 自动 JOIN        │ │ · 监控面板         │
    │ · MFA (可选)      │ │ · 事务             │ │                    │
    └─────────┬─────────┘ └─────────┬─────────┘ └─────────┬─────────┘
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
          ┌─────────▼──────┐ ┌──────▼───────┐ ┌─────▼──────────┐
          │  Redis Cluster │ │  PostgreSQL  │ │   日志存储      │
          │                │ │   Cluster    │ │                 │
          │ · 会话缓存     │ │              │ │ · 请求日志      │
          │ · 查询缓存     │ │  ┌────────┐  │ │ · 审计日志      │
          │ · 权限缓存     │ │  │ Primary │  │ │ · 慢查询日志    │
          │ · 限流计数     │ │  └───┬────┘  │ │                 │
          │ · 消息队列     │ │      │       │ │ (可选外部:      │
          │                │ │  ┌───▼────┐  │ │  Elasticsearch  │
          │  可横向扩展:    │ │  │Replica │  │ │  / ClickHouse)  │
          │  · Sentinel    │ │  │ (N个)  │  │ │                 │
          │  · Cluster     │ │  └────────┘  │ └─────────────────┘
          └────────────────┘ │              │
                             │  可横向扩展:  │
                             │  · 读写分离   │
                             │  · Citus 分片 │
                             │  · PgBouncer  │
                             └──────────────┘
```

---

## 四、鉴权体系设计：RBAC 替代 RLS

### 4.1 数据模型

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│  users   │────→│ role_assign- │────→│    roles     │
│          │     │   ments      │     │              │
│ id       │     │              │     │ id           │
│ email    │     │ user_id      │     │ name         │
│ password │     │ role_id      │     │ description  │
│ ...      │     │ tenant_id    │     │ tenant_id    │
└──────────┘     └──────────────┘     └──────┬───────┘
                                             │
                                      ┌──────▼───────┐     ┌──────────────┐
                                      │ role_permis- │────→│ permissions  │
                                      │   sions      │     │              │
                                      │              │     │ id           │
                                      │ role_id      │     │ resource     │
                                      │ permission_id│     │ action       │
                                      └──────────────┘     │ conditions   │
                                                           │ columns      │
                                                           └──────────────┘
```

### 4.2 权限粒度

```yaml
permission:
  resource: "public.posts"          # schema.table
  action: "SELECT"                  # SELECT / INSERT / UPDATE / DELETE
  conditions:                       # 行级过滤（应用层注入 WHERE 条件）
    - "author_id = :current_user_id"
    - "status IN ('published', 'draft')"
  allowed_columns:                  # 列级过滤
    - "id"
    - "title"
    - "content"
    - "created_at"
  denied_columns:                   # 不可见字段
    - "internal_notes"
```

### 4.3 请求鉴权流程

```
请求进入
  │
  ▼
[Gateway] → 解析 API Key / JWT
  │
  ▼
[Auth] → Redis 查询权限缓存 ──命中──→ 返回权限集合
  │                                         │
  缓存未命中                                 │
  │                                         │
  ▼                                         │
  查询 DB: user → roles → permissions       │
  │                                         │
  写入 Redis 缓存 (TTL: 5min)               │
  │                                         │
  ▼                                         ▼
[Auto API] → 注入行过滤条件 + 列过滤 → 执行查询 → 返回结果
```

**与 Supabase RLS 的本质区别**：
- 权限判定在**应用层**完成，不是 Postgres 内部
- 权限数据**可缓存**到 Redis，不需要每次查库
- OneBase 实例**可横向扩展**，多实例共享 Redis 缓存
- 权限变更**热生效**：更新 DB → 清 Redis 缓存 → 下次请求自动加载新权限

### 4.4 SSO / 社交登录

```
┌─────────┐    OAuth2 Authorization Code Flow    ┌──────────────┐
│  用户    │ ──────────────────────────────────→ │ Google / FB  │
│         │ ←── authorization_code ──────────── │ / GitHub     │
└────┬────┘                                      └──────────────┘
     │
     │ POST /auth/sso/callback?code=xxx&provider=google
     │
     ▼
┌──────────────────────────────────────┐
│          OneBase Auth              │
│                                      │
│  1. 用 code 换 access_token          │
│  2. 获取用户 profile (email, name)   │
│  3. 查找或创建本地用户               │
│  4. 绑定 SSO provider               │
│  5. 签发 OneBase JWT              │
│  6. 自动分配默认角色                 │
└──────────────────────────────────────┘
```

支持的 Provider（可扩展）：
- Google (OpenID Connect)
- Facebook (OAuth2)
- GitHub (OAuth2)
- 自定义 OIDC Provider

---

## 五、横向扩展设计

### 5.1 PostgreSQL 横向扩展

```
                    ┌─────────────────────────────────┐
                    │         PgBouncer 连接池         │
                    │   (减少 PG 连接数，复用连接)      │
                    └────────────┬────────────────────┘
                                 │
                 ┌───────────────┼───────────────┐
                 │               │               │
          ┌──────▼──────┐ ┌─────▼──────┐ ┌──────▼──────┐
          │  Primary    │ │ Replica 1  │ │ Replica N  │
          │  (读写)     │ │ (只读)     │ │ (只读)     │
          └──────┬──────┘ └────────────┘ └────────────┘
                 │
          流复制 (Streaming Replication)
```

**扩展策略**：

| 阶段 | 方案 | 适用规模 |
|------|------|----------|
| **阶段 1** | 单主 + 多只读副本 + PgBouncer | 10 万用户 |
| **阶段 2** | Citus 分布式扩展（分片） | 100 万用户 |
| **阶段 3** | 多区域部署 + 跨区域复制 | 1000 万用户 |

**OneBase 的实现**：
- `PoolManager` 维护 `Primary` 和 `Replica[]` 两组连接池
- Auto API 的 `SELECT` 请求自动路由到 Replica（负载均衡）
- `INSERT/UPDATE/DELETE` 请求路由到 Primary
- 支持通过配置动态增减 Replica

### 5.2 Redis 横向扩展

```
                    ┌──────────────────────────────┐
                    │     OneBase Redis 客户端    │
                    │  (支持 Standalone / Sentinel  │
                    │   / Cluster 三种模式)         │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
     ┌────────▼────────┐  ┌───────▼───────┐  ┌────────▼────────┐
     │  模式 1:        │  │  模式 2:      │  │  模式 3:        │
     │  Standalone     │  │  Sentinel     │  │  Cluster        │
     │  (开发/小规模)  │  │  (高可用)     │  │  (大规模)       │
     │                 │  │               │  │                 │
     │  单节点 Redis   │  │  主从自动切换 │  │  数据自动分片   │
     │                 │  │  读写分离     │  │  线性扩展       │
     └─────────────────┘  └───────────────┘  └─────────────────┘
```

**缓存分层**：

| 层级 | 数据 | TTL | 失效策略 |
|------|------|-----|----------|
| L1: 权限缓存 | 用户角色、权限集合 | 5 min | 权限变更时主动清除 |
| L2: 查询缓存 | Auto API 查询结果 | 可配置 | 写操作自动失效相关表缓存 |
| L3: 会话缓存 | JWT refresh token、SSO state | 会话时长 | 登出/过期自动清除 |
| L4: 限流计数 | API 调用频率 | 滑动窗口 | 自动过期 |
| L5: 通知队列 | 待发送消息 | 处理即删 | 消费后删除 |

---

## 六、Auto API 工作流（零代码核心）

### 6.1 请求完整链路

```
Client Request
  │
  │  GET /api/v1/{db_id}/public/posts?status=published&order=created_at.desc&limit=20
  │  Authorization: Bearer <jwt>
  │
  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Gateway 层                                                       │
│    · 限流检查 (Redis INCR + TTL)                                    │
│    · API Key / JWT 解析                                             │
│    · 请求日志记录                                                    │
├─────────────────────────────────────────────────────────────────────┤
│ 2. Auth 层                                                          │
│    · 从 Redis 加载权限缓存                                          │
│    · 校验: 用户对 public.posts 是否有 SELECT 权限                    │
│    · 提取: 行过滤条件 (conditions) + 可见列 (allowed_columns)        │
├─────────────────────────────────────────────────────────────────────┤
│ 3. Cache 层                                                         │
│    · 生成缓存 Key: hash(db_id, schema, table, user_permissions,     │
│                         query_params)                                │
│    · 查询 Redis → 命中则直接返回                                     │
├─────────────────────────────────────────────────────────────────────┤
│ 4. Query Builder                                                    │
│    · 解析 URL 参数 → 结构化 QueryParams                             │
│    · 注入权限行过滤条件到 WHERE                                      │
│    · 列过滤: 只 SELECT 允许的列                                      │
│    · 生成参数化 SQL:                                                 │
│      SELECT id, title, content, created_at                          │
│      FROM "public"."posts"                                          │
│      WHERE "status" = $1                                            │
│        AND "author_id" = $2  ← 权限注入                             │
│      ORDER BY "created_at" DESC                                     │
│      LIMIT $3                                                       │
├─────────────────────────────────────────────────────────────────────┤
│ 5. Database 层                                                      │
│    · SELECT 请求 → 路由到 Replica (只读副本)                         │
│    · 执行查询，返回结果                                              │
├─────────────────────────────────────────────────────────────────────┤
│ 6. Post-processing                                                  │
│    · 结果写入 Redis 缓存 (按配置的 TTL)                              │
│    · 记录审计日志                                                    │
│    · 触发通知事件 (如果配置了 Webhook)                                │
│    · 返回 JSON 响应                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.2 写操作的缓存失效

```
Client: POST /api/v1/{db_id}/public/posts
  │
  ▼
[Auth] → 校验 INSERT 权限
  │
  ▼
[Database] → INSERT INTO "public"."posts" ... (路由到 Primary)
  │
  ▼
[Cache] → 清除 key pattern: "cache:{db_id}:public:posts:*"
  │
  ▼
[Notification] → 触发事件: "public.posts.INSERT"
  │               · Webhook 回调
  │               · WebSocket 推送给订阅者
  │               · 消息队列入队
  │
  ▼
[Logging] → 审计日志: who, what, when, where
```

---

## 七、多租户模型

```
Platform (OneBase 实例)
  │
  ├── Tenant A (公司 A)
  │     ├── Database Connection 1 (生产库)
  │     │     ├── Schema: public
  │     │     ├── Schema: billing
  │     │     └── Schema: analytics
  │     ├── Database Connection 2 (测试库)
  │     ├── Roles: [admin, editor, viewer, api_consumer]
  │     ├── Users: [user1 → admin, user2 → editor, ...]
  │     ├── API Keys: [key1 → database1, key2 → database2]
  │     └── Cache/Notification/Log 配置 (独立)
  │
  ├── Tenant B (公司 B)
  │     └── ...
  │
  └── Superadmin
        ├── 管理所有 Tenant
        ├── 全局配置
        └── 系统监控
```

---

## 八、技术栈

| 层 | 技术 | 选型理由 |
|----|------|----------|
| **语言** | Rust | 零成本抽象、内存安全、极致性能 |
| **HTTP 框架** | Axum + Tower | 异步、模块化中间件、Tokio 生态 |
| **数据库驱动** | SQLx | 编译期 SQL 检查、异步、连接池 |
| **数据库** | PostgreSQL | 最强关系型数据库，支持 JSONB、FTS、PostGIS |
| **PG 扩展** | Citus (可选) | 横向分片 |
| **连接池代理** | PgBouncer (可选) | 减少 PG 连接数，提升并发 |
| **缓存** | Redis / Redis Cluster | 高性能 KV、原生集群支持 |
| **认证** | jsonwebtoken + bcrypt | JWT 签发验证、密码哈希 |
| **SSO** | OAuth2 / OIDC | Google、Facebook、GitHub 等 |
| **前端** | Next.js (App Router) | 管理控制台 |
| **状态管理** | Zustand | 轻量、简洁 |

---

## 九、与竞品的差异化对比

| 能力 | Supabase | Firebase | Hasura | **OneBase** |
|------|----------|----------|--------|---------------|
| 数据库 CRUD | PostgREST (Haskell) | 私有协议 | GraphQL | **Rust Auto API** (极致性能) |
| 鉴权方式 | RLS (Postgres 内) | Firebase Auth Rules | JWT + Webhook | **应用层 RBAC** (可缓存、可扩展) |
| 行级权限 | SQL Policy | Security Rules | Permission Rules | **条件表达式 + Redis 缓存** |
| 列级权限 | 不支持 | 不支持 | 支持 | **支持** |
| 用户系统 | GoTrue (独立) | 内置 | 无 | **内置 + SSO** |
| 缓存 | 无 | CDN | 无 | **Redis Cluster** |
| PG 横向扩展 | 无 | N/A | 无 | **读写分离 + Citus 分片** |
| Redis 横向扩展 | 无 | N/A | 无 | **Sentinel / Cluster** |
| 消息通知 | Realtime (Elixir) | FCM | Event Trigger | **Webhook + WebSocket + 队列** |
| 日志审计 | 有限 | 有限 | 有限 | **全链路结构化日志** |
| 多租户 | 独立实例 | 项目隔离 | 无 | **单实例多租户** |
| 开源协议 | Apache 2.0 | 闭源 | Apache 2.0 | **MIT** |

---

## 十、开发路线图（重新定义）

### Phase 0: 当前已完成 ✅

- [x] Rust + Axum 服务骨架
- [x] Auto API: CRUD + 过滤 + 排序 + 分页
- [x] JWT 注册 / 登录 / 刷新
- [x] 多租户连接管理（management schema + 动态连接池）
- [x] API Key 机制 (SHA256)
- [x] 前端管理控制台框架（Next.js）
- [x] SQL 查询器 / 事务端点

### Phase 1: RBAC 权限引擎 🔴 最高优先级

- [ ] `roles` / `permissions` / `role_assignments` 数据模型
- [ ] 权限 CRUD 管理 API
- [ ] Auto API 请求链路中的权限校验中间件
- [ ] 行级过滤条件注入
- [ ] 列级权限过滤
- [ ] 前端：角色管理界面、权限配置界面

### Phase 2: Redis 集成 🔴 高优先级

- [ ] Redis 连接管理（支持 Standalone / Sentinel / Cluster）
- [ ] 权限缓存（用户 → 权限集合）
- [ ] 查询结果缓存 + 自动失效
- [ ] 会话管理（refresh token 存储）
- [ ] 限流（滑动窗口算法）

### Phase 3: SSO / 社交登录 🟡 中优先级

- [ ] OAuth2 Authorization Code Flow 框架
- [ ] Google 登录
- [ ] Facebook 登录
- [ ] GitHub 登录
- [ ] 账号绑定与合并
- [ ] 自定义 OIDC Provider 支持

### Phase 4: PostgreSQL 横向扩展 🟡 中优先级

- [ ] 读写分离（Primary + Replica 路由）
- [ ] PgBouncer 集成
- [ ] 连接池智能管理（按负载动态调整）
- [ ] Citus 分片支持（可选）

### Phase 5: 消息通知系统 🟢 常规优先级

- [ ] 数据变更事件（INSERT/UPDATE/DELETE → 事件流）
- [ ] Webhook 管理（配置回调 URL、重试策略）
- [ ] WebSocket 实时推送（订阅表/行变更）
- [ ] 消息队列（Redis Stream / 外部 MQ）

### Phase 6: 日志与审计 🟢 常规优先级

- [ ] 结构化请求日志
- [ ] 审计日志（谁在什么时候对什么数据做了什么操作）
- [ ] 慢查询追踪
- [ ] 日志存储（内置 PG / 可选 Elasticsearch）
- [ ] 日志查询 API + 前端日志面板

### Phase 7: 网关增强 🟢 常规优先级

- [ ] 精细化限流（按 tenant / user / IP）
- [ ] 熔断降级
- [ ] 请求重试与超时控制
- [ ] API 版本管理
- [ ] 自定义中间件插件系统

---

## 十一、目标用户画像

### 画像 1: 独立开发者 / 小团队

> "我只想设计好数据库表，前端直接调 API，不想写后端。"

**OneBase 提供**：Auto API + 内置鉴权 + SSO → 一个人也能做百万用户的产品。

### 画像 2: 中型团队 / SaaS 产品

> "我们需要 RBAC 权限控制，Supabase 的 RLS 维护不下去了。"

**OneBase 提供**：应用层 RBAC + Redis 权限缓存 + 可视化权限配置 → 权限管理从噩梦变成点点鼠标。

### 画像 3: 大型产品 / 高并发场景

> "我们有百万 DAU，需要横向扩展，不能只靠单个 Postgres。"

**OneBase 提供**：PG 读写分离 + Redis Cluster + 多实例部署 → 从 10 万用户平滑扩展到千万级。

---

## 十二、项目名称释义

**OneBase** = **Crest**（山脊、浪尖）+ **Rail**（铁轨、轨道）

寓意：**在数据库与应用之间架起一条高性能的通道**，让数据像在铁轨上一样高效、可靠、有序地流动。

---

*本文档作为 OneBase 的产品架构北极星，所有设计决策和开发优先级以此为准。*
