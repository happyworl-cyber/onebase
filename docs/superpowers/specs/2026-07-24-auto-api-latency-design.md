# Auto API 列表延迟优化设计

状态：已实现
日期：2026-07-24
关联：`src/middleware.rs`、`src/rbac_middleware.rs`、`src/auto_api_handlers.rs`

## 背景与动机

生产环境调用：

```
GET /api/v1/uba/public/uba_alert_rules?target_type.eq=card&target_id.eq=...&order=created_at.desc
```

access log 显示 `elapsed_ms ≈ 4290`，而目标表仅数行数据。抓包显示 app → 租户 PG 串行执行 `set_config` → `COUNT(*)` → `SELECT *`，单次 RTT 约 180–350ms。

代码审计进一步发现：同一 `ob_` API Key 在单次请求内被 **多次** 查询 `management.api_keys`（`auth_middleware`、slug 解析、`rbac_middleware`、`validate_auth`），管理库往返叠加后总耗时可达数秒。根因是「聊天式串行查询 × 高 RTT」，不是表数据量大。

## 目标

- 单次 `ob_` Auto API 请求对 `management.api_keys` 最多查询 **1 次**（发生在 `auth_middleware`）。
- 列表支持 PostgREST 风格 `Prefer: count=...`；在「精确总数」且结果未满页时跳过 `COUNT(*)`，客户端无需改动即可受益。
- 默认行为对现有客户端兼容（缺省仍要精确 total）。

## 非目标

- 不改造 JWT 用户 RBAC 主路径的查询模式（本次只消重 `ob_`）。
- 不解决跨可用区 / 跨公网 RTT（部署侧）。
- 不把 `set_config` 与业务 SQL 合并为单次协议往返（可后续单独做）。
- 不实现真正的 `count=planned` / `count=estimated` 估算逻辑。

## 关键设计决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 优化范围 | A（`ob_` 鉴权消重）+ B（Prefer / 智能跳过 COUNT）一起做 |
| 2 | `ApiKeyContext` 扩展 | 增加 `permissions`、`bound_slug`；由 `authenticate_cr_api_key` 一次查出 |
| 3 | 下游短路 | slug 解析 / rbac / `validate_auth` 有 `ApiKeyContext` 则不再查 `api_keys` |
| 4 | `last_used_at` | handler 内同步 UPDATE 删除；仅保留 auth 中已有的 spawn 节流更新 |
| 5 | Prefer 默认 | 缺省 = `count=exact`（兼容） |
| 6 | 未满页跳过 COUNT | `exact` 且 `rows.len() < limit` → `total = offset + rows.len()`，不再发 COUNT |
| 7 | `planned` / `estimated` | 本期与 `exact` 同等对待 |
| 8 | 执行顺序 | 事务内先 `set_config` + `SELECT`，再按需 `COUNT` |

## 架构

### A. `ob_` 鉴权消重

```
auth_middleware
  └─ authenticate_cr_api_key  (唯一一次查 api_keys)
       注入 Claims + ApiKeyContext{ key_id, tenant_id, database_id, permissions, bound_slug }
            │
            ├─ resolve_database_id_from_slug  → 比对 bound_slug，返回 database_id
            ├─ rbac_middleware                → 用 ctx.permissions 做 scope
            └─ validate_auth                 → 校验 ctx.database_id == path database_id
```

无 `ApiKeyContext` 时（JWT、或测试未挂完整链）保持现有查库逻辑，避免破坏遗留路径。

### B. 列表 COUNT

```
Prefer: count=none     → 只 SELECT；Content-Range 用 *；JSON count=null
Prefer: 缺省/exact     → SELECT 后：
                         rows.len() < limit  → total = offset + len（无 COUNT）
                         否则                → COUNT(*)
Prefer: planned|estimated → 本期同 exact
```

`list_records` 与 `list_records_pgrest` 共用同一决策；pgrest 继续把 total 写到 `Content-Range`。

## 组件与改动面

| 组件 | 改动 |
|------|------|
| `ApiKeyContext` | 新增字段；构造处补齐 |
| `authenticate_cr_api_key` | SELECT 增加 `permissions`、`td.slug` |
| `resolve_database_id_from_slug` | 优先读 Extension / 传入的 context |
| `rbac_middleware` | `ob_` 分支优先用 context |
| `validate_auth` | 接受可选 `ApiKeyContext`；有则短路；去掉同步 UPDATE |
| `list_records` | 解析 Prefer；SELECT 优先；条件 COUNT |
| Prefer 解析 helper | 新建小函数（可放 `auto_api_handlers` 或 `postgrest_compat`） |

## 错误处理

- slug 与 `bound_slug` 不匹配：保持现有 Forbidden 文案。
- Key 无效 / 过期：仍只在 auth 阶段失败；下游假定 context 已合法。
- COUNT 失败：与现网一致，整请求失败（不可吞错导致事务 aborted）。

## 测试

- Prefer 解析：`exact` / `none` / `planned` / `estimated`、逗号多值、大小写。
- `ob_` 消重：有 context 时 slug / rbac / validate_auth 不发起 `api_keys` 查询。
- 列表：未满页无 COUNT 且 total 正确；满页仍 COUNT；`count=none` → `*` / `null`。
- 回归：JWT 列表、scope 拒绝、slug 不匹配错误语义不变。

## 上线与观测

- 无 migration。
- 上线后对比同接口 `elapsed_ms`。
- 可选临时 debug：是否跳过 COUNT、是否命中 ApiKeyContext 短路（验证后降级或删除）。

## 风险

- 依赖精确 total 的客户端：未满页仍准确；满页与现网一致。
- 主动声明 `count=none` 的客户端拿不到 total——仅 opt-in。
