# 对象存储连接（COS / OSS / MinIO）设计 — 第一期

> 状态：implemented（phase 1，2026-08-11）。
>
> 对齐：`redis_ds` / `kafka_ds` 租户连接注册模式；非平台级 `REDIS_URL`；非 ES 反向代理。
>
> 范围锁定：第一期仅连接 CRUD + health + exec + 管理前端。Token 代理、工作流节点、multipart/copy 分期后续做。

## 1. 目标与非目标

### 1.1 目标（第一期）

让租户把已有的对象存储（腾讯云 COS、阿里云 OSS、MinIO）登记进平台，之后可通过：

1. 管理 API（`/api/admin/object-storage-connections/*`）维护连接并做健康检查
2. 数据 API（`/api/object-storage-connections/:id/exec`）执行 put / get / delete / list / presign
3. 管理前端页（workspace events 下，对齐 Redis/Kafka 连接页）

统一使用，而不必在各处硬编码 endpoint / 密钥。

### 1.2 非目标（第一期不做）

| 不做 | 说明 |
|---|---|
| Access Token + HTTP 代理 / 高层 App API | 第二期（对齐 ES/Kafka token 面） |
| 工作流 `object_storage` 节点 | 第三期；第一期 lib 模块可进 `lib.rs` 便于后续挂载，但 **不** 接线 workflow engine / UI |
| multipart / copy / head | 后续增强；大文件第一期走 `presign` |
| 厂商原生 SDK / 重型 aws-sdk-s3 | 统一 S3 兼容轻量客户端（`rusty-s3` + `reqwest`） |
| 平台级全局桶（env） | 多租户场景不适用 |
| 删除桶 / 建桶管理 | YAGNI；连接登记默认已有 bucket |

### 1.3 分期路线

| 期 | 内容 |
|---|---|
| **1（本文）** | 连接 CRUD + health + exec（put/get/delete/list/presign）+ 管理前端 |
| **2** | Access Token + 代理 / 高层上传下载 API |
| **3** | 工作流节点；multipart / copy / head |

## 2. 关键决定

| 决定 | 选项 | 理由 |
|---|---|---|
| 形态 | 镜像 `redis_ds` / `kafka_ds` | 与现有租户数据源一致；二期可扩 token，三期可挂工作流 |
| 客户端 | 统一 `rusty-s3` + `reqwest`（S3 兼容签名）+ `provider` 分支配置 | 覆盖 COS/OSS/MinIO；避免 aws-sdk-s3 → aws-lc-sys 拖垮冷编译 |
| Provider | `minio` \| `cos` \| `oss` | 第一期不单独加通用 `s3`；需要时可后续加 |
| 密钥 | `secret_key_enc` AES-GCM；`access_key_id` 明文 | 对齐 Redis password / Kafka SASL；access key 非机密级 |
| 默认桶 | 连接级 `bucket`；exec 可覆盖 | 常见「一连接一桶」；保留灵活性 |
| 大对象 | put/get 经 API 设大小上限；更大走 presign | 避免 API 进程被大 body 拖垮 |
| 鉴权 | Admin = 超管/租户 owner-admin；exec = 租户成员 + 读写区分 | 对齐 Redis handlers |

## 3. 架构

```
管理前端 (events/object-storage-connections)
        │
        ▼
/api/admin/object-storage-connections  ── CRUD + health
/api/object-storage-connections/:id/exec ── put/get/delete/list/presign
        │
        ▼
object_storage_handlers.rs  (bin-only：鉴权 / 审计)
        │
        ▼
object_storage_ds/          (lib-safe)
  models · client_cache · commands · fetch_active*
        │
        ▼
rusty-s3 + reqwest  ←── provider: minio | cos | oss
        │
        ▼
management.object_storage_connections (PG)
```

模块与文件：

```
migrations/057_object_storage_connections.sql
src/object_storage_ds/
  mod.rs           # fetch_active / fetch_active_for_tenant
  models.rs        # ObjectStorageConnection + 请求 DTO
  client_cache.rs  # DashMap get_or_create / invalidate
  commands.rs      # SUPPORTED_OPS + execute + is_write_op
src/object_storage_handlers.rs   # axum CRUD + health + exec
src/lib.rs                       # pub mod object_storage_ds
src/main.rs                      # 路由注册
src/migrate.rs                   # 注册 057
Cargo.toml                       # rusty-s3（复用已有 reqwest）
frontend-nextjs/lib/api.ts
frontend-nextjs/app/workspace/[projectId]/events/object-storage-connections/page.tsx
frontend-nextjs/components/workspace/workspaceNav.ts  # 导航入口
```

**刻意不改（第一期）：** `workflow_engine`、ES proxy、平台 `REDIS_URL` / `Config`。

## 4. 数据模型

### 4.1 表 `management.object_storage_connections`

```sql
CREATE TABLE IF NOT EXISTS management.object_storage_connections (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            INTEGER NOT NULL
                         REFERENCES management.tenants(id) ON DELETE CASCADE,
    connection_name      VARCHAR(100) NOT NULL,
    provider             TEXT NOT NULL
                         CHECK (provider IN ('minio', 'cos', 'oss')),
    endpoint             TEXT NOT NULL,
    region               TEXT NOT NULL DEFAULT 'us-east-1',
    bucket               TEXT NOT NULL,
    access_key_id        TEXT NOT NULL,
    secret_key_enc       TEXT NOT NULL,
    force_path_style     BOOLEAN NOT NULL DEFAULT false,
    connect_timeout_secs INTEGER NOT NULL DEFAULT 5
                         CHECK (connect_timeout_secs BETWEEN 1 AND 60),
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_by           INTEGER NOT NULL
                         REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_object_storage_conn_name UNIQUE (tenant_id, connection_name),
    CONSTRAINT chk_object_storage_endpoint CHECK (
        endpoint ~ '^https?://[^[:space:]]+$'
    ),
    CONSTRAINT chk_object_storage_bucket CHECK (
        bucket ~ '^[^[:space:]]+$'
    )
);

CREATE INDEX IF NOT EXISTS idx_object_storage_connections_tenant
    ON management.object_storage_connections(tenant_id)
    WHERE is_active;
```

说明：

- `secret_key_enc`：`crypto::encrypt_secret`；`#[serde(skip_serializing)]`
- `force_path_style`：创建时按 provider 默认——`minio=true`，`cos/oss=false`；允许覆盖
- `endpoint` 必须带 `http://` 或 `https://`
- 无单独 `use_ssl` 列：由 endpoint scheme 决定

### 4.2 Provider 建连规则

| provider | endpoint 示例 | force_path_style 默认 | region |
|---|---|---|---|
| `minio` | `http://minio.local:9000` | `true` | 可填 `us-east-1` |
| `cos` | `https://cos.ap-guangzhou.myqcloud.com` | `false` | 如 `ap-guangzhou` |
| `oss` | `https://oss-cn-hangzhou.aliyuncs.com` | `false` | 如 `cn-hangzhou` |

`client_cache` 内按连接配置构造 `S3Handle`（reqwest + rusty-s3 `Credentials` / `UrlStyle`）；按桶名现建 `Bucket`。

## 5. API

### 5.1 管理 API

鉴权：与 Redis admin 相同（超管 / 租户 owner-admin）。列表与详情 **永不** 返回 `secret_key` / `secret_key_enc`。

| Method | Path | 作用 |
|---|---|---|
| GET | `/api/admin/object-storage-connections` | 列表（可按 tenant 过滤，同 Redis） |
| POST | `/api/admin/object-storage-connections` | 创建（body 含明文 `secret_key`，落库加密） |
| PATCH | `/api/admin/object-storage-connections/:id` | 更新；若改密钥/endpoint/provider/region/path-style/bucket → `invalidate` |
| DELETE | `/api/admin/object-storage-connections/:id` | 删除 + `invalidate` |
| POST | `/api/admin/object-storage-connections/:id/health` | 健康检查 |

#### Health

对默认 `bucket` 执行 `HeadBucket`；若 SDK/厂商不支持或失败，降级 `ListObjectsV2`（`max_keys=1`）。  
成功：`{ "ok": true, "latency_ms": N, "bucket": "..." }`  
失败：可读错误，不泄露 secret。

### 5.2 数据 API：`POST /api/object-storage-connections/:id/exec`

鉴权：租户成员；写操作需写权限（对齐 Redis `is_write_op`）。

请求：

```json
{ "op": "put", "args": { "key": "a/b.txt", "content": "hello" } }
```

#### 支持的 op

| op | 写？ | 主要 args | 成功返回要点 |
|---|---|---|---|
| `put` | 是 | `key`；`content`（UTF-8 文本）或 `content_base64`；可选 `content_type`、`bucket` | `{ etag, key, bucket }` |
| `get` | 否 | `key`；可选 `bucket`、`as_base64` | `{ key, bucket, content_type, size, content 或 content_base64 }` |
| `delete` | 是 | `key` 或 `keys[]`；可选 `bucket` | `{ deleted: [..] }` |
| `list` | 否 | 可选 `prefix`、`delimiter`、`max_keys`、`continuation_token`、`bucket` | `{ objects, common_prefixes, next_continuation_token, is_truncated }` |
| `presign` | PUT→写 / GET→读 | `key`；`method`: `GET`\|`PUT`；可选 `expires_secs`、`content_type`、`bucket` | `{ url, expires_at, method, key, bucket }` |

#### 限额（硬编码常量，可后续配置化）

| 项 | 值 |
|---|---|
| put/get 经 API 的 body 上限 | **5 MiB**（超出 → `InvalidQuery`，引导 `presign`） |
| `list.max_keys` 默认 / 封顶 | 100 / **1000** |
| `presign.expires_secs` 默认 / 封顶 | 3600 / **86400**（24h） |
| 单次 `delete.keys` 封顶 | **100** |
| 单 op 超时 | **30s**（对象存储常慢于 Redis） |

#### Key 校验

- trim 后非空；禁止以 `/` 开头的绝对路径风格可选（允许常见 `a/b`）
- 禁止空 key、含 `\0`、或 `..` 路径段（防异常路径）
- 长度上限 1024

## 6. Client cache 与命令层

### 6.1 `client_cache`

- `DashMap<i64, S3Handle>`（reqwest Client + endpoint/region/path-style + Credentials）
- `get_or_create(&ObjectStorageConnection) -> Result<S3Handle>`：解密 `secret_key_enc` → 建 handle
- `invalidate(connection_id)`：更新/删除后调用
- 不在 cache 中存明文 secret（凭证仅在 handle 内存中）

### 6.2 `commands::execute`

签名对齐 Redis：

```rust
pub async fn execute(
    handle: &S3Handle,
    default_bucket: &str,
    op: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value>;
```

- `SUPPORTED_OPS`: `put`, `get`, `delete`, `list`, `presign`
- `is_write_op(op, args)`：`put`/`delete` 为写；`presign` 当 `method=PUT`（缺省按写）为写
- bucket：`args.bucket` 覆盖连接默认桶
- 上游 404 → `NotFound`；403 → 明确「对象存储拒绝访问」类错误；超时 → `ServiceUnavailable`
- 实现：rusty-s3 签 URL + reqwest 发送（无 aws-sdk）

## 7. 前端

- 页：`frontend-nextjs/app/workspace/[projectId]/events/object-storage-connections/page.tsx`
- API：`objectStorageConnectionsApi`（list/create/update/delete/health/exec）
- 导航：`workspaceNav.ts` 增加入口（与 Redis/Kafka 同组）
- UI 能力：
  - 连接列表（provider / endpoint / bucket / active）
  - 创建/编辑表单：切换 provider 时自动建议 `force_path_style` 默认
  - Health 按钮
  - 简易 Exec 调试：op 下拉 + JSON args + 结果展示
- 视觉与交互对齐现有 Redis/Kafka 连接页，不另起设计体系

## 8. 错误处理

| 情况 | 行为 |
|---|---|
| 参数缺失 / 超限 / key 非法 | `400 InvalidQuery` + 中文说明 |
| 连接不存在 / 禁用 | `404` |
| 对象/桶不存在（上游） | `404` |
| 上游 403 / 签名错误 | `400` 或 `503` 可读信息，**不**回显 secret |
| 超时 | `503 ServiceUnavailable` |
| secret 解密失败 | `500 Internal` |

## 9. 测试

无真实云依赖的单元测试：

1. provider / endpoint / bucket 校验
2. `force_path_style` 默认值（minio vs cos/oss）
3. `SUPPORTED_OPS` / `is_write_op`（含 presign GET vs PUT）
4. put/get 大小上限、list max_keys、presign expires、delete keys 封顶
5. key 校验（空、`..`、过长）
6. 模型序列化跳过 `secret_key_enc`

集成测试（可选，非第一期必须）：本地 MinIO；CI 未提供则跳过。

## 10. 依赖

`Cargo.toml` 增加：

- `rusty-s3`（`rustcrypto` + `full`；**不要**启用 `aws-lc-rs`）
- HTTP 传输复用已有 `reqwest`（native-tls）

刻意不引入 `aws-sdk-s3` / `aws-config`，以免 `aws-lc-sys` 拖垮冷编译与 Docker 依赖层。

## 11. 后续扩展钩子

- 第二期（已实现）：`object_storage_access_tokens`（`cres_os_*`）+
  `/api/object-storage/:id/{exec,health}` 与 `/api/v1/:slug/object-storage/...`；
  Admin token CRUD；ACL = `allowed_ops` + `key_prefix_allowlist`
- 第三期：见 `2026-08-11-object-storage-workflow-node-design.md`（工作流 `object_storage` 节点）
- 通用 `provider=s3`、STS 临时凭证、服务端 multipart

## 12. 验收标准

1. 迁移成功创建表与索引
2. Admin CRUD + health 对 MinIO（或任一 S3 兼容端）可用
3. exec 五类 op 行为符合 §5.2；超限被拒绝
4. 前端可完成登记、探测、简易调试
5. 响应与日志不泄露 `secret_key`
6. 单元测试通过
