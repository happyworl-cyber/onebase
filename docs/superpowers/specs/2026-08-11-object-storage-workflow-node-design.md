# Object Storage Workflow Node（Phase 3）

Status: **Implemented**（2026-08-11）

## Goal

工作流节点 `object_storage`：在租户工作流内对已登记的 COS/OSS/MinIO 连接执行 put/get/delete/list/presign，行为对齐 Redis/Kafka 数据源节点。

## Config

```json
{
  "connection_id": 1,
  "op": "put|get|delete|list|presign",
  "key": "...",
  "content": "...",
  "prefix": "...",
  "max_keys": 100,
  "method": "GET|PUT",
  "expires_secs": 3600,
  "keys": ["a", "b"]
}
```

- 调度器先对 config 做 `{{...}}` 模板替换；引擎去掉 `connection_id`/`op` 后余下作为 args 交给 `object_storage_ds::commands::execute`。
- 不含 `health`（探活留在管理端 / 令牌面）。

## Engine rules

1. `NodeType::ObjectStorage`（serde: `object_storage`）
2. `fetch_active_for_tenant(pool, connection_id, ctx.tenant_id)`；缺 tenant_id → 错误
3. `(dry_run || prod_readonly) && is_write_op(op, args)` → mock `{ op, result: null, dry_run|blocked_by }`
4. 输出 `{ "op", "result" }`；限额复用 commands 层

## UI / MCP

- 调色板「集成」加入 `object_storage`
- `NodeConfigPanel`：连接下拉 + op + 按 op 字段（同 Redis 模式）
- `mcp_tools.rs` 节点说明

## Out of scope

对象存储 trigger、multipart/copy/head、节点内 token ACL。
