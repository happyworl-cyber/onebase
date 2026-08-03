# P3：Provisioner Webhook（运维自动化开通资源）

**日期**：2026-06-17  
**状态**：P3.0–P3.2 已实现（含异步 poll）  
**依赖**：P1 平台 PG 自动建库（已实现，作为 fallback）

---

## 背景

用户希望 **在 Onebase 里创建项目时，由运维侧自动 provision 全新的 PostgreSQL 服务器**（或 RDS / K8s Pod / Docker 容器），而不是：

- 只在已有 PG 上 `CREATE DATABASE`（P1），或
- 超管手工在 `/platform/pg-pools` 登记已有 PG。

P3 把「建基础设施」交给运维已有的自动化（Ansible / Terraform / 内部 API / K8s Operator），Onebase 只负责 **调用 → 落库 → 关联项目 → 失败回滚/告警**。

---

## 与 P1 / PG 池的区别

| 方式 | 谁创建 PG **服务器** | 谁创建 **database** | 适用场景 |
|------|----------------------|---------------------|----------|
| PG 池登记 | 运维事先装好 | Onebase `CREATE DATABASE` | 共享 PG 集群，多项目共实例 |
| P1 平台 PG | 已存在（同 Onebase） | Onebase | 单机 / 内网 PoC |
| **P3 Webhook** | **运维脚本** | 运维脚本或 Onebase | 每项目独立 RDS / 新容器 / 新 VM |

---

## 用户故事

1. 运维部署 Provisioner 服务（HTTP），并配置 Onebase 环境变量。
2. 用户 `/workspace/provision` 选择 **「运维自动开通（Webhook）」**。
3. Onebase `POST` Provisioner → 收到 PG（+ 可选 Redis）连接信息 → 写入 `tenant_databases` / `project_env_vars`。
4. 用户进入项目即可使用；删项目时可选用 Webhook **deprovision**（可选）。

---

## 环境变量（平台级）

```env
# 必填：Provisioner 基址（无尾斜杠）
PROVISION_WEBHOOK_URL=https://ops.internal.example.com/onebase/provision

# 可选：Bearer 或 HMAC 密钥
PROVISION_WEBHOOK_TOKEN=...
PROVISION_WEBHOOK_TIMEOUT_SECS=120

# 可选：删项目时回调 deprovision
PROVISION_WEBHOOK_DEPROVISION_URL=https://ops.internal.example.com/onebase/deprovision
```

---

## Provisioner 契约

### 请求（Onebase → 运维）

`POST {PROVISION_WEBHOOK_URL}`

Headers:

```
Authorization: Bearer {PROVISION_WEBHOOK_TOKEN}   # 若配置
Content-Type: application/json
X-Onebase-Request-Id: {uuid}
```

Body:

```json
{
  "action": "provision",
  "name": "我的博客",
  "slug": "my-blog",
  "template_slug": "blank",
  "requested_resources": ["postgresql"],
  "caller": {
    "user_id": 42,
    "email": "user@example.com"
  }
}
```

`requested_resources` v1 支持：`postgresql`；v1.1 可加 `redis`。

### 成功响应（200/201）

```json
{
  "provision_id": "prov_abc123",
  "postgresql": {
    "host": "pg-my-blog.internal",
    "port": 5432,
    "database": "my_blog",
    "user": "my_blog_app",
    "password": "generated-secret"
  },
  "redis": {
    "url": "redis://:pass@redis-my-blog.internal:6379/0"
  },
  "env_vars": {
    "REDIS_URL": "redis://:pass@redis-my-blog.internal:6379/0"
  }
}
```

规则：

- `postgresql` **必填**（v1）；`redis` / `env_vars` 可选。
- Onebase 将 `postgresql` 写入 `tenant_databases`（密码加密）。
- `env_vars` 写入 `project_env_vars`（与 P2 Redis 逻辑一致）。

### 失败响应（4xx/5xx）

```json
{
  "error": "RDS quota exceeded in ap-southeast-1"
}
```

Onebase 向用户返回该 `error`；**不**写 `tenants` / `tenant_databases`。

### 幂等

- 同一 `(caller_user_id, slug)` 重复 provision：Provisioner 应返回**同一**资源或 409；Onebase 侧已有 slug 幂等（返回已有项目）。

### 异步开通（P3.2）

Provisioner 可立即返回 **HTTP 202** 或 `status: "pending"`（无 `postgresql` 字段）：

```json
{
  "status": "pending",
  "provision_id": "prov_abc123",
  "message": "terraform apply in progress",
  "poll_after_secs": 5
}
```

Onebase 随后对同一 URL 轮询：

```json
{
  "action": "poll",
  "provision_id": "prov_abc123",
  "slug": "my-blog"
}
```

Poll 响应：

| `status` | 含义 |
|----------|------|
| `pending` | 继续等待；可选 `poll_after_secs` |
| `failed` | 开通失败，`error` 返回用户 |
| `succeeded` / 含 `postgresql` | 与同步成功响应相同 |

环境变量：

```env
PROVISION_WEBHOOK_POLL_INTERVAL_SECS=5
PROVISION_WEBHOOK_POLL_MAX_SECS=600
```

### Deprovision（可选 v1.1）

删项目 / 超管删租户时：

`POST {PROVISION_WEBHOOK_DEPROVISION_URL}`

```json
{
  "action": "deprovision",
  "slug": "my-blog",
  "provision_id": "prov_abc123",
  "project_id": 1001
}
```

失败只记 audit 日志，不阻塞删项目。

---

## Onebase 后端改动

### `ProvisionRequest` 扩展

```rust
pub use_provision_webhook: bool,  // 与 use_platform_pg / pg_pool_id / pg_connection 四选一
pub requested_resources: Option<Vec<String>>,  // 默认 ["postgresql"]
```

### 流程

```
resolve_provision_source()
  ├─ use_provision_webhook → call_provisioner_webhook() → ResolvedProvisionFromWebhook
  ├─ use_platform_pg       → 现有 P1
  └─ pg_pool_id / manual   → 现有逻辑

provision_project():
  1. 校验输入 + 幂等
  2. 若 webhook：HTTP 调用，解析 postgresql (+ env_vars)
  3. 否则：CREATE DATABASE（现有）
  4. 事务写入 tenants + tenant_databases + user_tenants
  5. 写入 project_env_vars（来自 webhook env_vars）
  6. 模板 DDL + RBAC
  7. workspace_config.provisioned_via_webhook = true
      workspace_config.provision_id = "..."
```

### 失败补偿

| 阶段 | 补偿 |
|------|------|
| Webhook 超时/5xx | 不写库；用户重试 |
| Webhook 成功、写库失败 | 调 deprovision（若配置）+ 日志 |
| DDL 失败 | 现有 `failed_provisioning` |

### 新模块

- `src/provision_webhook.rs` — HTTP 客户端、签名校验、响应解析
- 单元测试：mock server（wiremock 或 axum test）

---

## 前端改动

### `/workspace/provision` 第 2 步

新增 Tab：**「运维自动开通」**（仅当 `GET /api/provision/webhook-config` 返回 `enabled: true`）

显示说明：「将由运维系统创建独立 PostgreSQL 实例，耗时可能 1–5 分钟」。

可选勾选：☑ PostgreSQL ☑ Redis（v1.1）

### 平台超管（可选）

`/platform/provision-settings` — 只读展示 Webhook 是否配置（**不**暴露 token）。

---

## 运维侧示例（Provisioner 伪代码）

```bash
# 收到 provision 请求后：
# 1. terraform apply -var slug=my-blog
# 2. 或 docker run -d --name pg-my-blog postgres:16
# 3. 创建库 + 用户，返回 JSON
```

可参考仓库内 `examples/provisioner-webhook/`（实现阶段添加）。

---

## 安全

- Token 仅存服务端 env，不下发前端。
- Webhook 响应中的 password 只写入加密字段，audit 日志脱敏。
- 建议 Provisioner 内网可达；Onebase 可配置 IP  allowlist（后续）。

---

## 验收标准

- [x] 配置 `PROVISION_WEBHOOK_URL` 后，向导出现「运维自动开通」
- [x] 成功时 `tenant_databases` + 可选 `project_env_vars` 正确
- [x] Webhook 失败时用户看到 Provisioner 返回的 error
- [x] 未配置 Webhook 时该选项不可见；P1/PG 池仍可用
- [x] 提供 `examples/provisioner-webhook` 本地 mock 供联调
- [x] 删 Webhook 开通的项目时回调 deprovision（需配置 `PROVISION_WEBHOOK_DEPROVISION_URL`）
- [x] 向导可勾选 Redis；响应 `redis.url` 写入 `REDIS_URL` 环境变量
- [x] 超管 `/platform/provision-settings` 可查看配置状态并探活
- [x] Provisioner 返回 202/pending 时 Onebase 自动 poll 直至成功或超时

---

## 分期建议

| 阶段 | 内容 |
|------|------|
| **P3.0** | postgresql only + provision + 向导 Tab |
| **P3.1** | deprovision on delete + redis in response |
| **P3.2** | 超管探活页 + 异步 poll（`action=poll`） |
