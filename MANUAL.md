# OneBase 使用说明手册

> **版本**: 0.1.0  
> **定位**: 零代码数据网关 — 设计好数据库表结构，即可获得完整的 REST API、RBAC 鉴权、缓存、消息通知与网关管理能力。

---

## 目录

1. [快速开始](#1-快速开始)
2. [部署方式](#2-部署方式)
3. [环境变量配置](#3-环境变量配置)
4. [认证系统](#4-认证系统)
5. [Auto API（核心功能）](#5-auto-api核心功能)
6. [RBAC 权限管理](#6-rbac-权限管理)
7. [SSO 社交登录](#7-sso-社交登录)
8. [读写分离](#8-读写分离)
9. [Webhook 与实时推送](#9-webhook-与实时推送)
10. [监控与审计](#10-监控与审计)
11. [网关管理](#11-网关管理)
12. [管理后台（前端）](#12-管理后台前端)
13. [API 参考](#13-api-参考)
14. [生产环境检查清单](#14-生产环境检查清单)

---

## 1. 快速开始

### 前置条件

- Docker & Docker Compose（推荐）
- 或本地安装：Rust 1.77+、Node.js 20+、PostgreSQL 15+、Redis 7+

### 一键启动（Docker）

```bash
git clone <repo-url> onebase
cd onebase
docker compose up --build -d
```

启动后：
- **后端 API**: http://localhost:3000
- **管理后台**: http://localhost:3001
- **健康检查**: http://localhost:3000/health

### 本地开发

```bash
# 后端
cp .env.example .env   # 编辑数据库连接等
cargo run --bin migrate_all
cargo run

# 前端
cd frontend-nextjs
npm install
npm run dev
```

---

## 2. 部署方式

### Docker All-in-One（单机/开发）

一个容器内运行 PostgreSQL + Redis + Rust 后端 + Next.js 前端，由 Supervisord 管理进程。

```bash
docker compose up -d
```

### 多实例部署（生产推荐）

```
┌─────────────────────────────────────┐
│          负载均衡器 (Nginx/K8s)     │
│     ┌──────────┬──────────┐        │
│     │ OneBase│ OneBase│ ...    │
│     │ 实例 1   │ 实例 2   │        │
│     └────┬─────┴────┬─────┘        │
│          │          │              │
│     ┌────▼──────────▼────┐         │
│     │   Redis (共享)     │         │
│     └────────────────────┘         │
│     ┌────────────────────┐         │
│     │  PostgreSQL 主从    │         │
│     └────────────────────┘         │
└─────────────────────────────────────┘
```

多实例通过 Redis Pub/Sub 共享实时事件，支持水平扩展。

---

## 3. 环境变量配置

完整的环境变量参考请见项目根目录的 `.env.example` 文件。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATABASE_URL` | `postgresql://onebase:onebase123@127.0.0.1:5432/onebase` | 管理库连接串 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis 连接地址 |
| `JWT_SECRET` | ⚠️ **必须设置** | JWT 签名密钥，**生产环境未设置时服务拒绝启动**。至少 16 位，推荐 32+ 位。可用 `openssl rand -base64 48` 生成 |
| `RUST_ENV` | `production` | 运行环境。设为 `development` 时允许不设 JWT_SECRET（仅限开发调试） |
| `HOST` | `127.0.0.1` | 后端监听地址 |
| `PORT` | `3000` | 后端监听端口 |
| `CORS_ORIGINS` | `*` | 允许的前端域名，逗号分隔。**生产必须设为实际域名** |
| `RATE_LIMIT_PER_MINUTE` | `100` | 全局限流（每 IP 每分钟请求数） |
| `REQUEST_TIMEOUT_SECS` | `30` | 请求超时时间（秒） |
| `GRACEFUL_SHUTDOWN_SECS` | `30` | 优雅停机等待时间（秒） |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | 熔断器触发阈值（连续失败次数） |
| `CIRCUIT_BREAKER_TIMEOUT_SECS` | `30` | 熔断器恢复探测间隔（秒） |
| `JWT_EXPIRATION` | `86400` | JWT Token 过期时间（秒），默认 24 小时 |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:3000` | 前端连接后端的 URL |

---

## 4. 认证系统

### 注册

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","email":"demo@example.com","password":"Demo@1234"}'
```

密码要求：至少 8 位，包含大写字母、小写字母和数字。

### 登录

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"Demo@1234"}'
```

返回：
```json
{
  "token": "eyJhbGciOiJIUzI1NiI...",
  "user": { "id": 1, "username": "demo", "email": "demo@example.com" }
}
```

> **暴力破解防护**：登录接口有独立的速率限制，每个 IP 每 60 秒最多尝试 5 次。超限后将返回 429 错误，需等待窗口过期后重试。

### 后续请求携带 Token

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3000/auth/me
```

---

## 5. Auto API（核心功能）

Auto API 根据数据库表结构自动生成 RESTful CRUD 接口。**无需写任何代码**。

### URL 格式

```
/api/v1/{database_id}/{schema}/{table}
/api/v1/{database_id}/{schema}/{table}/{id}
```

### 认证方式（二选一）

1. **JWT Token**：`Authorization: Bearer <jwt_token>`
2. **API Key**：`Authorization: Bearer ob_<api_key>`

### 查询列表

```bash
# 基础查询
GET /api/v1/1/public/posts

# 分页
GET /api/v1/1/public/posts?limit=20&offset=0

# 排序
GET /api/v1/1/public/posts?order=created_at.desc

# 选择字段
GET /api/v1/1/public/posts?select=id,title,author_id

# 过滤
GET /api/v1/1/public/posts?status.eq=published
GET /api/v1/1/public/posts?views.gte=100
GET /api/v1/1/public/posts?title.ilike=%25hello%25
```

支持的操作符：`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`

### 查询单条

```bash
GET /api/v1/1/public/posts/42
```

### 创建

```bash
POST /api/v1/1/public/posts
Content-Type: application/json

{"title": "Hello World", "content": "...", "status": "draft"}
```

### 更新

```bash
PATCH /api/v1/1/public/posts/42
Content-Type: application/json

{"status": "published"}
```

### 删除

```bash
DELETE /api/v1/1/public/posts/42
```

### API Key 管理

API Key 操作需要 JWT 认证，且当前用户必须是该数据库所属租户的成员（或超级管理员）。

```bash
# 创建 API Key（需 JWT 认证，需租户权限）
POST /api/admin/api-keys/1
{"name": "Mobile App Key", "permissions": {"read": true, "write": true, "delete": false}}

# 列出 API Keys
GET /api/admin/api-keys/1

# 禁用 API Key
PATCH /api/admin/api-keys/1/5
{"is_active": false}
```

---

## 6. RBAC 权限管理

OneBase 使用应用层 RBAC 模型：**角色 → 权限 → 资源**。

### 概念

- **角色 (Role)**：如 `admin`、`editor`、`viewer`
- **权限 (Permission)**：定义对某资源（`schema.table`）的操作（`SELECT`/`INSERT`/`UPDATE`/`DELETE`）
- **行级过滤**：通过 `conditions` 字段限制可见行（如 `"author_id = {user_id}"`）
- **列级过滤**：通过 `allowed_columns` 限制可见列

### API 示例

```bash
# 创建角色
POST /api/rbac/roles
{"name": "editor", "description": "内容编辑"}

# 创建权限：editor 只能查看和编辑自己的文章
POST /api/rbac/permissions
{
  "resource": "public.posts",
  "action": "SELECT",
  "conditions": {"row_filter": "author_id = {user_id}"},
  "allowed_columns": ["id", "title", "content", "status"]
}

# 给用户分配角色
POST /api/rbac/users/5/roles
{"role_id": 2}
```

### 权限生效流程

```
请求 → JWT 认证 → RBAC 中间件查询权限 → 注入行/列过滤 → Auto API 执行
```

---

## 7. SSO 社交登录

支持 Google、GitHub、Facebook 及任意 OIDC 提供商。

### 配置流程

1. 在管理后台「SSO 登录管理」页面添加提供商
2. 填入 `Client ID` 和 `Client Secret`
3. 设置回调地址为 `https://your-domain.com/auth/sso/{provider}/callback`

### SSO 登录流程

```
1. 前端跳转 → GET /auth/sso/google/authorize
2. 用户在 Google 登录 → 重定向回 callback
3. 后端换取 token → 创建/关联本地用户 → 签发 JWT
4. 前端获取 JWT → 正常使用
```

### 管理 API

```bash
# 添加 SSO 提供商
POST /api/sso/providers
{
  "provider_type": "google",
  "client_id": "xxx.apps.googleusercontent.com",
  "client_secret": "xxx",
  "redirect_uri": "https://your-domain.com/auth/sso/google/callback"
}
```

---

## 8. 读写分离

### 配置 Replica

在管理后台「数据库连接」页面：

1. 添加主库连接（角色选 `Primary`）
2. 添加从库连接（角色选 `Replica`，关联到对应 Primary）

### 自动路由

- `SELECT` 查询 → 自动路由到 Replica（轮询负载均衡）
- `INSERT/UPDATE/DELETE` → 路由到 Primary
- 无 Replica 时自动 fallback 到 Primary

---

## 9. Webhook 与实时推送

### Webhook

数据变更时自动回调指定 URL。

```bash
# 创建 Webhook
POST /api/admin/webhooks
{
  "name": "新文章通知",
  "url": "https://your-server.com/webhook",
  "event_pattern": "public.posts.INSERT",
  "secret": "webhook-signing-secret"
}
```

事件模式支持通配符：
- `public.posts.INSERT` — 精确匹配
- `public.*.UPDATE` — 匹配 public 下所有表的更新
- `*.*.*` — 匹配所有事件

Webhook 请求头包含 HMAC 签名（`X-Webhook-Signature`），接收方可校验来源合法性。

### WebSocket 实时推送

```javascript
const ws = new WebSocket('ws://localhost:3000/realtime/ws?token=<jwt>');

// 订阅
ws.send(JSON.stringify({ type: "subscribe", channel: "public.posts" }));

// 接收事件
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // { event: "INSERT", schema: "public", table: "posts", data: {...} }
};

// 取消订阅
ws.send(JSON.stringify({ type: "unsubscribe", channel: "public.posts" }));
```

---

## 10. 监控与审计

### 健康检查

| 端点 | 用途 | 说明 |
|------|------|------|
| `GET /health/live` | 存活探针 | 进程存在即返回 200 |
| `GET /health/ready` | 就绪探针 | 检查 DB + Redis 连通性 |
| `GET /health` | 详细状态 | 返回连接池、Redis、版本等信息 |

Kubernetes 配置示例：
```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
```

### 审计日志

所有写操作（POST/PATCH/DELETE）自动记录到审计日志。

```bash
# 查询审计日志
GET /api/admin/audit-logs?limit=50&action=DELETE

# 查询慢查询
GET /api/admin/slow-queries?limit=20
```

### 监控仪表盘

管理后台提供「数据库监控」页面，展示：
- 数据库大小、表数量、连接数、缓存命中率
- 活跃连接列表
- 慢查询列表（PostgreSQL 和应用级）
- 熔断器状态
- 表大小排行

---

## 11. 网关管理

### 限流

默认全局限流，可按租户/用户/端点/IP 自定义规则：

```bash
POST /api/admin/rate-limit-rules
{
  "name": "API 写操作限制",
  "rule_type": "endpoint",
  "match_pattern": "/api/v1/*/POST",
  "max_requests": 50,
  "window_seconds": 60
}
```

### 熔断器

每个租户数据库独立熔断。当连续 5 次（可配置）数据库操作失败时：

1. 熔断器跳闸 → 后续请求直接返回 503（快速失败）
2. 等待 30s 后进入半开状态 → 允许少量探测
3. 探测成功 → 恢复正常

```bash
# 查看熔断器状态
GET /api/admin/circuit-breakers
```

---

## 12. 管理后台（前端）

访问 http://localhost:3001 进入管理后台。

### 主要功能页面

| 页面 | 路径 | 功能 |
|------|------|------|
| 数据库连接 | `/dashboard/connections` | 管理数据库连接、主从配置 |
| 数据浏览 | `/dashboard/tables` | 浏览和编辑表数据 |
| SQL 查询 | `/dashboard/query` | 在线 SQL 编辑器 |
| 角色管理 | `/dashboard/roles` | RBAC 角色 CRUD |
| 权限策略 | `/dashboard/rls` | 行/列级权限配置 |
| SSO 管理 | `/dashboard/sso` | SSO 提供商配置 |
| Webhook | `/dashboard/webhooks` | Webhook 配置与测试 |
| 审计日志 | `/dashboard/audit` | 操作日志与慢查询 |
| 数据库监控 | `/dashboard/monitor` | 性能指标仪表盘 |
| 数据导出 | `/dashboard/import` | CSV/JSON 导出 |

---

## 13. API 参考

### 公开端点（无需认证）

```
POST   /auth/register              注册
POST   /auth/login                 登录
GET    /auth/sso/providers         SSO 提供商列表
GET    /auth/sso/:provider/authorize  SSO 授权跳转
GET    /auth/sso/:provider/callback   SSO 回调
GET    /health                     详细健康检查
GET    /health/live                存活探针
GET    /health/ready               就绪探针
```

### 认证端点（需 JWT）

```
GET    /auth/me                    当前用户信息
POST   /auth/refresh               刷新 Token
POST   /auth/change-password       修改密码
POST   /query                      执行 SQL
POST   /transaction                事务操作
```

### Auto API（需 JWT 或 API Key）

```
GET    /api/v1/:db/:schema/:table           查询列表
GET    /api/v1/:db/:schema/:table/:id       查询单条
POST   /api/v1/:db/:schema/:table           创建记录
PATCH  /api/v1/:db/:schema/:table/:id       更新记录
DELETE /api/v1/:db/:schema/:table/:id       删除记录
```

### 管理 API（需 JWT）

```
# 租户 & 连接管理
GET    /api/tenants/my-connections
POST   /api/tenants/connections
POST   /api/tenants/test-connection

# RBAC
GET/POST   /api/rbac/roles
GET/POST   /api/rbac/permissions
POST       /api/rbac/users/:id/roles

# SSO
GET/POST   /api/sso/providers

# Webhook
GET/POST   /api/admin/webhooks

# 审计
GET    /api/admin/audit-logs
GET    /api/admin/slow-queries

# 监控
GET    /api/monitor/stats
GET    /api/monitor/tables
GET    /api/monitor/connections

# 网关
GET/POST   /api/admin/rate-limit-rules
GET        /api/admin/circuit-breakers

# API Key
GET/POST   /api/admin/api-keys/:db_id

# WebSocket
GET    /realtime/ws?token=<jwt>
```

---

## 14. 生产环境检查清单

上线前务必完成以下检查：

### 必须项

- [ ] `JWT_SECRET` 已设置为 16+ 位强随机字符串（未设置时服务拒绝启动）
- [ ] `RUST_ENV` 设为 `production`（禁用开发模式默认密钥）
- [ ] `POSTGRES_PASSWORD` 已修改为强密码
- [ ] `CORS_ORIGINS` 已设置为实际域名（非 `*`）
- [ ] `NEXT_PUBLIC_API_URL` 设为生产域名（而非 localhost）
- [ ] 数据库端口 5432/Redis 端口 6379 未对外暴露
- [ ] HTTPS 已配置（通过反向代理）
- [ ] 已执行 `migrate_all` 完成数据库迁移（迁移失败会 exit(1)）

### 推荐项

- [ ] 配置日志收集（`/var/log/onebase/`，日志已配置自动轮转）
- [ ] 配置健康检查探针（`/health/ready`）
- [ ] 测试优雅停机流程（`docker stop` 等待 30s）
- [ ] 配置数据库备份策略
- [ ] 限流规则已根据实际业务配置
- [ ] 创建首个管理员账号并设为 `super_admin`
- [ ] 运行 `cargo audit` 检查依赖库安全漏洞

### 安全特性（已内置）

以下安全特性已默认启用，无需额外配置：

- **HTTP 安全头**：自动添加 `X-Content-Type-Options`、`X-Frame-Options`、`X-XSS-Protection`、`Referrer-Policy`
- **登录暴力破解防护**：每 IP 每 60 秒最多 5 次登录尝试
- **SQL 注入防护**：所有路径参数、查询参数经过标识符校验
- **错误信息脱敏**：数据库/内部错误不会泄露到 API 响应中
- **API Key 租户隔离**：用户只能管理自己所属租户的 API Key
- **熔断器 Poison 保护**：RwLock poisoned 不会导致服务雪崩
- **前端 console 移除**：生产构建自动移除 `console.log`（保留 `console.error`）

### 多实例部署

- [ ] 所有实例共享同一 PostgreSQL 和 Redis
- [ ] `REDIS_URL` 指向共享 Redis 实例
- [ ] 负载均衡器配置健康检查（`/health/ready`）
- [ ] WebSocket 连接需要 sticky session 或通过 Redis Pub/Sub 广播
