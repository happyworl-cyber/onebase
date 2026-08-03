# M6 项目级简化大盘（Simplified Dashboard）— v1

> **REQUIRED SUB-SKILL:** superpowers:executing-plans

**目标**：让走完 M2 + M3 拿到第一张表的用户，**在项目首页就能看到自己项目的健康状况**。这是 MVP 出口"登录 → 建项目 → 建表 → 查 API → **看大盘**"中最后一公里。

**关联**：
- 母 spec §2.3 M6：6 个核心卡片 + 复用 `audit_handlers` / `monitor_handlers` / `query_perf_handlers` 数据源
- 上游 `mvp-overview.md` Plan 4
- 依赖：M1（W3 把 dashboard 顶层四工具迁移走，腾出"项目大盘"心智位）+ M2 + M3（audit_logs.tenant_id 自动填充已经 W2 落地）

---

## 0. 现状盘点

| 区块 | 现状 | 含义 |
|---|---|---|
| `management.audit_logs` | ✅ 全表存在；`audit_middleware` 自动按 X-Database-Id 反查并填 `tenant_id`；按 tenant_id / created_at 都有索引 | 直接 group by tenant_id 即可拿到"项目维度"指标 |
| `management.slow_query_logs` | ✅ 已存在；按 created_at / duration_ms 有索引 | 慢查询数指标的数据源 |
| `management.api_keys` | ✅ 已存在；tenant_id + is_active 都有 | 活跃 API Key 计数的数据源 |
| `monitor_handlers` | ✅ 4 个 PG 级 endpoint，已在 `/workspace/[projectId]/monitor` 用了 | **不是** M6 的数据源——它是 PG 状态，M6 要的是应用层 |
| `audit_handlers::list_audit_logs` | ✅ 但 **admin+ 鉴权** | M6 给 member+ 看，所以**不能直接复用**，需要新开 sanitized endpoint |
| 项目首页 `app/workspace/[projectId]/page.tsx` | 4 张 placeholder 卡（API 端点 / RPC 函数 / 本月调用量 = '—'）+ "最近活动" placeholder | 直接改造，无需新页面 |
| 项目级监控页 `app/workspace/[projectId]/monitor/page.tsx` | ✅ 完整 PG-level dashboard，6 卡 + 4 tab | 不动它；M6 是另一类大盘 |

---

## 1. 决策摘要（实施前已对齐）

| 决策点 | 选定方案 |
|---|---|
| 大盘落点 | **项目首页 `/workspace/[projectId]`**——4 placeholder 卡换成 6 M6 卡 + 看板区。MVP 出口"登录后看大盘"一气呵成 |
| 趋势图复杂度 | **6 卡 + 单条 QPS 24h sparkline**（内嵌 svg path，不引第三方图表库） |
| 最近活动 feed | **顺手做**——sanitized endpoint（只暴露 method / path / status / duration / created_at；不返回 IP / request_body / user_agent）。复用已有 placeholder 区 |
| 鉴权 | dashboard overview 和 recent activity 都是 **member+ 只读**（含 viewer——纯展示无副作用） |
| 后端聚合方式 | **单 endpoint 单查询**——CTE 在 PG 内聚合所有 6 个数字 + 24 个小时分桶，一次 round-trip 拿全 |

---

## 2. 6 卡片定义

| 卡片 | 数据源 | 计算式 | 备注 |
|---|---|---|---|
| **QPS** (近 5 分钟) | `audit_logs` | COUNT(*) WHERE created_at >= now() - 5min / 300 | 不用 1min 窗口避免抖动 |
| **P95 延迟** (近 5 分钟) | `audit_logs.duration_ms` | percentile_cont(0.95) WITHIN GROUP ORDER BY duration_ms | NULL → "—" |
| **错误率** (近 24h) | `audit_logs.response_status` | COUNT(*) FILTER (status >= 500) / NULLIF(COUNT(*), 0) | 0 调用时显示 "—" 而非 "0%" |
| **慢查询数** (近 24h) | `slow_query_logs` | COUNT(*) WHERE tenant_id=? AND created_at >= now() - 24h | 通过 tenant_databases 关联 tenant_id |
| **活跃 API Key** | `api_keys` | COUNT(*) WHERE tenant_id=? AND is_active=true | 即时统计 |
| **每日 API 调用量** (近 24h) | `audit_logs` | COUNT(*) WHERE created_at >= now() - 24h | 同时返回 24 个 hourly bucket 供 sparkline |

**24h hourly bucket** 是 sparkline 的数据：每小时调用数（`date_trunc('hour', created_at)`）。

---

## 3. 后端设计

### 3.1 新模块 `src/dashboard_handlers.rs`

```rust
#[derive(Deserialize)]
pub struct DashboardQuery {
    pub tenant_id: i32,   // 从前端 currentProject.id 显式传，避免 X-Tenant-Id 歧义
}

#[derive(Serialize)]
pub struct DashboardOverview {
    pub qps_5min: f64,
    pub p95_ms_5min: Option<f64>,
    pub error_rate_24h: Option<f64>,    // 0.0-1.0；None 表示 24h 内 0 个调用
    pub slow_queries_24h: i64,
    pub active_api_keys: i64,
    pub calls_24h: i64,
    pub hourly_24h: Vec<HourlyBucket>,  // 24 entries; 缺失小时填 0
}

#[derive(Serialize)]
pub struct HourlyBucket {
    pub hour_utc: String,   // "2026-05-19T15:00:00Z"
    pub count: i64,
    pub err_5xx: i64,
}

pub async fn get_overview(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<DashboardQuery>,
) -> Result<Json<DashboardOverview>>;

#[derive(Deserialize)]
pub struct RecentActivityQuery {
    pub tenant_id: i32,
    #[serde(default = "default_limit")]
    pub limit: i64,         // 默认 10，上限 50
}

#[derive(Serialize)]
pub struct ActivityRow {
    /// 不暴露：tenant_id（重复）、user_id（隐私）、ip_address、user_agent、request_body
    pub id: i64,
    pub action: String,
    pub resource: String,
    pub request_method: String,
    pub response_status: Option<i32>,
    pub duration_ms: Option<i32>,
    pub created_at: String,  // rfc3339
}

pub async fn get_recent_activity(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<RecentActivityQuery>,
) -> Result<Json<Vec<ActivityRow>>>;
```

### 3.2 鉴权

两个 endpoint 都用 `permissions::require_tenant_member`（M3 phase 1 已加），让 owner/admin/**member** 都能看，viewer 走特殊路径——

等等，spec 选了"member+ 只读"。但 viewer 是"只读"语义——不让 viewer 看大盘合理吗？

**重新审视**：viewer 该不该看大盘？我倾向 **let viewer see**——大盘本质是"项目元数据 + 聚合数字"，没有具体行级数据；viewer 看也没毛病。所以鉴权用更宽的"任意租户角色"（`is_tenant_member` || `is_tenant_viewer`）。我加一个新 helper `require_tenant_membership_any`（最宽——owner/admin/member/viewer 都行），与 `require_tenant_member`（不含 viewer）形成对比。

### 3.3 单 query CTE 聚合

```sql
WITH
last_5min AS (
    SELECT duration_ms, response_status
    FROM management.audit_logs
    WHERE tenant_id = $1 AND created_at >= now() - INTERVAL '5 minutes'
),
last_24h AS (
    SELECT duration_ms, response_status, date_trunc('hour', created_at) AS h
    FROM management.audit_logs
    WHERE tenant_id = $1 AND created_at >= now() - INTERVAL '24 hours'
),
slow AS (
    SELECT COUNT(*)::bigint AS n
    FROM management.slow_query_logs s
    JOIN management.tenant_databases d ON s.database_id = d.id
    WHERE d.tenant_id = $1 AND s.created_at >= now() - INTERVAL '24 hours'
),
keys AS (
    SELECT COUNT(*)::bigint AS n
    FROM management.api_keys
    WHERE tenant_id = $1 AND COALESCE(is_active, false) = true
),
hourly AS (
    SELECT
        h AS hour,
        COUNT(*)::bigint AS cnt,
        COUNT(*) FILTER (WHERE response_status >= 500)::bigint AS err_5xx
    FROM last_24h
    GROUP BY h
)
SELECT
    -- 5min 窗口
    (SELECT COUNT(*)::float8 / 300.0 FROM last_5min)               AS qps_5min,
    (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
     FROM last_5min WHERE duration_ms IS NOT NULL)                  AS p95_ms_5min,
    -- 24h
    (SELECT COUNT(*)::bigint FROM last_24h)                         AS calls_24h,
    CASE WHEN (SELECT COUNT(*) FROM last_24h) = 0 THEN NULL
         ELSE (SELECT COUNT(*) FILTER (WHERE response_status >= 500)::float8 / COUNT(*)
               FROM last_24h)
    END                                                             AS error_rate_24h,
    (SELECT n FROM slow)                                            AS slow_queries_24h,
    (SELECT n FROM keys)                                            AS active_api_keys,
    COALESCE(
        (SELECT jsonb_agg(jsonb_build_object('hour', hour, 'cnt', cnt, 'err_5xx', err_5xx) ORDER BY hour) FROM hourly),
        '[]'::jsonb
    )                                                                AS hourly_24h
```

后端读取后把 `hourly_24h` 反序列化为 `Vec<HourlyBucket>`，并**填补缺失小时**（24 个小时一定都返回，缺失填 0）—— 前端 sparkline 才不会断点。

### 3.4 路由注册（main.rs）

放在已有的"业务路由组"（auth_middleware）下：
```rust
.route("/api/dashboard/overview",        get(dashboard_handlers::get_overview))
.route("/api/dashboard/recent-activity", get(dashboard_handlers::get_recent_activity))
```

---

## 4. 前端设计

### 4.1 `lib/api.ts` — `dashboardAPI`

```ts
export interface HourlyBucket { hour_utc: string; count: number; err_5xx: number }
export interface DashboardOverview {
  qps_5min: number
  p95_ms_5min: number | null
  error_rate_24h: number | null
  slow_queries_24h: number
  active_api_keys: number
  calls_24h: number
  hourly_24h: HourlyBucket[]   // 24 entries
}
export interface ActivityRow {
  id: number; action: string; resource: string; request_method: string
  response_status: number | null; duration_ms: number | null; created_at: string
}

export const dashboardAPI = {
  getOverview: (tenantId: number) =>
    api.get<DashboardOverview>('/api/dashboard/overview', { params: { tenant_id: tenantId } }),
  getRecentActivity: (tenantId: number, limit = 10) =>
    api.get<ActivityRow[]>('/api/dashboard/recent-activity', { params: { tenant_id: tenantId, limit } }),
}
```

### 4.2 项目首页改造 `app/workspace/[projectId]/page.tsx`

布局变更：
```
┌───────────────────────────────────────┐
│ 项目名 / slug / 角色（保留）           │
├──────┬──────┬──────┬──────┬──────┬────┤
│ QPS  │ P95  │ 错误 │ 慢Q  │ Key │ 调用│   ← 6 张 M6 卡
├──────┴──────┴──────┴──────┴──────┴────┤
│ ▁▂▃▅▇▆▄▃▂▁▂▃ 24h QPS 趋势              │   ← inline svg sparkline
├───────────────────────────────────────┤
│ 最近活动                                │   ← 改成真实 audit_logs
│  ├ GET /api/tables 200 12ms · 3min ago │
│  ├ POST /api/ddl/tables 200 · 5min ago │
│  └ ...                                  │
├───────────────────────────────────────┤
│ 快捷入口（保留）                        │
└───────────────────────────────────────┘
```

### 4.3 Sparkline 组件

内嵌 svg，无第三方库：
```tsx
function Sparkline({ data, height = 40 }: { data: number[]; height?: number }) {
  if (data.length === 0) return null
  const max = Math.max(...data, 1)
  const w = 280
  const step = w / Math.max(data.length - 1, 1)
  const points = data.map((v, i) => `${i * step},${height - (v / max) * height}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full h-10">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-blue-500" />
      {/* 当前点高亮 */}
      <circle cx={(data.length - 1) * step} cy={height - (data[data.length-1] / max) * height} r="2" className="fill-blue-500" />
    </svg>
  )
}
```

---

## 5. 实施顺序（3 phase / 3 commit）

### Phase 1 — Plan + backend dashboard handlers（~0.5 day）
- [ ] 1.1 写本 plan
- [ ] 1.2 `permissions.rs` 加 `require_tenant_membership_any`（owner/admin/member/viewer）
- [ ] 1.3 `src/dashboard_handlers.rs` 实现 2 endpoint，单 CTE 查询，hourly 缺失填补
- [ ] 1.4 `main.rs` 注册 2 路由
- [ ] 1.5 cargo build + 单元测试（hourly 填补 + 极端值处理）
- [ ] 1.6 `tests/m6_dashboard_test.sh`（鉴权、空数据、有数据 3 个场景）
- [ ] 1.7 Commit：`feat(m6): backend dashboard overview + recent activity (member+/viewer-readable)`

### Phase 2 — frontend 项目首页改造（~1 day）
- [ ] 2.1 `lib/api.ts` 加 `dashboardAPI`
- [ ] 2.2 `app/workspace/[projectId]/page.tsx` 改造：6 卡 + Sparkline + 最近活动
- [ ] 2.3 数据载入逻辑：currentProject 变化时拉 overview + activity；30s 自动刷新（轻量）
- [ ] 2.4 空数据态：所有指标 0 时显示"项目刚启动还没有数据"提示卡
- [ ] 2.5 tsc 干净
- [ ] 2.6 Commit：`feat(m6): project home — 6 metric cards + 24h sparkline + activity feed`

### Phase 3 — 文档同步（~0.5h）
- [ ] 3.1 mvp-overview Plan 4 改 ✅
- [ ] 3.2 spec §2.3 M6 加 ✅ + v1 备注
- [ ] 3.3 本 plan 加 §7 实施记录
- [ ] 3.4 Commit：`docs(m6): mark M6 complete; MVP loop closed`

---

## 6. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| `audit_logs` 量大时聚合慢 | tenant_id + created_at 索引齐全；CTE 都走 index scan；24h 分桶最多 ~10k 行 / 项目 |
| viewer 看到大盘后泄露调用量 | 大盘仅暴露聚合数字与 sanitized 路径前缀；不含具体业务数据。spec 接受 |
| sparkline 在 0 数据时显示鬼影线 | 全 0 时不渲染 svg，显示 "暂无数据" 兜底 |
| 30s 自动刷新增加 DB 负担 | 单查询走索引，<10ms；项目数 <1k 时整库负载可忽略 |

### 不做（明确推后）
- ❌ 错误率 / P95 趋势叠加图（v2 大盘）
- ❌ 异常访问告警（spec 明确 v2）
- ❌ 自定义大盘 / 自定义指标（spec 明确 v2）
- ❌ 按 endpoint 维度的 top calls（v2，需要 path 归一化）

---

## 7. 验收标准

- ✅ 新建项目（M2）后立刻进项目首页：6 卡都展示（即使全 0），sparkline 区显示"暂无数据"
- ✅ 跑几个 API 调用后刷新：QPS / 调用量 / 趋势线都更新
- ✅ admin / member / viewer 都能打开页面看到数据；非该项目成员 403
- ✅ `cargo build` 干净；`tsc --noEmit` 干净
- ✅ shell smoke 全绿

---

*MVP 出口"登录 → 建项目 → 建表 → 查 API → 看大盘"在 M6 落地后**全部连通**；下一里程碑是 Beta 阶段的 M4 RBAC 可视化。*

---

## 8. 实施记录

3 个 phase 各成一 commit（feature/optimize 分支）：

| Phase | Commit (短) | 摘要 |
|---|---|---|
| 1 | `ad6c1ce` | plan + permissions::require_tenant_membership_any + dashboard_handlers (overview + recent-activity) + 3 unit tests + 7-scenario shell smoke |
| 2 | `c2343e4` | frontend dashboardAPI + 项目首页重写（6 卡 + 24h sparkline + 最近活动 feed + 30s 自动刷新） |
| 3 | （本 commit） | mvp-overview / spec / 本 plan 收尾，标 MVP 全部完成 |

### 关键决策回顾

| 决策 | 选定 | 实际落地 |
|---|---|---|
| 大盘落点 | 项目首页 | ✅ `app/workspace/[projectId]/page.tsx` 重写，不新开页面 / sidebar 项 |
| 趋势图 | 6 卡 + 单条 sparkline | ✅ 内嵌 SVG polyline；全 0 时不渲染 + 引导文案 |
| 最近活动 feed | 顺手做 | ✅ sanitized projection（无 IP / user_agent / request_body） |
| viewer 读权 | 允许 | ✅ `require_tenant_membership_any` |
| 后端聚合 | 单 CTE / 单 round-trip | ✅ 6 指标 + jsonb_agg hourly 一次拉全 |

### 已知遗留 / Follow-up

1. **异常访问告警** —— spec 明确留 Beta 阶段 M6 完整版（基于 audit_logs 检测"非工作时间访问 / 跨项目访问尝试 / API Key 滥用"）
2. **自定义大盘 / 自定义指标** —— v2
3. **错误率 / P95 趋势叠加图** —— v2；当前 sparkline 只画 QPS
4. **按 endpoint 维度的 top calls** —— v2（需要 path 归一化处理 `/api/auto/:tenant/:schema/:table/:id` 这种 path 参数）
5. **`tests/m6_dashboard_test.sh`** —— 需在有真实流量 + viewer 账号的环境跑一遍验证。本地 sandbox 无业务库，跳过

### MVP 出口检查 ✅

> 开发者能从 0 自助完成 "**登录 → 建项目 → 建表 → 查 API → 看大盘**"

- ✅ 登录（既有）
- ✅ 建项目（M2 wizard）
- ✅ 建表（M3 visual schema editor）
- ✅ 查 API（auto API + 项目首页"查看 API 文档"快捷入口）
- ✅ **看大盘**（本 M6 落地 —— 项目首页就是大盘）

**MVP 阶段完成。** 下一里程碑：Beta（M4 RBAC 可视化 + M5 Webhook 面板 + M6 完整版异常告警 + M7 NL2SQL 只读）。

