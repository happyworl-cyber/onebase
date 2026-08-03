# M3 可视化建表（Visual Schema Editor）— v1

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development / superpowers:executing-plans

**目标**：让走完 M2 拿到空项目的开发者，**找得到、用得明白**地建第一张表 → 改字段 → 看 ER 图。这是 MVP 出口 "登录 → 建项目 → 建表 → 查 API → 看大盘" 中"建表"这一步真正连通。

**关联**：
- 母 spec §2.3 M3：复用 `schema_handlers` + `index_handlers` + ER 编辑器（自研轻量版）
- 上游 `mvp-overview.md` Plan 3（待写槽位）
- 依赖：M1 全套（W1-W4）+ M2 onboarding wizard

---

## 0. 现状盘点（开 plan 前已确认）

| 区块 | 现状 | 缺口 |
|---|---|---|
| Backend `schema_handlers` | ✅ list_schemas / create_schema / drop_schema / list_tables / get_table_structure / get_table_relationships 都在；`create_schema` 走 require_database_admin | ❌ 缺 dedicated **CREATE / DROP / ALTER TABLE** endpoint —— 现状要走 `/query`（仅超管，普通项目 owner 都建不了表） |
| Backend `index_handlers` | ✅ list/create/drop_index 完整 | ✅ 复用即可 |
| 前端 `/database/table-designer/page.tsx` | ✅ 682 行 DDL 生成器，create 模式可用 | ❌ 调 `queryAPI.execute()` 即 `/query`，对非超管 403；edit 模式只是 DROP+CREATE stub |
| 前端 `/database/visualizer/page.tsx` | ✅ ER 图（reactflow），只读 | ⚠️ 空状态无 CTA |
| 前端 `/database/tables/page.tsx` | ✅ 表列表 + 行编辑器 | ❌ 空状态无 CTA；无 "+ 新建表" 按钮 |
| Sidebar | ✅ 表 / 关系图 入口 | ❌ 没有 "表设计器" 入口（用户找不到 `/database/table-designer`） |

---

## 1. 决策摘要（实施前已对齐）

| 决策点 | 选定方案 | 含义 |
|---|---|---|
| ALTER TABLE 范围 | **极简安全集** | 仅 ADD COLUMN / DROP COLUMN / SET NULL / DROP NOT NULL / SET DEFAULT。**不做** 改列名 / 改列类型 / 重排序（这些有数据损失风险，留 v1.x 配迁移预览再做） |
| Discoverability | **sidebar + 空状态双重保险** | sidebar 加 "表设计器" 入口；`tables/` 和 `visualizer/` 空状态加 "新建表" CTA。项目首页不动 |
| ER 交互 | **v1 不做点击跳转** | visualizer 继续只读；用户必须经 sidebar 或 tables 页进 designer |
| DDL 权限闸 | **member+** | owner / admin / **member** 都能建表 / 改表；viewer 只读。对照 `create_schema` 的 admin+：M3 这里 schema 边界以**业务表 vs 平台 schema** 划分——schema 是项目级配置（admin+），表是业务对象（member+） |

---

## 2. 范围

### 做（v1）

**后端新增**：
- `permissions::require_tenant_member` + `require_database_member`（member+ 含 owner/admin/member）
- 4 个项目级 DDL endpoint（不走 `/query`，因为它是超管 only）：
  - `POST   /api/ddl/tables`               — 建表（CREATE TABLE 模板 + 列定义 + FK + index 一次完成）
  - `DELETE /api/ddl/tables/:schema/:name` — 删表
  - `PATCH  /api/ddl/tables/:schema/:name` — ALTER TABLE（极简集）
  - 鉴权：`require_database_member`；DDL 拼接 100% 通过 `quote_ident()` 走 query_builder，不接受 raw SQL
- 这套 endpoint 复用现有 `dynamic_db_middleware`（`X-Database-Id` 头切库）

**前端**：
- `WorkspaceSidebar`：在"数据库"分组加 "表设计器" 入口，icon `fa-pen-ruler`
- `app/workspace/[projectId]/database/tables/page.tsx`：
  - 顶部加 "+ 新建表" 按钮 → `/database/table-designer?mode=create`
  - 空状态文案 + CTA 改写：从"当前 Schema 没有表" → "0 张表 / 点击下方按钮建第一张" + CTA
- `app/workspace/[projectId]/database/visualizer/page.tsx`：
  - 空状态 CTA → 跳 table-designer
- `app/workspace/[projectId]/database/table-designer/page.tsx`：
  - 改调新的 `/api/ddl/tables` 而不是 `/query`
  - URL 参数支持 `?mode=create` / `?mode=edit&table=foo`，深度链接
  - edit 模式：从 stub 改成**真实 ALTER**（极简集 4 类操作），UI 改成"原列只读 + 在末尾加新列" + "可对原列改 NOT NULL / DEFAULT / 删列"
  - 执行按钮 `disabled={!canWriteDdl}`，给非 member+ 角色禁用
- `lib/permissions.ts` `WorkspaceCapabilities`：加 `canWriteDdl: boolean`（member+）
- `lib/api.ts`：`ddlAPI.{createTable, dropTable, alterTable}`

### 不做（明确推后）

- ❌ 改列名、改列类型、重排序列（v1.x 加迁移预览后再做）
- ❌ ER 图节点点击 → 跳 designer（v1 静态）
- ❌ ER 图内拖拽连线建外键（v2+）
- ❌ 视图 / 物化视图 / 分区表 / 继承（v2+）
- ❌ JSONB / Array / Enum 等高级类型的可视化（v1 用户能选 jsonb 但只是 text input；定制 UI 留 v1.x）
- ❌ 一键回滚 / DDL 历史（v2 RBAC + audit 联动）

---

## 3. 后端设计

### 3.1 新增 permission helper

`src/permissions.rs` 加两条：

```rust
pub async fn is_tenant_member(pool: &PgPool, user_id: i32, tenant_id: i32) -> Result<bool>;
pub async fn require_tenant_member(pool: &PgPool, claims: &Claims, tenant_id: i32) -> Result<()>;
pub async fn require_database_member(pool: &PgPool, claims: &Claims, database_id: i32) -> Result<()>;
```

`is_tenant_member` 含 owner/admin/member 三个角色（**不**含 viewer）。与现有 `is_tenant_admin`（owner+admin）形成层级。

### 3.2 DDL handlers 模块

新文件 `src/ddl_handlers.rs`：

```rust
#[derive(Deserialize)]
pub struct CreateTableRequest {
    pub schema: String,
    pub table: String,
    pub columns: Vec<ColumnDef>,
    pub indexes: Vec<IndexDef>,
    pub comment: Option<String>,
}

#[derive(Deserialize)]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,    // serial / integer / varchar / text / bool / timestamp / jsonb / uuid / ...
    pub length: Option<i32>,  // varchar(n) / char(n)
    pub precision: Option<i32>, pub scale: Option<i32>,   // numeric(p,s)
    pub nullable: bool,
    pub default_value: Option<String>,  // 字面量；SQL 表达式（CURRENT_TIMESTAMP 等）走白名单
    pub is_primary_key: bool,
    pub is_unique: bool,
    pub references: Option<ForeignKeyRef>,
}

#[derive(Deserialize)]
pub struct ForeignKeyRef {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub on_delete: Option<String>,    // CASCADE / SET NULL / NO ACTION
    pub on_update: Option<String>,
}

#[derive(Deserialize)]
pub struct IndexDef {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
}

pub async fn create_table(
    State(main_pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    db_id: Option<Extension<CurrentDatabaseId>>,
    dynamic_pool: Option<Extension<PgPool>>,
    Json(req): Json<CreateTableRequest>,
) -> Result<Json<serde_json::Value>>;

pub async fn drop_table(/* path: (schema, table); 同样校验 */) -> Result<Json<...>>;

#[derive(Deserialize)]
pub struct AlterTableRequest {
    /// v1 极简集；服务端按数组顺序串行执行
    pub operations: Vec<AlterOp>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AlterOp {
    AddColumn { column: ColumnDef },
    DropColumn { name: String, cascade: bool },
    SetNotNull { name: String, value: bool },           // true = SET NOT NULL；false = DROP NOT NULL
    SetDefault { name: String, value: Option<String> }, // None = DROP DEFAULT
}

pub async fn alter_table(...) -> Result<Json<...>>;
```

**安全要点**：
- 所有标识符（schema/table/column/index 名）过 `is_valid_pg_ident()` 正则，然后 `format!(r#""{}""#, ident)` 加引号
- 数据类型走**白名单**：`["serial", "bigserial", "smallserial", "integer", "bigint", "smallint", "numeric", "real", "double precision", "text", "varchar", "char", "boolean", "date", "time", "timestamp", "timestamptz", "uuid", "json", "jsonb", "bytea", "inet"]`；越界直接 400
- `default_value` 视作字面量并 `quote_literal()` 包；如果是表达式（`CURRENT_TIMESTAMP` / `now()` / `gen_random_uuid()`），过白名单后原样拼
- `on_delete` / `on_update` 走白名单 `["CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT", "NO ACTION"]`
- 在管理库 `management.tenants` 这种平台 schema 上的写 DDL **额外**校验：禁掉 schema 前缀为 `pg_*` / `information_schema` / `management` 的库，避免普通项目 member 改坏平台数据
- 所有 DDL 用单一事务包裹（PG CREATE TABLE + CREATE INDEX 都支持事务内执行）
- 写 `audit_log`（action = `DDL_CREATE_TABLE` / `DDL_ALTER_TABLE` / `DDL_DROP_TABLE`）

### 3.3 路由注册

在 `main.rs` 的"业务级路由组"（带 dynamic_db_middleware + auth_middleware，不走 superadmin gate）里加：

```rust
.route("/api/ddl/tables", post(ddl_handlers::create_table))
.route(
    "/api/ddl/tables/:schema/:table",
    delete(ddl_handlers::drop_table).patch(ddl_handlers::alter_table),
)
```

handler 内部走 `require_database_member`。

### 3.4 现有 `/query` 不动

`/query` 是 raw SQL 通道，spec 红字写明"仅超管"。本 plan **明确不放宽** `/query`——通过补 dedicated 安全 DDL endpoint 解决，不破坏既有信任边界。

---

## 4. 前端设计

### 4.1 `lib/permissions.ts`

```ts
export interface WorkspaceCapabilities {
  canManageProjectSettings: boolean // owner+
  canManageMembers: boolean          // admin+
  canManageSecurity: boolean
  canManageEvents: boolean
  canWriteDdl: boolean               // NEW (member+)
  canWriteDatabase: boolean
  canCallApi: boolean
}

// deriveWorkspaceCapabilities：
canWriteDdl: r >= WORKSPACE_ROLE_ORDER.member,
```

### 4.2 `lib/api.ts`

```ts
export interface DdlColumnDef { /* ... 与后端字段 1:1 ... */ }
export interface DdlIndexDef { /* ... */ }
export interface DdlForeignKeyRef { /* ... */ }

export type AlterOp =
  | { kind: 'add_column'; column: DdlColumnDef }
  | { kind: 'drop_column'; name: string; cascade?: boolean }
  | { kind: 'set_not_null'; name: string; value: boolean }
  | { kind: 'set_default'; name: string; value: string | null }

export const ddlAPI = {
  createTable: (body: { schema, table, columns, indexes, comment? }) =>
    api.post('/api/ddl/tables', body),
  dropTable: (schema: string, table: string) =>
    api.delete(`/api/ddl/tables/${schema}/${table}`),
  alterTable: (schema: string, table: string, operations: AlterOp[]) =>
    api.patch(`/api/ddl/tables/${schema}/${table}`, { operations }),
}
```

### 4.3 Sidebar 入口

`WorkspaceSidebar.tsx` 数据库分组加：

```ts
{ label: '表设计器', href: '/database/table-designer', icon: 'fas fa-pen-ruler' }
```

放在 "表" 和 "关系图" 之间。

### 4.4 `tables/page.tsx` 改造

- 顶部工具栏：搜索框旁加 `"+ 新建表"` 主 CTA → `router.push('/database/table-designer?mode=create')`
- 网格视图的 hover 操作菜单加"编辑结构"按钮 → `router.push('/database/table-designer?mode=edit&table={name}')`
- 空状态加"开始建第一张表"主 CTA

### 4.5 `visualizer/page.tsx` 空状态

```tsx
<p>当前 Schema 没有数据表</p>
<button onClick={() => router.push('/database/table-designer?mode=create')} className="btn-primary mt-3">
  <i className="fas fa-plus mr-2"></i> 建第一张表
</button>
```

### 4.6 `table-designer/page.tsx` 大改

1. **URL 参数支持**：
   ```ts
   const params = useSearchParams()
   useEffect(() => {
     const m = params.get('mode')
     const t = params.get('table')
     if (m === 'create') startCreateTable()
     else if (m === 'edit' && t) startEditTable(t)
   }, [params])
   ```

2. **改调用 endpoint**：把 `await queryAPI.execute(generatedSQL)` 改为：
   ```ts
   if (mode === 'create') await ddlAPI.createTable({...})
   else await ddlAPI.alterTable(schema, tableName, alterOps)
   ```
   DDL 字符串 preview 用作"用户可读的预演"，但实际提交走结构化 body。

3. **edit 模式 ALTER 极简集 UX**：
   - 原列展示在表格里，每行显示 [列名][类型][nullable][默认][主键标记]，外加：
     - "设为 NOT NULL" / "允许 NULL" 切换（按当前状态显示反向操作）
     - "改默认" inline 编辑
     - "删除列" 按钮（弹 confirm + CASCADE 复选框）
   - **不允许**改列名、改列类型——按钮灰掉，提示 "v1 不支持，请走 SQL 编辑器"
   - 列表底部 "+ 添加列" 按钮，新增列填到一组待提交的 `AddColumn` 操作
   - "保存" 按钮：把待添加列 + 待修改的 NOT NULL/DEFAULT/DROP 收集成 `AlterOp[]` 一次 PATCH
   - SQL Preview 模式仍可看到将要执行的 DDL（按 ops 顺序拼一遍 ALTER TABLE 给用户预演）

4. **执行按钮 gating**：
   ```tsx
   const { canWriteDdl } = useCurrentProjectCapabilities()
   <button disabled={!canWriteDdl} title={!canWriteDdl ? '需 member+ 权限才能执行 DDL' : undefined}>
   ```

---

## 5. 实施顺序（5 phase / 5 commit）

### Phase 1 — Plan + backend permission helpers（~0.5 day）

- [ ] 1.1 写本 plan
- [ ] 1.2 `permissions.rs` 加 `is_tenant_member` / `require_tenant_member` / `require_database_member`
- [ ] 1.3 cargo build 干净
- [ ] 1.4 Commit：`feat(m3): plan + tenant_member permission helpers`

### Phase 2 — backend DDL endpoints（~1-1.5 day）

- [ ] 2.1 `ddl_handlers.rs`：3 个 handler（create / drop / alter）+ 数据类型/操作白名单 + 标识符校验
- [ ] 2.2 `main.rs` 注册路由（业务路由组里，require_database_member）
- [ ] 2.3 cargo build 干净
- [ ] 2.4 shell smoke `tests/m3_ddl_test.sh`（建表 / 加列 / 改 NULL / 删列 / 删表 / 鉴权 / 黑名单 schema）
- [ ] 2.5 Commit：`feat(m3): backend DDL endpoints (create/drop/alter table)`

### Phase 3 — frontend api.ts + permissions + sidebar（~0.5 day）

- [ ] 3.1 `lib/api.ts` 加 `ddlAPI` + 类型
- [ ] 3.2 `lib/permissions.ts` 加 `canWriteDdl`
- [ ] 3.3 `WorkspaceSidebar.tsx` 加"表设计器"入口
- [ ] 3.4 tsc 干净
- [ ] 3.5 Commit：`feat(m3): frontend ddlAPI + canWriteDdl + sidebar entry`

### Phase 4 — table-designer 大改（~1.5 day）

- [ ] 4.1 URL 参数支持（`useSearchParams`）
- [ ] 4.2 create 模式改调 `ddlAPI.createTable`（保留 DDL 预览作可读层）
- [ ] 4.3 edit 模式真正做 ALTER（极简集 UX + AlterOp 收集器）
- [ ] 4.4 执行按钮按 canWriteDdl gate
- [ ] 4.5 tsc 干净
- [ ] 4.6 Commit：`feat(m3): table-designer — URL params + real ALTER + role gate`

### Phase 5 — discoverability + 文档（~0.5 day）

- [ ] 5.1 `tables/page.tsx` 顶部 "+ 新建表" + 空状态 CTA + 行操作"编辑结构"
- [ ] 5.2 `visualizer/page.tsx` 空状态 CTA
- [ ] 5.3 tsc 干净
- [ ] 5.4 mvp-overview Plan 3 改 ✅
- [ ] 5.5 spec §2.3 M3 加 ✅ 标记 + v1 实施备注
- [ ] 5.6 本 plan 加 §7 实施记录 + commit 表
- [ ] 5.7 Commit：`feat(m3): tables/visualizer entry points + docs sync`

---

## 6. 风险与开放问题

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 普通 member 跑 DDL 破坏其他成员的工作 | 中 | M4 完整 RBAC 时再细化（列级 grant / approval flow）；v1 接受 |
| ADD COLUMN NOT NULL 没默认值会卡死非空表 | 中 | 后端检查：如果 NOT NULL 且无 DEFAULT 且表非空 → 拒绝 + 明确提示走两步（先加可空列填充再 SET NOT NULL） |
| DROP COLUMN 会让现有 RPC / view / index 失效 | 中 | CASCADE 选项让用户自主决策；非 CASCADE 时让 PG 自然报错 |
| 用户在 visualizer 看到的关系图反映不及时 | 低 | DDL 成功后前端事件触发 `dispatchEvent(new Event('schema-changed'))`，visualizer 已经在监听 |
| 类型白名单遗漏（如 `tsvector`） | 低 | v1 接受；用户提需求时 PR 扩白名单 |

### 开放问题（不阻塞 Phase 1）

- [ ] **comment / description 支持**：建表时是否允许 `COMMENT ON TABLE` / `COMMENT ON COLUMN`？v1 不做，留 v1.x。
- [ ] **table-designer 是否应该挂在 `[projectId]` 的 layout 下而不是 sidebar 直跳**：现状是直跳；future 可以做 wizard 风格"step 1 建空表 → step 2 加字段 → step 3 加索引"，但 v1 沿用现有大表单 UX。
- [ ] **是否需要 `/api/ddl/schemas`**：v1 不做，沿用 `schema_handlers::create_schema`（admin+，与 schema = 项目级配置语义对齐）。

---

## 7. 验收标准

- ✅ 走完 M2 wizard 拿到空项目 → 进 workspace → 至少 2 条路径能"找到建表入口"（sidebar 表设计器 / tables 页 + 新建表 CTA）
- ✅ project owner / admin / **member** 都能成功建表；viewer 看到按钮禁用 + 后端 403 兜底
- ✅ edit 模式能做：加列、删列（含 CASCADE）、SET/DROP NOT NULL、SET/DROP DEFAULT；其余操作（改名、改类型）按钮灰掉提示
- ✅ DDL 成功后 visualizer ER 图能在 5 秒内反映新表（手工刷新即可）
- ✅ `cargo build` 干净；`tsc --noEmit` 干净（保留既有 TableEditor lint）
- ✅ `tests/m3_ddl_test.sh` 全绿

---

*本 plan 衔接 mvp-overview.md Plan 3 占位；M3 落地后 MVP 出口只剩 M6（简化大盘，~0.5 周）。*

---

## 8. 实施记录

5 个 phase 各成一 commit，全部在 `feature/optimize` 分支：

| Phase | Commit (短) | 摘要 |
|---|---|---|
| 1 | `a9d8c75` | plan + tenant_member / database_member permission helpers |
| 2 | `bf1d644` | backend DDL endpoints + 6 unit tests + 10-scenario shell smoke |
| 3 | `80e59a7` | frontend ddlAPI + 表设计器 sidebar entry（复用既有 canWriteDatabase） |
| 4 | `19a3ec4` | table-designer URL params + real ALTER + role gate |
| 5 | （本 commit） | tables / visualizer discoverability CTAs + docs sync |

### 关键决策回顾

| 决策 | 选定 | 实际落地 | 备注 |
|---|---|---|---|
| ALTER 范围 | 极简安全集 | ✅ AddColumn / DropColumn(cascade) / SetNotNull / SetDefault | 改名 / 改类型确定留 v1.x；原始列名 / 类型在 UI 直接锁死，避免用户误操作 |
| Discoverability | sidebar + 空状态 CTA | ✅ sidebar 中插"表设计器" + tables/visualizer 空状态都给"建第一张表" CTA + tables 行级"编辑结构" 按钮 | 项目首页确认不动；多一个入口是好事 |
| ER 交互 | v1 静态 | ✅ visualizer 仍只读；只把空状态 CTA 接到 designer | 节点点击交互 v2 配 ER 编辑器一起做 |
| DDL 权限闸 | member+ | ✅ 后端 `require_database_member`；前端复用既有 `canWriteDatabase`（语义已经匹配，免新增 capability） | 不放宽 `/query`——新开 `/api/ddl/tables` 这条路 |

### 已知遗留 / Follow-up

1. **改列名 / 改列类型 / 重排序列**——v1.x 配迁移预览再做。后端 enum 易扩展；前端 UI 当前显式禁用了原始列的名 / 类型字段。
2. **COMMENT ON TABLE / COMMENT ON COLUMN**——v1.x。M4 RBAC 也可能加表 / 列描述用作权限提示，统筹考虑。
3. **`/query` 仍仅超管**——这个边界明确不破。普通项目 member 通过 `/api/ddl/tables` 走结构化 body 才能跑 DDL。
4. **M4 RBAC 完整版**可能进一步收紧 member 的 DDL 权限（如：本租户内只能改自己 schema、approval flow 等）；M3 当前是"member 在自己 database 内可任意建表 / 改表 / 删表"。
5. **`tests/m3_ddl_test.sh` 需要在有连通业务库的环境跑一遍**——本地 sandbox 没法跑，需要真实部署后用 `DATABASE_ID=N USER_EMAIL=foo bash tests/m3_ddl_test.sh` 验证。
6. **后端 service 需重启**才能加载新路由——`POST /api/ddl/tables` 这些是新挂的。
7. **多语句 DDL 的 partial failure**已通过 `tx.begin() / tx.commit()` 兜住——表创建 + 索引创建在同一事务，索引失败会回滚表创建。

### MVP 出口检查

> 开发者能从 0 自助完成 "**登录 → 建项目 → 建表 → 查 API → 看大盘**"

- ✅ 登录（已有）
- ✅ 建项目（M2 wizard 已完成）
- ✅ **建表**（M3 落地——sidebar / tables 空状态 / visualizer 空状态 三处入口都能找到 table-designer，member+ 可执行）
- ✅ 查 API（auto API 已有，REST endpoint URL 模式可识别）
- ⏳ 看大盘（M6 待实施——MVP 阶段唯一剩余模块）

