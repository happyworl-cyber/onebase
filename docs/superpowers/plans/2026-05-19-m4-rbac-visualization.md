# M4 RBAC 可视化配置 — Beta v1

> **REQUIRED SUB-SKILL:** superpowers:executing-plans

**目标**：让项目 owner / admin 用**可视化矩阵 + 结构化条件构建器**配置 RBAC，而不是当前的"字符串裸 SQL + 列表 + 4 个文字模板"。这是 Beta 阶段客户试点最关心的安全面。

**关联**：
- 母 spec §2.3 M4：4 个核心界面（角色管理 / 权限矩阵 / 行级条件构建器 / 列级可见性）+ 5 个开箱模板
- spec §3 Beta 出口标准："完整 RBAC 可视化"
- 上游 `mvp-overview.md` Beta 占位（待写 Beta-overview）

---

## 0. 现状盘点（开 plan 前已确认）

| 区块 | 现状 | 缺口 |
|---|---|---|
| 后端 `permissions::parse_row_conditions` | ✅ 已严格要求结构化对象 `[{field, op, value}, ...]`；line 226 注释明示"不再支持任何形式的字符串裸 SQL" | **无后端 work**——条件解析、占位符替换、列控制全部就绪 |
| 后端 `Permission.conditions` 列 | ✅ `serde_json::Value`，可装数组对象 | ✅ |
| 后端 `RowOp` 枚举 | ✅ Eq / Neq / Gt / Gte / Lt / Lte / In / IsNull / IsNotNull | ✅ |
| 占位符替换 | ✅ `$current_user_id` 自动替换；可扩展更多变量 | M4 v1 暂不引新变量 |
| `lib/api.ts::rbacAPI` 类型 | ❌ `conditions?: string[]` —— 与后端实际期望 `Vec<RowCondition>` **不匹配** | **必须先修类型，否则前端永远生成不合法 payload** |
| `frontend/security/roles/page.tsx`（307 行）| ✅ 角色 CRUD + 用户分配 UI | 缺权限矩阵视图——看不到"角色 × 权限" 的对齐 |
| `frontend/security/rls/page.tsx`（375 行）| ⚠️ "行级条件" 是 `string` 输入 + 4 个文字模板；列级是逗号分隔字符串 | 必须改成结构化 builder + 5 个真正的模板 + 列级 click-to-deny |
| 后端 `rbac_handlers` | ✅ 16 个 endpoint（roles / permissions / role-permissions / user-roles / merge）齐全 | 无 |

**核心洞察**：后端 RBAC 模型已是 spec 要求的"结构化 DSL"；前端只是没有把 UI 跟上。M4 v1 = 纯前端工程。

---

## 1. 决策摘要

| 决策点 | 选定 | 含义 |
|---|---|---|
| 矩阵布局 | **角色 tab + 单一矩阵**（rows = schema.table 资源；cols = SELECT/INSERT/UPDATE/DELETE/ALL） | 让"角色管理 + 权限矩阵"集成于一页（`/security/roles`），减少跳转 |
| 旧 conditions 迁移 | **渐进**：新建/编辑只用 builder；后端遇到旧字符串数据时 runtime 会自然拒绝（其实自 W4 起就在拒绝），UI 显示 "legacy 字符串 (只读 - 请重建)" + 一键转结构化的快速向导 | 不动数据，让用户自然替换 |
| 列级控制 | **deny-first**：默认"显示全部，可勾选隐藏"（denied_columns 黑名单）；高级开关切到 allowlist 模式（allowed_columns 白名单） | 心智简单 + 灵活兜底 |
| 5 模板实现 | **前端 inline TS 常量**：按"应用模板"后填进 builder，用户调整后照常 POST `/api/rbac/permissions`。无后端改动 | 模板与业务字段假设耦合（如 `department_id`），存前端便于按客户调整 |

---

## 2. 范围

### 做（Beta v1）

**前端类型 + API 矫正**：
- `lib/api.ts`：`Permission` / `RowCondition` 等类型与后端 1:1 对齐；`createPermission` / `updatePermission` 改 `conditions: RowCondition[]`
- 新 `lib/rbac/templates.ts`：5 个模板（仅自己 / 同部门 / 同租户 / 公开只读 / 禁止）作为 TS 常量

**共享组件**：
- `components/rbac/ConditionBuilder.tsx`：通用结构化条件 builder（[字段][运算符][值] 多行 + 添加/删除）
- `components/rbac/ColumnControl.tsx`：列级可见性选择器（deny-first，可切 allow-mode）
- `components/rbac/PermissionMatrix.tsx`：resource × action 矩阵

**页面重做**：
- `/security/roles/page.tsx`：保留角色 CRUD；下方加 **per-role 权限矩阵**（每个 role 一个 tab，矩阵 cell 显示 `✅ / 条件✔ / 列限制✔ / ⛔`，点 cell 进入编辑 drawer 复用 `ConditionBuilder` + `ColumnControl`）
- `/security/rls/page.tsx`：保留"权限定义列表"，但 **创建/编辑 drawer 改用 ConditionBuilder + ColumnControl + 模板下拉**

**模板系统**：5 个模板按下后**填进 builder**——用户能看到展开后的结构、可微调再保存。这种"半自动"比一键写入更安全。

### 不做（明确推后）

- ❌ ABAC 复杂表达式（如：`(role.is_admin OR (department=$dept AND time BETWEEN ...))` — 留 v2）
- ❌ 字段级 mask（如 ssn 显示 ****）—— 仅做 hide / show；mask 留 v2
- ❌ 多 schema 跨数据库的全局视图 —— 矩阵以当前 currentSchema 范围
- ❌ 权限审计 diff —— 留 v2.x
- ❌ 测试：模拟某用户能看到哪些行 —— 留 v2

---

## 3. 数据形状

### 3.1 后端期望（既有，无变动）

```jsonc
// management.permissions.conditions (Vec<RowCondition>)
[
  { "field": "author_id", "op": "=",   "value": "$current_user_id" },
  { "field": "status",    "op": "in",  "value": ["published","draft"] },
  { "field": "deleted_at", "op": "isnull" }
]

// management.permissions.allowed_columns (Option<Vec<String>>)
// null  → 全部可见
// []    → 全部不可见
// ["id","title"] → 仅这些可见
//
// management.permissions.denied_columns (Vec<String>)
// 黑名单：在 allowed 基础上再删；通常二选一更清晰
```

### 3.2 前端 TS（要新加）

```ts
export type RowOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'isnull' | 'isnotnull'
export interface RowCondition { field: string; op: RowOp; value?: unknown }
export type ColumnMode = 'deny' | 'allow'  // UI 端的二选一切换
```

---

## 4. 实施顺序（4 phase / 4 commit）

### Phase 1 — Plan + types + ConditionBuilder + ColumnControl + templates（~1 day）

- [ ] 1.1 写本 plan
- [ ] 1.2 `lib/api.ts`：`RowCondition` + 修 `rbacAPI` 的 conditions 类型；导出 `Permission` 类型
- [ ] 1.3 `lib/rbac/templates.ts`：5 个 PermissionTemplate 常量 + 应用函数
- [ ] 1.4 `components/rbac/ConditionBuilder.tsx`（~150 行）：通用结构化条件输入
- [ ] 1.5 `components/rbac/ColumnControl.tsx`（~120 行）：deny-first 列控制
- [ ] 1.6 `tsc` 干净
- [ ] 1.7 Commit：`feat(m4): rbacAPI types + ConditionBuilder/ColumnControl/templates primitives`

### Phase 2 — 权限矩阵 + roles 页升级（~1 day）

- [ ] 2.1 `components/rbac/PermissionMatrix.tsx`（~200 行）：per-role tab + resource × action grid
- [ ] 2.2 `app/workspace/[projectId]/security/roles/page.tsx`：在现有角色列表下加矩阵区
- [ ] 2.3 矩阵 cell 点击 → 复用 rls drawer 进行条件 / 列编辑
- [ ] 2.4 `tsc` 干净
- [ ] 2.5 Commit：`feat(m4): PermissionMatrix component + roles page matrix view`

### Phase 3 — rls 页 drawer 改用 builder + 模板下拉（~1 day）

- [ ] 3.1 `app/workspace/[projectId]/security/rls/page.tsx` 重做 drawer：
  - 删字符串模板下拉，替成"应用模板"按钮 → 选 5 个之一 → 填进 ConditionBuilder
  - 旧字符串 conditions 显示成只读 chip + "转结构化"快速向导（解析 `field op value` 三段式，失败时提示手动重建）
  - 列级 UI 用 ColumnControl
- [ ] 3.2 列表展示：cell 显示结构化条件的人类可读形式（`author_id = me`），而不是 raw object
- [ ] 3.3 `tsc` 干净
- [ ] 3.4 Commit：`feat(m4): rls page — structured condition builder + templates + column control`

### Phase 4 — 文档同步 + 真机 smoke（~0.5 day）

- [ ] 4.1 写 `tests/m4_rbac_smoke.sh`：5 个 scenarios（建带条件的 permission / list / merge 含 $current_user_id 替换 / 删 / 角色绑定）
- [ ] 4.2 mvp-overview 加 Beta 阶段进度表（M4 标 ✅，M5/M6完整/M7 ⏳）
- [ ] 4.3 spec §2.3 M4 加 ✅ + v1 实施备注
- [ ] 4.4 本 plan 加 §6 实施记录
- [ ] 4.5 Commit：`docs(m4): mark M4 complete + smoke script`

---

## 5. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 旧 string conditions 在线上未迁完 → runtime 拒绝 | 已经在拒绝（W4 起）；UI 显示 legacy chip 引导用户重建。如需平滑可加迁移脚本（留 follow-up） |
| 模板假设字段（`department_id` 等）不一定存在 | 模板按下时只填 builder，不直接保存——用户能看到不存在字段时改成自己的字段 |
| 矩阵在表多时巨大 | 仅显示有权限定义的资源 + "+ 新增资源"按钮；不试图列出所有表 |
| ColumnControl 需要列名 → 走 schemaAPI.getTableStructure | 仅在 drawer 打开时拉一次；缓存 5 分钟 |

### 不阻塞 Phase 1 的开放问题

- [ ] **跨 schema 的资源前缀**：当前 resource = "public.posts"。M3 后用户可能创建多 schema。需确认 ConditionBuilder 在编辑时按 `currentSchema` 切换字段候选——后续 Phase 3 再处理
- [ ] **角色继承**：spec 没要求；v1 不做
- [ ] **导出 / 导入 RBAC 配置**：留 v2.x

---

## 6. 验收标准

- ✅ 项目 owner / admin 能在 `/security/roles` 看到 per-role 矩阵；点 cell 编辑权限
- ✅ ConditionBuilder 输出严格符合 backend `RowCondition` 形状；后端 `parse_row_conditions` 不报错
- ✅ ColumnControl 在 deny-first 模式默认；切到 allow-mode 后单独管理 allowed_columns
- ✅ 5 个模板都能应用 + 用户能继续微调
- ✅ tsc / cargo build 干净
- ✅ `tests/m4_rbac_smoke.sh` 全绿

---

## 7. 实施记录（2026-05-19）

| Phase | Commit | 说明 |
|---|---|---|
| Phase 1 | `7966569` | plan + rbacAPI 类型 + ConditionBuilder/ColumnControl/templates primitives；rls 页临时桥接（提交时强制空 conditions + 升级横幅） |
| Phase 2 | `d3bc78c` | PermissionMatrix（per-role tab + resource × action grid + cell badge）+ roles 页集成（批量预拉 rolePermissionIds 用于 owned 判断） |
| Phase 3 | `ece4e49` | rls 页 drawer 整体重写：删 4 个字符串模板，换 PERMISSION_TEMPLATES；行级条件用 ConditionBuilder；列控制用 ColumnControl；列表行 PermissionRow 显示结构化条件 + legacy 字符串分通道 |
| Phase 4 | （本 commit） | `tests/m4_rbac_smoke.sh`（7 个 case 覆盖 create / update / role 绑定 / legacy / 非 admin / cleanup）+ spec / mvp-overview 同步 + 本节实施记录 |

### 关键决策回顾

- **后端零改动证实**：开 plan 时盘点出 `parse_row_conditions` 自 W4 起已严格要求结构化对象、严拒裸 SQL。M4 真正 v1 = TS 类型修正 + 前端 builder + 矩阵 UI，估时从 1.5-2 周降到 ~3 天
- **共享组件优先**：先做 `ConditionBuilder` / `ColumnControl` 两个 primitive（Phase 1），再让 rls 页和矩阵 cell drawer 都复用，避免后续 Phase 2/3 之间发散
- **legacy 字符串透明降级**：UI 显式 chip + 删除线 + 提示运行时已被后端拒绝，引导用户用新 builder 重建。**不写自动迁移脚本**（避免猜测的解析错误）
- **模板半自动**：模板按下填进 builder（不直接 POST），让用户看到展开后的字段 + 微调（特别是 `department_id` 这类业务假设字段）

### 已知 follow-up（不阻塞 Beta 出口）

- [ ] 矩阵在表多时（>50 资源）需虚拟滚动 —— v1 仅展示有权限定义的资源 + 手动添加；表多场景留 v1.x
- [ ] 用户视图模拟（"以 X 用户身份看哪些行"）—— v2
- [ ] RBAC 配置 diff / 导入 / 导出 —— v2.x
- [ ] 字段级 mask（如 ssn 显示 ****）—— v2，需后端 column-projection rewriter 配合
- [ ] ConditionBuilder 的 value 类型推断：当前只在三种数字/字符串之间猜，复杂类型（如 array of object）走不通——v1 可接受
- [ ] 旧字符串条件的迁移脚本：如客户 PoC 数据库已有遗留，提供 `migrate_legacy_permissions.sh` —— 留 follow-up

---

*Beta 出口的"完整 RBAC 可视化"在 M4 落地后达成。下一站 M5 Webhook 面板。*
