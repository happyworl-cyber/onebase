# 对象存储增加 Google Cloud Storage — 设计文档

- 日期：2026-09-08
- 状态：已通过
- 范围：在现有对象存储连接上增加 `gcs` provider（HMAC / S3 互操作）。
- 相关代码：
  - `migrations/063_object_storage_gcs.sql`
  - `src/migrate.rs`
  - `src/object_storage_ds/models.rs`
  - `frontend-nextjs/lib/api.ts`
  - `frontend-nextjs/app/workspace/[projectId]/events/object-storage-connections/page.tsx`
- 关联：`docs/superpowers/specs/2026-08-10-object-storage-connections-design.md`

## 1. 目标与非目标

让租户把已有的 Google Cloud Storage 桶登记进平台，与 MinIO / COS / OSS 共用同一套 CRUD、health、exec、Token、工作流节点。

认证方式：**GCS 互操作性 HMAC 密钥**（Access Key + Secret），走 XML API / S3 兼容签名。不引入 GCS 原生 SDK，不接服务账号 JSON。

### 非目标

- 服务账号 JSON / ADC / 原生 JSON API
- 通用 `provider=s3`
- 改 put/get/delete/list/presign 语义
- 改工作流 `object_storage` 节点（它只认 `connection_id`）

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| `provider` | `gcs` | 与 `cos` / `oss` 同风格 |
| 前端标签 | Google Cloud Storage | |
| 客户端 | 继续 `rusty-s3` + `reqwest` | HMAC + SigV4 即可 |
| endpoint 建议值 | `https://storage.googleapis.com` | GCS XML / HMAC 全球入口 |
| region 建议值 | `auto` | GCS SigV4 credential scope 官方推荐 |
| `force_path_style` 默认 | `true` | path-style 对 HMAC 互操作更稳；可手动改 virtual-host |
| 凭证字段 | 现有 `access_key_id` + `secret_key` | 控制台「互操作性 HMAC 密钥」 |
| schema | 只扩 CHECK，不加列 | 无新认证模型 |

## 3. 数据层

新迁移 `063_object_storage_gcs.sql`：DROP 匿名 CHECK（名 `object_storage_connections_provider_check`），再显式加上 `gcs`。对齐 `032_sso_mind_provider.sql` 的写法。

表结构、加密、API 路径不变。

## 4. 校验与默认值

`validate_provider` 接受 `minio | cos | oss | gcs`。

`default_force_path_style`：`minio` 与 `gcs` 为 `true`，其余为 `false`。创建时若请求未传 `force_path_style`，后端仍走该函数。

前端切换到 `gcs` 时：

- 未手动改过 path-style → 打开 path-style
- endpoint 为空 → 填 `https://storage.googleapis.com`
- region 为空或仍是 MinIO 默认 `us-east-1` → 填 `auto`

## 5. 不做的代码

`commands.rs`、`client_cache.rs`、Token 代理、工作流执行引擎不改。它们对 provider 无分支。

## 6. 测试

- `validate_provider("gcs")` 通过；未知值仍失败
- `default_force_path_style("gcs") == true`
- 现有 minio / cos / oss 默认值不变
