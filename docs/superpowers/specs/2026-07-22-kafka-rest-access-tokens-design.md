# Kafka REST 访问令牌设计

> 状态：design approved（2026-07-22），待 spec review。
>
> 对齐参考：ES 代理（`cres_es_*` + `/api/es*` / `/api/es-app*` + Tokens/Usage UI）。
>
> 上游：`docs/superpowers/specs/2026-07-21-kafka-workflow-integration-design.md`（连接注册表 + produce 节点 + kafka 触发器已落地）。

## 1. 目标与非目标

### 1.1 目标

让外部系统能像调用 ES 应用 API 一样，用访问令牌（无需平台登录）访问 Kafka：

1. 管理端签发 `cres_kafka_*` 令牌（JWT 管理）
2. 对外路径式 REST：`produce` / `topics` / `health`
3. 支持 `/api/v1/:database_slug/kafka/...` 租户作用域
4. 令牌 ACL：`allowed_ops` + `topic_allowlist`
5. 前端 Tokens + Usage（curl 文档）

### 1.2 非目标

| 不做 | 说明 |
|---|---|
| Kafka 协议 / Admin 透传代理 | 不做 `/api/kafka/*` 任意路径转发 |
| 消费 / consumer-group REST | 消费走工作流 `trigger_type=kafka` |
| 取消现有 JWT `exec` | 保留控制台与成员调用 |
| mTLS / Schema Registry | 连接层既有约定不变 |

## 2. 关键决定

| 决定 | 选项 | 理由 |
|---|---|---|
| 鉴权 | **令牌 + slug 路径（C）** | 对齐 ES 对外接入 |
| URL 形态 | **路径式对外 + 保留 JWT exec（C）** | 外部清晰；内部兼容 |
| ACL | **`allowed_ops` + `topic_allowlist`（A）** | 对齐 ES methods + index_allowlist |

## 3. 架构

```
JWT ──► /api/admin/kafka-connections[+ /tokens|/health|/topics]
JWT ──► /api/kafka-connections/:id/exec          （保留）

cres_kafka_* ──► /api/kafka/:id/{produce|topics|health}
cres_kafka_* ──► /api/v1/:database_slug/kafka/:id/{...}
                       │
                       ▼
              kafka_ds::commands（produce / list_topics / health_probe）
```

模块建议：

```
migrations/053_kafka_access_tokens.sql
src/kafka_ds/auth.rs          # generate/hash/extract/check_ops/check_topic（可测纯函数）
src/kafka_ds/models.rs        # + KafkaAccessToken
src/kafka_handlers.rs         # + token CRUD（JWT）
src/kafka_app_handlers.rs     # 令牌面 produce/topics/health（bin）
src/main.rs                   # 路由；slug 版复用 ES 同类 tenant-scope 中间件模式
```

前端：`kafka-connections/page.tsx` 增加 Tokens / Usage Tab；`kafkaAPI` 增 token CRUD。

## 4. 令牌模型

### 4.1 表 `management.kafka_access_tokens`

对齐 `016_es_proxy.sql` 中 `es_access_tokens`：

| 字段 | 说明 |
|---|---|
| `id` | BIGSERIAL PK |
| `connection_id` | FK → `kafka_connections(id)` ON DELETE CASCADE |
| `name` | VARCHAR |
| `token_hash` | sha256 hex；永不回传 |
| `token_prefix` | 前 16 字符预览 |
| `allowed_ops` | TEXT[] 或 JSONB；默认 `produce,list_topics,health` |
| `topic_allowlist` | TEXT[]；默认 `{*}`；glob（`*` / `?`） |
| `expires_at` | 可空 |
| `last_used_at` / `use_count` | 使用统计 |
| `is_active` | 软停用 |
| `created_by` / timestamps | |

### 4.2 Token 格式与提取

- 明文：`cres_kafka_` + 43 字符 base64url（与 `cres_es_` 同熵）
- 提取顺序：`Authorization: ApiKey|Bearer|裸 token`，fallback `X-Kafka-Token`
- 前缀避免被 `rbac_middleware` 的 `cr_` API Key 分支误判

### 4.3 管理 API（JWT，租户 admin）

| 方法 | 路径 |
|---|---|
| GET/POST | `/api/admin/kafka-connections/:id/tokens` |
| PATCH/DELETE | `/api/admin/kafka-connections/:id/tokens/:token_id` |

创建响应一次性返回：

```json
{ "token": "cres_kafka_...", "record": { "...无 hash..." } }
```

## 5. 对外 REST

### 5.1 路径

| 方法 | 路径 | op |
|---|---|---|
| POST | `/api/kafka/:id/produce` | produce |
| GET | `/api/kafka/:id/topics` | list_topics |
| GET | `/api/kafka/:id/health` | health |
| 同上 | `/api/v1/:database_slug/kafka/:id/...` | 同上 + 租户匹配 |

`:id` 为 `kafka_connections.id`（整数）。

### 5.2 Produce body

```json
{
  "topic": "orders",
  "key": "optional",
  "value": "string | object | array",
  "headers": { "k": "v" }
}
```

与工作流节点 / JWT `exec` 的 args 语义一致（复用 `kafka_ds::commands`）。

### 5.3 响应

统一 JSON 包装（非 ES 流式透传）：

```json
{ "ok": true, "op": "produce", "result": { "topic", "partition", "offset", "key" } }
```

topics / health 同理，`result` 为现有 `list_topics` / `health_probe` 输出。

### 5.4 ACL

1. 解析令牌 → 查 hash → 校验 active / expires / connection active
2. 当前 op ∈ `allowed_ops`，否则 403
3. `produce`：`topic` 匹配 `topic_allowlist` 任一 glob，否则 403
4. slug 路由：令牌所属 `connection.tenant_id` 必须等于 slug 解析出的租户，否则 403
5. 成功后异步更新 `use_count` / `last_used_at`（对齐 ES）

### 5.5 保留 JWT exec

`POST /api/kafka-connections/:id/exec` 行为不变；不要求访问令牌。

## 6. 前端

- 连接详情 Tab：`概览`（现有）| `Tokens` | `Usage`
- Tokens：列表、创建（ops + topic 白名单 + 过期）、停用、删除；明文弹窗一次性
- Usage：curl 示例覆盖三种 op、两种 base path（`/api/kafka` 与 `/api/v1/{slug}/kafka`）
- `kafkaAPI.listTokens / createToken / updateToken / deleteToken`

## 7. 错误处理

| 场景 | HTTP |
|---|---|
| 缺/错/过期/吊销令牌 | 401 |
| op / topic ACL 拒绝；slug 租户不匹配 | 403 |
| 连接不存在 | 404 |
| 连接停用 / 上游不可达 | 503 |
| body 非法 | 400 |

## 8. 实现顺序

1. Migration `053_kafka_access_tokens` + `kafka_ds/auth` 纯函数单测
2. Token CRUD handlers + 路由
3. `kafka_app_handlers`（produce/topics/health）+ slug 路由
4. 前端 Tokens / Usage + api.ts
5. 手工：令牌 curl produce；ACL 拒绝；JWT exec 回归

## 9. 验收标准

1. 管理员可签发令牌，明文仅创建时可见
2. 外部用 `Authorization: ApiKey cres_kafka_*` 可 produce / topics / health
3. `/api/v1/:slug/kafka/:id/...` 租户隔离生效
4. `allowed_ops` / `topic_allowlist` 拒绝越权
5. JWT admin、JWT exec、工作流 kafka 节点与触发器不受影响
