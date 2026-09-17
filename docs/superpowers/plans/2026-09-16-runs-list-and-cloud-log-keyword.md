# 执行记录瘦列表 + 云日志关键词 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 执行记录弹层先出摘要行、展开再拉节点明细；云日志普通关键词按 content/message 检索，回车可查询。

**Architecture:** `GET /workflows/:id/runs` 去掉 `node_results`，SQL 只聚合计数。弹层与回放共用瘦列表，明细仍走已有 `GET /runs/:run_id`。`compose_sls_query` 把普通词编成 SLS 短语，含操作符的输入原样发送。

**Tech Stack:** Rust (axum, sqlx, Postgres JSONB), Next.js 14, 前端单测 `npx tsx`。

**Spec:** `docs/superpowers/specs/2026-09-16-runs-list-and-cloud-log-keyword-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep Commit steps but skip them until asked.
- Do not prefetch run details when the modal opens.
- Do not change runs `limit` (default 20, max 100) or cloud-log window/line caps.
- Do not add client-side filtering of already-fetched cloud log rows.
- Do not modify `ExecutionLogsView` or split `workflow_runs`.
- Repo frontend tests are standalone `node:assert` files; run with `npx tsx <file>` from repo root unless a step says otherwise.
- Rust handler tests: `cargo test --bin onebase <filter>`. `cloud_log` lives in the lib crate: `cargo test --lib <filter>`.

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `src/workflow_handlers.rs` | `WorkflowRunSummary` 瘦字段；`workflow_runs_list_sql()`；`get_workflow_runs` 改用它 |
| `frontend-nextjs/components/workflow/replay/replayApi.ts` | 列表类型对齐摘要字段 |
| `frontend-nextjs/components/workflow/runDetailLoad.ts` | 展开时是否该请求明细（纯函数） |
| `frontend-nextjs/components/workflow/runDetailLoad.test.ts` | 上述纯函数测试 |
| `frontend-nextjs/components/workflow/WorkflowsManager.tsx` | 弹层用摘要；展开调 `fetchReplayRunDetail` 并缓存 |
| `src/cloud_log.rs` | `is_plain_sls_keyword` / `expand_plain_sls_keyword` / `compose_sls_query` |
| `frontend-nextjs/app/workspace/[projectId]/cloud-logs/enterSubmit.ts` | Enter（非 IME）是否提交 |
| `frontend-nextjs/app/workspace/[projectId]/cloud-logs/enterSubmit.test.ts` | Enter 判定测试 |
| `frontend-nextjs/app/workspace/[projectId]/cloud-logs/page.tsx` | 占位符 + 回车查询 |

---

### Task 1: 瘦 `GET /runs` 列表 SQL

**Files:**
- Modify: `src/workflow_handlers.rs`（`WorkflowRunSummary` ~417、`get_workflow_runs` ~3370、同文件 `#[cfg(test)]`）

**Interfaces:**
- Consumes: `management.workflow_runs.node_results` JSONB（仅在 SQL 内聚合，不选出）
- Produces:
  - `fn workflow_runs_list_sql() -> &'static str`
  - `WorkflowRunSummary { id, workflow_id, trigger_type, status, elapsed_ms, started_at, completed_at, error_message, node_count, executed_count, failed_count }` — **无** `node_results`

- [ ] **Step 1: Write the failing test**

在 `src/workflow_handlers.rs` 已有 `mod tests`（`publish_live_update_sql_sets_updated_by` 附近）追加：

```rust
    #[test]
    fn workflow_runs_list_sql_is_summary_without_node_results_blob() {
        let sql = workflow_runs_list_sql();
        assert!(sql.contains("r.error_message"), "{sql}");
        assert!(sql.contains("AS node_count"), "{sql}");
        assert!(sql.contains("AS executed_count"), "{sql}");
        assert!(sql.contains("AS failed_count"), "{sql}");
        assert!(sql.contains("jsonb_array_length(r.node_results)"), "{sql}");
        assert!(
            !sql.contains("r.node_results,")
                && !sql.contains(", r.node_results")
                && !sql.contains("SELECT r.node_results"),
            "must not project node_results as a column: {sql}"
        );
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --bin onebase workflow_runs_list_sql_is_summary_without_node_results_blob -- --nocapture`

Expected: FAIL（`workflow_runs_list_sql` 未定义，或现有内联 SQL 不含 `AS node_count`）

- [ ] **Step 3: Write minimal implementation**

把 `WorkflowRunSummary` 换成：

```rust
/// 运行列表一行。不含 `node_results` / `trigger_data`（大 JSON 与敏感入参）。
#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct WorkflowRunSummary {
    pub id: i64,
    pub workflow_id: i32,
    pub trigger_type: String,
    pub status: String,
    pub elapsed_ms: Option<i64>,
    #[serde(serialize_with = "serialize_naive_as_utc")]
    pub started_at: chrono::NaiveDateTime,
    #[serde(serialize_with = "serialize_naive_as_utc_opt")]
    pub completed_at: Option<chrono::NaiveDateTime>,
    pub error_message: Option<String>,
    pub node_count: i32,
    pub executed_count: i32,
    pub failed_count: i32,
}
```

在 `get_workflow_runs` 上方增加：

```rust
fn workflow_runs_list_sql() -> &'static str {
    r#"SELECT r.id, r.workflow_id, r.trigger_type, r.status, r.elapsed_ms,
              r.started_at, r.completed_at, r.error_message,
              COALESCE(jsonb_array_length(r.node_results), 0) AS node_count,
              (
                SELECT COUNT(*)::int
                FROM jsonb_array_elements(COALESCE(r.node_results, '[]'::jsonb)) e
                WHERE COALESCE(e->>'status', '') IS DISTINCT FROM 'skipped'
              ) AS executed_count,
              (
                SELECT COUNT(*)::int
                FROM jsonb_array_elements(COALESCE(r.node_results, '[]'::jsonb)) e
                WHERE e->>'status' = 'failed'
              ) AS failed_count
       FROM management.workflow_runs r
       WHERE r.workflow_id = $1
       ORDER BY r.started_at DESC
       LIMIT $2"#
}
```

`get_workflow_runs` 里 `.query_as` 改用 `workflow_runs_list_sql()`。`get_workflow_run_detail` 不要改。

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --bin onebase workflow_runs_list_sql_is_summary_without_node_results_blob -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workflow_handlers.rs
git commit -m "fix: 工作流执行记录列表不再返回 node_results 大字段。"
```

Skip until the user asks to commit.

---

### Task 2: 弹层先出列表，展开再拉明细

**Files:**
- Create: `frontend-nextjs/components/workflow/runDetailLoad.ts`
- Create: `frontend-nextjs/components/workflow/runDetailLoad.test.ts`
- Modify: `frontend-nextjs/components/workflow/replay/replayApi.ts`
- Modify: `frontend-nextjs/components/workflow/WorkflowsManager.tsx`

**Interfaces:**
- Consumes: Task 1 JSON 字段；`fetchReplayRunDetail(workflowId, runId)`
- Produces:
  - `ReplayRunSummary` 含 `error_message?`, `node_count?`, `executed_count?`, `failed_count?`；列表不再依赖 `node_results`
  - `runDetailFetchId(runId, open, loadedIds: ReadonlySet<number>): number | null`

- [ ] **Step 1: Write the failing test**

`frontend-nextjs/components/workflow/runDetailLoad.test.ts`:

```ts
import assert from 'node:assert/strict'
import { runDetailFetchId } from './runDetailLoad'

const loaded = new Set<number>([2])

assert.equal(runDetailFetchId(1, false, loaded), null)
assert.equal(runDetailFetchId(2, true, loaded), null)
assert.equal(runDetailFetchId(1, true, loaded), 1)

console.log('runDetailLoad tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx frontend-nextjs/components/workflow/runDetailLoad.test.ts`

Working directory: repo root. Expected: FAIL（模块不存在或函数未定义）

- [ ] **Step 3: Write minimal implementation**

`frontend-nextjs/components/workflow/runDetailLoad.ts`:

```ts
/** 展开且尚未缓存时返回应请求的 run id，否则 null。 */
export function runDetailFetchId(
  runId: number,
  open: boolean,
  loadedIds: ReadonlySet<number>,
): number | null {
  if (!open) return null
  if (loadedIds.has(runId)) return null
  return runId
}
```

`replayApi.ts` 把 `ReplayRunSummary` 改成：

```ts
export interface ReplayRunSummary {
  id: number
  workflow_id: number
  status: string
  trigger_type?: string | null
  elapsed_ms: number | null
  started_at: string
  completed_at: string | null
  error_message?: string | null
  node_count?: number
  executed_count?: number
  failed_count?: number
  node_results?: ReplayNodeResult[]
}
```

`WorkflowsManager.tsx`：

1. 删掉本地 `interface WorkflowRun`。文件顶部增加：

```ts
import {
  fetchReplayRunDetail,
  type ReplayRunDetail,
  type ReplayRunSummary,
} from '@/components/workflow/replay/replayApi'
import { runDetailFetchId } from '@/components/workflow/runDetailLoad'
```

2. `const [runs, setRuns] = useState<ReplayRunSummary[]>([])`

3. 增加：

```ts
const [runDetails, setRunDetails] = useState<Record<number, ReplayRunDetail>>({})
const [runDetailLoading, setRunDetailLoading] = useState<Record<number, boolean>>({})
const [runDetailError, setRunDetailError] = useState<Record<number, string>>({})
const [openRunDetails, setOpenRunDetails] = useState<Record<number, boolean>>({})
```

4. `loadRuns` 成功后清空上述四个 Record，并继续请求 `GET /api/admin/workflows/${id}/runs?limit=20`。

5. `handleViewReplay` 参数改为 `ReplayRunSummary`。

6. 加载明细（先看缓存，再请求）：

```ts
  const ensureRunDetail = async (workflowId: number, runId: number) => {
    const loaded = new Set(Object.keys(runDetails).map(Number))
    if (runDetailFetchId(runId, true, loaded) == null) return
    if (runDetailLoading[runId]) return
    setRunDetailLoading((s) => ({ ...s, [runId]: true }))
    setRunDetailError((s) => {
      const next = { ...s }
      delete next[runId]
      return next
    })
    try {
      const detail = await fetchReplayRunDetail(workflowId, runId)
      setRunDetails((s) => ({ ...s, [runId]: detail }))
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { error?: string } }; message?: string }
      setRunDetailError((s) => ({
        ...s,
        [runId]: ax.response?.data?.error || ax.message || '加载失败',
      }))
    } finally {
      setRunDetailLoading((s) => ({ ...s, [runId]: false }))
    }
  }
```

7. 弹层每一行：

- `const executed = run.executed_count ?? 0`
- `const failed = run.failed_count ?? 0`
- 摘要：`executed > 0` 显示「N 个节点执行」；`failed > 0` 时红字「· M 失败」
- `run.error_message` 仍在摘要下方展示
- 「逐节点详情」受控、默认收起：

```tsx
<details
  className="mt-3"
  open={!!openRunDetails[run.id]}
  onToggle={(e) => {
    const open = (e.currentTarget as HTMLDetailsElement).open
    setOpenRunDetails((s) => ({ ...s, [run.id]: open }))
    if (open && showRuns != null) void ensureRunDetail(showRuns, run.id)
  }}
>
  <summary className="text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">
    逐节点详情 ({run.node_count ?? 0})
  </summary>
  <div className="mt-2">
    {runDetailLoading[run.id] && <p className="text-xs text-gray-400">加载中…</p>}
    {runDetailError[run.id] && (
      <p className="text-xs text-red-600">
        {runDetailError[run.id]}{' '}
        <button
          type="button"
          className="underline"
          onClick={() => showRuns != null && void ensureRunDetail(showRuns, run.id)}
        >
          重试
        </button>
      </p>
    )}
    {runDetails[run.id]?.node_results && (
      <NodeResultList results={runDetails[run.id].node_results} />
    )}
    {runDetails[run.id]?.final_output != null && (
      <details className="mt-2">
        <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">最终输出</summary>
        <JsonLogBlock value={runDetails[run.id].final_output} />
      </details>
    )}
  </div>
</details>
```

列表不要再读 `run.node_results` / `run.final_output`。

`NodeResultList` 若仍要求 `NodeResultItem[]`，把 `runDetails[run.id].node_results` 断言或映射为现有类型，不要改节点详情 UI。

- [ ] **Step 4: Run tests**

Run: `npx tsx frontend-nextjs/components/workflow/runDetailLoad.test.ts`

Expected: `runDetailLoad tests passed`

不要改 `ExecutionReplayView` 的选中→拉明细逻辑。

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/components/workflow/runDetailLoad.ts \
  frontend-nextjs/components/workflow/runDetailLoad.test.ts \
  frontend-nextjs/components/workflow/replay/replayApi.ts \
  frontend-nextjs/components/workflow/WorkflowsManager.tsx
git commit -m "fix: 执行记录弹层先出摘要，展开后再加载节点详情。"
```

Skip until asked.

---

### Task 3: 云日志普通词编成 content/message 检索

**Files:**
- Modify: `src/cloud_log.rs`

**Interfaces:**
- Consumes: `compose_sls_query(prefix, user_query, request_id)`
- Produces:
  - `pub fn is_plain_sls_keyword(q: &str) -> bool`
  - `pub fn expand_plain_sls_keyword(q: &str) -> String`
  - `compose_sls_query`：普通词走 expand，否则原样

- [ ] **Step 1: Write the failing tests**

**改**现有 `compose_joins_prefix_query_and_request_id`（`error` 现为普通词），并新增：

```rust
    #[test]
    fn compose_joins_prefix_query_and_request_id() {
        let q = compose_sls_query(
            Some(" app:pay "),
            Some("error"),
            Some("98753d7e-3bdb-4c00-bcf7-4a697606b88b"),
        )
        .unwrap();
        assert_eq!(
            q,
            r#"app:pay and (content: "error" or message: "error" or "error") and x_request_id: "98753d7e-3bdb-4c00-bcf7-4a697606b88b""#
        );
    }

    #[test]
    fn plain_keyword_expands_to_content_and_message() {
        assert!(is_plain_sls_keyword("超时"));
        assert!(is_plain_sls_keyword("android"));
        assert!(!is_plain_sls_keyword("level: ERROR"));
        assert!(!is_plain_sls_keyword("foo and bar"));
        assert!(!is_plain_sls_keyword("a|b"));
        assert_eq!(
            compose_sls_query(None, Some("超时"), None).unwrap(),
            r#"(content: "超时" or message: "超时" or "超时")"#
        );
        assert_eq!(
            compose_sls_query(None, Some("level: ERROR"), None).unwrap(),
            "level: ERROR"
        );
    }

    #[test]
    fn expand_escapes_backslash_and_quotes() {
        assert_eq!(
            expand_plain_sls_keyword(r#"a\b"c"#),
            r#"(content: "a\\b\"c" or message: "a\\b\"c" or "a\\b\"c")"#
        );
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test --lib plain_keyword_expands_to_content_and_message -- --nocapture
cargo test --lib compose_joins_prefix_query_and_request_id -- --nocapture
```

Expected: 前者 FAIL（函数未定义或仍返回裸 `超时`）；后者 FAIL（仍是 `app:pay and error and ...`）

- [ ] **Step 3: Write minimal implementation**

在 `compose_sls_query` 上方：

```rust
pub fn is_plain_sls_keyword(q: &str) -> bool {
    let t = q.trim();
    if t.is_empty() {
        return false;
    }
    if t.chars().any(|c| matches!(c, ':' | '"' | '\'' | '(' | ')' | '|')) {
        return false;
    }
    !t.split_whitespace()
        .any(|w| matches!(w.to_ascii_lowercase().as_str(), "and" | "or" | "not"))
}

pub fn expand_plain_sls_keyword(q: &str) -> String {
    let esc = q.replace('\\', "\\\\").replace('"', "\\\"");
    format!(r#"(content: "{esc}" or message: "{esc}" or "{esc}")"#)
}
```

`compose_sls_query` 的 `user_query` 分支改为：

```rust
    if let Some(q) = user_query.map(str::trim).filter(|s| !s.is_empty()) {
        if is_plain_sls_keyword(q) {
            parts.push(expand_plain_sls_keyword(q));
        } else {
            parts.push(q.to_string());
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test --lib compose_joins_prefix_query_and_request_id -- --nocapture
cargo test --lib plain_keyword_expands_to_content_and_message -- --nocapture
cargo test --lib expand_escapes_backslash_and_quotes -- --nocapture
cargo test --lib compose_empty_is_star -- --nocapture
```

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/cloud_log.rs
git commit -m "fix: 云日志普通关键字按 content/message 短语检索。"
```

Skip until asked.

---

### Task 4: 云日志输入回车查询 + 占位文案

**Files:**
- Create: `frontend-nextjs/app/workspace/[projectId]/cloud-logs/enterSubmit.ts`
- Create: `frontend-nextjs/app/workspace/[projectId]/cloud-logs/enterSubmit.test.ts`
- Modify: `frontend-nextjs/app/workspace/[projectId]/cloud-logs/page.tsx`

**Interfaces:**
- Consumes: 现有 `handleQuery`
- Produces: `export function shouldSubmitOnKeyDown(e: { key: string; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean }): boolean`

- [ ] **Step 1: Write the failing test**

`frontend-nextjs/app/workspace/[projectId]/cloud-logs/enterSubmit.test.ts`:

```ts
import assert from 'node:assert/strict'
import { shouldSubmitOnKeyDown } from './enterSubmit'

assert.equal(shouldSubmitOnKeyDown({ key: 'Enter' }), true)
assert.equal(shouldSubmitOnKeyDown({ key: 'Enter', nativeEvent: { isComposing: true } }), false)
assert.equal(shouldSubmitOnKeyDown({ key: 'Enter', isComposing: true }), false)
assert.equal(shouldSubmitOnKeyDown({ key: 'a' }), false)

console.log('enterSubmit tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx frontend-nextjs/app/workspace/[projectId]/cloud-logs/enterSubmit.test.ts`

Working directory: repo root. Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

`enterSubmit.ts`:

```ts
export function shouldSubmitOnKeyDown(e: {
  key: string
  nativeEvent?: { isComposing?: boolean }
  isComposing?: boolean
}): boolean {
  if (e.key !== 'Enter') return false
  if (e.isComposing || e.nativeEvent?.isComposing) return false
  return true
}
```

`page.tsx` 增加 `import { shouldSubmitOnKeyDown } from './enterSubmit'`。

关键字与 `x_request_id` 两个 `<input>` 增加：

```tsx
onKeyDown={(e) => {
  if (shouldSubmitOnKeyDown(e)) {
    e.preventDefault()
    void handleQuery()
  }
}}
```

关键字 `placeholder` 改为：`搜日志内容，如 超时 / error`

- [ ] **Step 4: Run tests**

```bash
npx tsx frontend-nextjs/app/workspace/[projectId]/cloud-logs/enterSubmit.test.ts
npx tsx frontend-nextjs/app/workspace/[projectId]/cloud-logs/window.test.ts
```

Expected: `enterSubmit tests passed` 且 `ok`

- [ ] **Step 5: Commit**

```bash
git add \
  frontend-nextjs/app/workspace/\[projectId\]/cloud-logs/enterSubmit.ts \
  frontend-nextjs/app/workspace/\[projectId\]/cloud-logs/enterSubmit.test.ts \
  frontend-nextjs/app/workspace/\[projectId\]/cloud-logs/page.tsx
git commit -m "fix: 云日志关键字支持回车查询，并标明搜正文。"
```

Skip until asked.

---

## Spec coverage

| Spec | Task |
|------|------|
| 列表不含 `node_results`，含计数与 `error_message` | 1 |
| 弹层摘要用 executed/failed；详情默认收起；展开才请求；缓存 | 2 |
| 回放共用瘦列表、明细仍走 detail | 2（类型）；`ExecutionReplayView` 已拉 detail |
| 普通词 → content/message 短语；高级语法原样 | 3 |
| 引号/反斜杠转义 | 3 |
| 回车查询、占位文案 | 4 |
| 不预拉、不改 limit/时间窗 | Global |

## Type consistency

- 计数字段名全程 `node_count` / `executed_count` / `failed_count`。
- 明细仍是 `ReplayRunDetail.node_results`。
- 列表 SQL 表别名 `r.`，测试按此断言。
- `is_plain_sls_keyword` / `expand_plain_sls_keyword` 只在 `cloud_log.rs`；compose 在 trim 后调用。
