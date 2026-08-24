# Platform Monitor Signal Drill-down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 平台监控总览信号可下钻：卡死执行 / Key 将过期在页内展开明细；异步失败跳转到排查 Tab。

**Architecture:** 扩展 `GET /api/admin/platform-monitor/overview`，在 `signals` 旁返回 `signal_samples`（Top 20 + total）；前端 overview 点击展开或切 Tab，不新增 detail 路由、不跳工作区。

**Tech Stack:** Rust/Axum/SQLx、Next.js（`app/platform/monitor/page.tsx`）

**Spec:** `docs/superpowers/specs/2026-08-14-platform-monitor-signal-drilldown-design.md`

## Global Constraints

- 鉴权：仍仅超管（现有 `require_superadmin`）
- 页内展开：卡死执行、API Key 将过期；异步失败 → `diagnose` Tab
- 样例最多 20 条；`total` 可为更大
- 不返回 `key_hash` / 密钥明文；只 `name` + `key_prefix`
- 样例查询失败不得拖垮 overview（warnings + 空 items）
- 不跳 `/workspace/.../api-keys`；不做续期/杀任务写操作
- 除非用户明确要求，否则不 git commit

## File map

| File | Responsibility |
|------|----------------|
| `src/platform_monitor_handlers.rs` | `collect_signal_samples` + 序列化；挂入 `overview` |
| `frontend-nextjs/app/platform/monitor/page.tsx` | 类型、展开面板、`?tab=`、可点 KPI/信号 |

---

### Task 1: Backend — signal sample collectors + overview field

**Files:**
- Modify: `src/platform_monitor_handlers.rs`（`collect_signals` / `overview` 附近）

**Interfaces:**
- Consumes: 现有 `PgPool`、`Signals` 计数口径
- Produces: `signal_samples: { stuck_running: { total, items }, expiring_api_keys: { total, items } }` 挂在 overview JSON

- [ ] **Step 1: 写失败测试（纯函数：空 bucket 形状）**

在 `platform_monitor_handlers.rs` 的 `mod tests` 增加：

```rust
#[test]
fn empty_signal_sample_bucket_shape() {
    let v = signal_sample_bucket(0, vec![]);
    assert_eq!(v["total"], 0);
    assert!(v["items"].as_array().unwrap().is_empty());
}

#[test]
fn signal_sample_bucket_preserves_total_gt_items() {
    let items = vec![json!({"id": 1})];
    let v = signal_sample_bucket(5, items);
    assert_eq!(v["total"], 5);
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p onebase empty_signal_sample_bucket_shape signal_sample_bucket_preserves_total_gt_items -- --nocapture`

Expected: FAIL（`signal_sample_bucket` 未定义）

- [ ] **Step 3: 实现 `signal_sample_bucket` + `collect_signal_samples`**

在 `collect_signals` 之后加入：

```rust
fn signal_sample_bucket(total: i64, items: Vec<Value>) -> Value {
    json!({ "total": total, "items": items })
}

#[derive(Debug, Clone, Default)]
struct SignalSamples {
    stuck_running: Value,
    expiring_api_keys: Value,
}

impl SignalSamples {
    fn empty() -> Self {
        Self {
            stuck_running: signal_sample_bucket(0, vec![]),
            expiring_api_keys: signal_sample_bucket(0, vec![]),
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "stuck_running": self.stuck_running,
            "expiring_api_keys": self.expiring_api_keys,
        })
    }
}

async fn collect_signal_samples(pool: &PgPool) -> std::result::Result<SignalSamples, String> {
    let stuck_total: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM management.execution_index
        WHERE status = 'running' AND started_at < now() - INTERVAL '10 minutes'
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    let stuck_rows = sqlx::query(
        r#"
        SELECT e.trace_id, e.source, e.name, e.tenant_id,
               e.started_at::TEXT AS started_at,
               EXTRACT(EPOCH FROM (now() - e.started_at))::bigint AS running_for_seconds,
               t.name AS project_name,
               t.organization_id,
               o.name AS organization_name
        FROM management.execution_index e
        LEFT JOIN management.tenants t ON t.id = e.tenant_id
        LEFT JOIN management.organizations o ON o.id = t.organization_id
        WHERE e.status = 'running' AND e.started_at < now() - INTERVAL '10 minutes'
        ORDER BY e.started_at ASC
        LIMIT 20
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let stuck_items: Vec<Value> = stuck_rows
        .iter()
        .map(|r| {
            json!({
                "trace_id": r.get::<String, _>("trace_id"),
                "source": r.get::<String, _>("source"),
                "name": r.try_get::<Option<String>, _>("name").ok().flatten(),
                "tenant_id": r.try_get::<Option<i32>, _>("tenant_id").ok().flatten(),
                "project_name": r.try_get::<Option<String>, _>("project_name").ok().flatten(),
                "organization_id": r.try_get::<Option<i32>, _>("organization_id").ok().flatten(),
                "organization_name": r.try_get::<Option<String>, _>("organization_name").ok().flatten(),
                "started_at": r.get::<String, _>("started_at"),
                "running_for_seconds": r.try_get::<Option<i64>, _>("running_for_seconds").ok().flatten(),
            })
        })
        .collect();

    let key_total: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)::bigint FROM management.api_keys
        WHERE COALESCE(is_active, false) = true
          AND expires_at IS NOT NULL
          AND expires_at > now()
          AND expires_at <= now() + INTERVAL '7 days'
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    let key_rows = sqlx::query(
        r#"
        SELECT k.id, k.name, k.key_prefix, k.tenant_id,
               k.expires_at::TEXT AS expires_at,
               CEIL(EXTRACT(EPOCH FROM (k.expires_at - now())) / 86400.0)::int AS days_left,
               t.name AS project_name,
               t.organization_id,
               o.name AS organization_name
        FROM management.api_keys k
        LEFT JOIN management.tenants t ON t.id = k.tenant_id
        LEFT JOIN management.organizations o ON o.id = t.organization_id
        WHERE COALESCE(k.is_active, false) = true
          AND k.expires_at IS NOT NULL
          AND k.expires_at > now()
          AND k.expires_at <= now() + INTERVAL '7 days'
        ORDER BY k.expires_at ASC
        LIMIT 20
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let key_items: Vec<Value> = key_rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i32, _>("id"),
                "name": r.get::<String, _>("name"),
                "key_prefix": r.get::<String, _>("key_prefix"),
                "tenant_id": r.get::<i32, _>("tenant_id"),
                "project_name": r.try_get::<Option<String>, _>("project_name").ok().flatten(),
                "organization_id": r.try_get::<Option<i32>, _>("organization_id").ok().flatten(),
                "organization_name": r.try_get::<Option<String>, _>("organization_name").ok().flatten(),
                "expires_at": r.get::<String, _>("expires_at"),
                "days_left": r.try_get::<Option<i32>, _>("days_left").ok().flatten(),
            })
        })
        .collect();

    Ok(SignalSamples {
        stuck_running: signal_sample_bucket(stuck_total, stuck_items),
        expiring_api_keys: signal_sample_bucket(key_total, key_items),
    })
}
```

注意：Key 区间用 `expires_at > now() AND expires_at <= now() + 7 days`，与现有 `BETWEEN now() AND now() + 7 days` 语义对齐（含边界）；若现有 `collect_signals` 用 `BETWEEN`，保持两边一致——必要时把 `collect_signals` 的 Key 条件改成同一 SQL 片段，避免 total 与计数漂移。

- [ ] **Step 4: 挂入 `overview`**

在 `let signals = match collect_signals...` 之后：

```rust
let signal_samples = match collect_signal_samples(&pool).await {
    Ok(s) => s,
    Err(e) => {
        warnings.push(format!("signal_samples: {e}"));
        SignalSamples::empty()
    }
};
```

在返回 JSON 的 `"signals": { ... },` 后增加：

```rust
"signal_samples": signal_samples.to_json(),
```

- [ ] **Step 5: 跑单元测试通过**

Run: `cargo test -p onebase empty_signal_sample_bucket_shape signal_sample_bucket_preserves_total_gt_items eval_rule_operators -- --nocapture`

Expected: PASS

- [ ] **Step 6: 可选手工冒烟（有超管 cookie / token）**

Run: `curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/admin/platform-monitor/overview | jq '.signal_samples'`

Expected: 含 `stuck_running` / `expiring_api_keys`，每项有 `total` + `items`

- [ ] **Step 7: Commit（仅当用户要求时）**

```bash
git add src/platform_monitor_handlers.rs
git commit -m "$(cat <<'EOF'
feat(monitor): attach signal_samples to platform overview

EOF
)"
```

---

### Task 2: Frontend — types, expand panel, diagnose deep link

**Files:**
- Modify: `frontend-nextjs/app/platform/monitor/page.tsx`

**Interfaces:**
- Consumes: `overview.signal_samples`（Task 1）
- Produces: 可点信号/KPI → 展开表或 `setTab('diagnose')`；`?tab=diagnose` 初值

- [ ] **Step 1: 扩展类型与空兜底**

在 `Overview` 接口增加：

```ts
signal_samples?: {
  stuck_running: {
    total: number
    items: {
      trace_id: string
      source: string
      name: string | null
      tenant_id: number | null
      project_name: string | null
      organization_id: number | null
      organization_name: string | null
      started_at: string
      running_for_seconds: number | null
    }[]
  }
  expiring_api_keys: {
    total: number
    items: {
      id: number
      name: string
      key_prefix: string
      tenant_id: number
      project_name: string | null
      organization_id: number | null
      organization_name: string | null
      expires_at: string
      days_left: number | null
    }[]
  }
}
```

```ts
const EMPTY_SIGNAL_SAMPLES = {
  stuck_running: { total: 0, items: [] as Overview['signal_samples'] extends infer S
    ? S extends { stuck_running: { items: infer I } } ? I : never
    : never },
  expiring_api_keys: { total: 0, items: [] as never[] },
}
```

为避免复杂条件类型，直接写具体空对象即可：

```ts
const EMPTY_SIGNAL_SAMPLES: NonNullable<Overview['signal_samples']> = {
  stuck_running: { total: 0, items: [] },
  expiring_api_keys: { total: 0, items: [] },
}
```

- [ ] **Step 2: Tab 初值读 query + 同步**

```ts
import { useSearchParams, useRouter, usePathname } from 'next/navigation'

function initialTab(sp: URLSearchParams | null): Tab {
  const t = sp?.get('tab')
  if (t === 'traffic' || t === 'async' || t === 'diagnose' || t === 'alerts' || t === 'overview') {
    return t
  }
  return 'overview'
}

// 在组件内：
const searchParams = useSearchParams()
const router = useRouter()
const pathname = usePathname()
const [tab, setTab] = useState<Tab>(() => initialTab(searchParams))

function selectTab(next: Tab) {
  setTab(next)
  const params = new URLSearchParams(searchParams.toString())
  if (next === 'overview') params.delete('tab')
  else params.set('tab', next)
  const q = params.toString()
  router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false })
}
```

若该页尚未包 `<Suspense>`，按仓库惯例在同文件用 wrapper 或确认 `app/platform/monitor` layout 已处理 `useSearchParams`（与 workspace 页相同模式）；缺则加：

```tsx
export default function PlatformMonitorPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-gray-400">加载中…</div>}>
      <PlatformMonitorPageInner />
    </Suspense>
  )
}
```

把现有默认导出内容改名为 `PlatformMonitorPageInner`。

把所有 `setTab(...)`（Tab 按钮、异步失败跳转）改为 `selectTab(...)`。

- [ ] **Step 3: 展开状态 + 可点 KPI**

```ts
type ExpandKey = 'stuck_running' | 'expiring_api_keys' | null
const [expanded, setExpanded] = useState<ExpandKey>(null)

function toggleExpand(key: ExpandKey) {
  setExpanded((cur) => (cur === key ? null : key))
}
```

扩展 `Kpi`：

```tsx
function Kpi({
  label,
  value,
  warn,
  onClick,
  active,
}: {
  label: string
  value: string
  warn?: boolean
  onClick?: () => void
  active?: boolean
}) {
  const clickable = Boolean(onClick)
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      className={`rounded-lg border p-3 ${
        active
          ? 'border-blue-400 bg-blue-50'
          : warn
            ? 'border-orange-300 bg-orange-50'
            : 'border-gray-200 bg-white'
      } ${clickable ? 'cursor-pointer hover:border-blue-300' : ''}`}
    >
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${warn ? 'text-orange-800' : 'text-gray-900'}`}>
        {value}
      </p>
    </div>
  )
}
```

- [ ] **Step 4: 信号列表与隐患 KPI 接线**

在 overview 渲染块内：

```ts
const samples = overview.signal_samples ?? EMPTY_SIGNAL_SAMPLES

function onAnomalyClick(code: string) {
  if (code === 'stuck_running') toggleExpand('stuck_running')
  else if (code === 'api_key_expiring') toggleExpand('expiring_api_keys')
  else if (code === 'exec_failed') selectTab('diagnose')
}

// anomalies 行：count>0 的上述 code 加 button/cursor
{anomalies.map((a) => (
  <li key={a.code} className="flex items-center gap-2">
    {/* 圆点保持 */}
    <button
      type="button"
      className={`text-left ${
        a.code === 'stuck_running' || a.code === 'api_key_expiring' || a.code === 'exec_failed'
          ? 'underline-offset-2 hover:underline cursor-pointer'
          : ''
      } ...level colors...`}
      onClick={() => onAnomalyClick(a.code)}
      disabled={
        !(a.code === 'stuck_running' || a.code === 'api_key_expiring' || a.code === 'exec_failed')
      }
    >
      {a.message}
    </button>
  </li>
))}
```

隐患 KPI：

```tsx
<Kpi
  label="卡死执行"
  value={String(signals.stuck_running)}
  warn={signals.stuck_running > 0}
  active={expanded === 'stuck_running'}
  onClick={signals.stuck_running > 0 ? () => toggleExpand('stuck_running') : undefined}
/>
<Kpi
  label="Key 将过期"
  value={String(signals.expiring_api_keys_7d)}
  warn={signals.expiring_api_keys_7d > 0}
  active={expanded === 'expiring_api_keys'}
  onClick={
    signals.expiring_api_keys_7d > 0 ? () => toggleExpand('expiring_api_keys') : undefined
  }
/>
```

- [ ] **Step 5: 展开明细面板（放在隐患 KPI grid 下方）**

```tsx
{expanded === 'stuck_running' && (
  <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
    <div className="px-4 py-3 border-b border-gray-100 flex justify-between items-center">
      <h3 className="text-sm font-semibold text-gray-700">卡死执行明细</h3>
      <button type="button" className="text-xs text-gray-500" onClick={() => setExpanded(null)}>
        收起
      </button>
    </div>
    <table className="w-full text-sm">
      <thead className="bg-gray-50">
        <tr>
          <th className="px-4 py-2 text-left text-xs text-gray-500">组织</th>
          <th className="px-4 py-2 text-left text-xs text-gray-500">项目</th>
          <th className="px-4 py-2 text-left text-xs text-gray-500">来源</th>
          <th className="px-4 py-2 text-left text-xs text-gray-500">名称</th>
          <th className="px-4 py-2 text-left text-xs text-gray-500">开始</th>
          <th className="px-4 py-2 text-right text-xs text-gray-500">已跑</th>
          <th className="px-4 py-2 text-left text-xs text-gray-500">trace</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {samples.stuck_running.items.length === 0 ? (
          <tr>
            <td colSpan={7} className="px-4 py-6 text-center text-xs text-gray-400">
              无样例（可能刚恢复或查询失败，见 warnings）
            </td>
          </tr>
        ) : (
          samples.stuck_running.items.map((row) => (
            <tr key={row.trace_id + row.started_at} className="hover:bg-gray-50">
              <td className="px-4 py-2 text-xs">{row.organization_name || '—'}</td>
              <td className="px-4 py-2 text-xs">{row.project_name || row.tenant_id || '—'}</td>
              <td className="px-4 py-2 text-xs">{row.source}</td>
              <td className="px-4 py-2 text-xs max-w-[12rem] truncate" title={row.name || ''}>
                {row.name || '—'}
              </td>
              <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                {new Date(row.started_at).toLocaleString('zh-CN')}
              </td>
              <td className="px-4 py-2 text-xs text-right tabular-nums">
                {row.running_for_seconds != null
                  ? `${Math.floor(row.running_for_seconds / 60)}m`
                  : '—'}
              </td>
              <td className="px-4 py-2 text-xs font-mono">
                <button
                  type="button"
                  className="text-blue-600 hover:underline"
                  title="复制 trace_id"
                  onClick={() => navigator.clipboard.writeText(row.trace_id)}
                >
                  {row.trace_id.slice(0, 8)}…
                </button>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
    {samples.stuck_running.total > samples.stuck_running.items.length && (
      <p className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100">
        共 {samples.stuck_running.total} 条，展示前 {samples.stuck_running.items.length}
      </p>
    )}
  </div>
)}

{expanded === 'expiring_api_keys' && (
  <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
    <div className="px-4 py-3 border-b border-gray-100 flex justify-between items-center">
      <h3 className="text-sm font-semibold text-gray-700">即将过期 API Key</h3>
      <button type="button" className="text-xs text-gray-500" onClick={() => setExpanded(null)}>
        收起
      </button>
    </div>
    <table className="w-full text-sm">
      <thead className="bg-gray-50">
        <tr>
          <th className="px-4 py-2 text-left text-xs text-gray-500">组织</th>
          <th className="px-4 py-2 text-left text-xs text-gray-500">项目</th>
          <th className="px-4 py-2 text-left text-xs text-gray-500">名称</th>
          <th className="px-4 py-2 text-left text-xs text-gray-500">前缀</th>
          <th className="px-4 py-2 text-left text-xs text-gray-500">过期</th>
          <th className="px-4 py-2 text-right text-xs text-gray-500">剩余天</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {samples.expiring_api_keys.items.map((row) => (
          <tr key={row.id} className="hover:bg-gray-50">
            <td className="px-4 py-2 text-xs">{row.organization_name || '—'}</td>
            <td className="px-4 py-2 text-xs">{row.project_name || row.tenant_id}</td>
            <td className="px-4 py-2 text-xs">{row.name}</td>
            <td className="px-4 py-2 text-xs font-mono">{row.key_prefix}</td>
            <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
              {new Date(row.expires_at).toLocaleString('zh-CN')}
            </td>
            <td className="px-4 py-2 text-xs text-right tabular-nums">
              {row.days_left ?? '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {samples.expiring_api_keys.total > samples.expiring_api_keys.items.length && (
      <p className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100">
        共 {samples.expiring_api_keys.total} 条，展示前 {samples.expiring_api_keys.items.length}
      </p>
    )}
  </div>
)}
```

- [ ] **Step 6: 本地类型检查**

Run: `cd frontend-nextjs && npx tsc --noEmit -p . 2>&1 | head -40`

Expected: 与本改动相关无新增 error（若全仓有无关 error，至少确认 `monitor/page.tsx` 无报错）

- [ ] **Step 7: 手工验收**

1. 打开 `/platform/monitor`，点「卡死执行」/「Key 将过期」→ 展开表含项目名  
2. 点异步失败信号 → 进入排查，可见失败列表  
3. 打开 `/platform/monitor?tab=diagnose` → 直接落在排查  
4. Network：展开不触发新 overview 请求  

- [ ] **Step 8: Commit（仅当用户要求时）**

```bash
git add frontend-nextjs/app/platform/monitor/page.tsx
git commit -m "$(cat <<'EOF'
feat(monitor): drill down platform signals on overview

EOF
)"
```

---

### Task 3: Spec status + smoke checklist

**Files:**
- Modify: `docs/superpowers/specs/2026-08-14-platform-monitor-signal-drilldown-design.md`（状态改为已实现）

- [ ] **Step 1: 更新 spec 状态**

将文首 `**状态：** 待实现` 改为 `**状态：** 已实现`。

- [ ] **Step 2: 对照验收清单自检**

- [ ] 卡死 / Key 点击可见项目（及组织）字段  
- [ ] 异步失败 → 排查 Tab  
- [ ] overview 一次加载；非超管 403  
- [ ] 最多 20 条 + total 提示  
- [ ] 无 key_hash / 明文  

- [ ] **Step 3: Commit（仅当用户要求时）**

```bash
git add docs/superpowers/specs/2026-08-14-platform-monitor-signal-drilldown-design.md
git commit -m "$(cat <<'EOF'
docs: mark platform monitor signal drilldown implemented

EOF
)"
```

---

## Spec coverage (self-review)

| Spec 要求 | Task |
|-----------|------|
| `signal_samples` on overview | Task 1 |
| 卡死 / Key 页内展开 | Task 2 |
| 异步失败 → diagnose + `?tab=` | Task 2 |
| LIMIT 20 + total | Task 1–2 |
| 无密钥明文 | Task 1 |
| 样例失败不拖垮 overview | Task 1 |
| 不跳工作区 / 无写操作 | 全局约束，未实现写入口 |
| 验收清单 | Task 3 |

无占位符；字段名与 spec JSON 一致（`stuck_running` / `expiring_api_keys`）。
