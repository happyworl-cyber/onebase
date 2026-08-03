# PG 行 JSON 解码补全 smallint（及 float4）

状态：已实现  
日期：2026-07-29  
关联：`src/pg_row_json.rs`（`db_query` / Auto API / `/query` / RPC 共用）

## 背景

测试环境工作流对比发现：menu 行 `carousel_switch` 等五列 DB 真值为 `1`，`db_query` 返回 `null`。五列均为 Postgres `smallint`（`int2`）。

根因：`decode_pg_value` 按类型 `try_get` 时覆盖了 `i32`/`i64`，未覆盖 `i16`。sqlx 对 `int2` 只接受 `i16`，解码失败落到函数末尾的 `Value::Null`。与历史上漏解 `uuid` 同属「静默丢真值」类问题。

实际影响面（业务侧）：`hotType` 热点标识（全库约 1 个栏目）+ `carousel` 相关约 10 个栏目；修前不建议切流。

## 目标

- 在统一解码路径补 `i16` / `Option<i16>`，使 `smallint`/`int2` 序列化为 JSON number。
- 顺带补 `f32` / `Option<f32>`（`real`/`float4`），避免同类静默丢值。
- 调用方无需改动；业务工作流 SQL 无需 `::int` cast。

## 非目标

- 不改业务工作流 SQL / #49 / 切流 flag。
- 不一次性扫完所有未覆盖 PG 类型（如 `numeric`、`bytea`、自定义 domain）；未知类型仍回退 `null`。
- 不改 MySQL 行解码路径。

## 决策

| 项 | 结论 |
|----|------|
| 改动文件 | 仅 `src/pg_row_json.rs` |
| 新增分支 | `i16`、`Option<i16>`；`f32`、`Option<f32>` |
| 放置位置 | 紧挨现有 `i32`/`i64`（及 `f64`）分支，保持「非 Option 先于 Option」顺序 |
| JSON 形态 | number（与现有整数/浮点一致） |
| 验证 | 断言 `1::smallint`（及 `1::real`）经 `pg_row_to_json` 为 number 非 null；UUID 等既有分支不变 |

## 成功标准

- menu 类 `white_switch` / `show_type` / `hot_type` / `permission_switch` / `carousel_switch` 在工作流 `db_query` 返回中与 DB 真值一致。
- 无需在 SQL 中对上述列加 `::int`。

## 风险

- 极低：仅扩展解码白名单；已能解的类型路径不变。
- 若存在依赖「smallint 曾被错误当成 null」的下游，修后行为会变为正确数值——视为 bugfix，不视为破坏性变更。
