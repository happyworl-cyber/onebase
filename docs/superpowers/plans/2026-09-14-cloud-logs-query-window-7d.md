# 云日志查询时间窗 7 天 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 站内阿里云 SLS 单次查询时间跨度上限从 24 小时改为 7 天；默认仍最近 1 小时。

**Architecture:** 闸门仍只在 `resolve_query_window`。前端用同一秒数和同一句错误文案，超限 toast 且不发请求。一次 GetLogs，不切片。

**Tech Stack:** Rust（`src/cloud_log.rs` 单测），Next.js 云日志页，前端 `node:assert` 脚本。

**Spec:** `docs/superpowers/specs/2026-09-14-cloud-logs-query-window-7d-design.md`

## Global Constraints

- Do not create git commits unless the user explicitly asks. Keep Commit steps but skip them until asked.
- `MAX_WINDOW_SECS = 7 * 86400`。超限文案必须是 `时间窗不能超过 7 天`。
- 默认窗口仍最近 1 小时（`DEFAULT_WINDOW_SECS = 3600`）。`line` 仍默认 50、上限 100。
- 仍一次 GetLogs；不按天拆请求；不切 GetLogsV2；不提高 `line`。
- 不改控制台深链拼法（仍用本次 `from`/`to`）。
- 不改网关监控、JWT、对象存储 presign 等其它 24h 窗口。

## File Structure

| Path | Responsibility |
|------|----------------|
| `src/cloud_log.rs` | `MAX_WINDOW_SECS`、错误文案、`resolve_query_window` 单测 |
| `frontend-nextjs/app/workspace/[projectId]/cloud-logs/window.ts` | 与后端相同的 7 天秒数和超限文案 |
| `frontend-nextjs/app/workspace/[projectId]/cloud-logs/window.test.ts` | 前端超限判定 |
| `frontend-nextjs/app/workspace/[projectId]/cloud-logs/page.tsx` | 提示文案；查询 / 打开控制台前拦截 |

`cloud_log_handlers.rs` 已 `map_err(AppError::InvalidQuery)`，不用改。

---

### Task 1: 后端时间窗 7 天

**Files:**
- Modify: `src/cloud_log.rs`

**Interfaces:**
- Consumes: existing `resolve_query_window(from: Option<i64>, to: Option<i64>, now: i64) -> Result<(i64, i64), String>`
- Produces: `pub const MAX_WINDOW_SECS: i64 = 7 * 86400`；超限 `Err("时间窗不能超过 7 天")`；`to - from == MAX_WINDOW_SECS` 为合法

- [x] **Step 1: 改单测，先让它失败**

In `src/cloud_log.rs` replace `window_defaults_and_rejects_oversize` with:

```rust
    #[test]
    fn window_defaults_and_rejects_oversize() {
        let now = 2_000_000_i64;
        assert_eq!(
            resolve_query_window(None, None, now).unwrap(),
            (now - 3600, now)
        );
        let week = 7 * 86400;
        assert!(resolve_query_window(Some(1), Some(1 + week), now).is_ok());
        assert_eq!(
            resolve_query_window(Some(1), Some(1 + week + 1), now).unwrap_err(),
            "时间窗不能超过 7 天"
        );
        assert!(resolve_query_window(Some(10), Some(10), now).is_err());
        // 旧 24h 上限必须已经放开
        assert!(resolve_query_window(Some(1), Some(1 + 86400 + 1), now).is_ok());
    }
```

- [ ] **Step 2: 跑测，确认失败**

Run: `cargo test --bin onebase -- window_defaults_and_rejects_oversize -- --nocapture`

Expected: FAIL（仍是 24h 常量/文案，`1 + week` 被拒，或 `unwrap_err()` 对不上「7 天」）

- [x] **Step 3: 改常量和文案**

In `src/cloud_log.rs`:

```rust
pub const MAX_WINDOW_SECS: i64 = 7 * 86400;
```

```rust
    if to - from > MAX_WINDOW_SECS {
        return Err("时间窗不能超过 7 天".into());
    }
```

Do not change `DEFAULT_WINDOW_SECS` / `clamp_line` / `sls_console_url`.

- [x] **Step 4: 再跑测**

Run: `cargo test --bin onebase -- cloud_log::tests -- --nocapture`

Expected: PASS（含 `window_defaults_and_rejects_oversize`）

- [ ] **Step 5: Commit（用户要求时才执行）**

```bash
git add src/cloud_log.rs
git commit -m "$(cat <<'EOF'
feat: 云日志查询时间窗上限改为 7 天。

EOF
)"
```

---

### Task 2: 前端提示与提交前拦截

**Files:**
- Create: `frontend-nextjs/app/workspace/[projectId]/cloud-logs/window.ts`
- Create: `frontend-nextjs/app/workspace/[projectId]/cloud-logs/window.test.ts`
- Modify: `frontend-nextjs/app/workspace/[projectId]/cloud-logs/page.tsx`

**Interfaces:**
- Consumes: Task 1 的秒数与文案（前端复制常量，不跨语言 import）
- Produces:
  - `export const MAX_WINDOW_SECS = 7 * 86400`
  - `export const MAX_WINDOW_ERROR = '时间窗不能超过 7 天'`
  - `export function oversizeWindowError(from?: number, to?: number): string | null` — `from`/`to` 缺一则 `null`（交给后端默认 1h）；`to - from > MAX_WINDOW_SECS` 则返回 `MAX_WINDOW_ERROR`

- [ ] **Step 1: 写失败的前端测**

Create `frontend-nextjs/app/workspace/[projectId]/cloud-logs/window.test.ts`:

```ts
import assert from 'node:assert/strict'
import { MAX_WINDOW_ERROR, MAX_WINDOW_SECS, oversizeWindowError } from './window'

assert.equal(MAX_WINDOW_SECS, 7 * 86400)
assert.equal(oversizeWindowError(undefined, 100), null)
assert.equal(oversizeWindowError(1, 1 + 7 * 86400), null)
assert.equal(oversizeWindowError(1, 1 + 7 * 86400 + 1), MAX_WINDOW_ERROR)
assert.equal(oversizeWindowError(1, 1 + 86401), null)
console.log('ok')
```

Create `frontend-nextjs/app/workspace/[projectId]/cloud-logs/window.ts` that does not yet match (e.g. still `86400` and `'时间窗不能超过 24 小时'`) so the test fails, or omit the file and let import fail.

- [ ] **Step 2: 跑测，确认失败**

Run: `node --experimental-strip-types frontend-nextjs/app/workspace/[projectId]/cloud-logs/window.test.ts`

If `--experimental-strip-types` fails on this Node, run: `npx tsx frontend-nextjs/app/workspace/[projectId]/cloud-logs/window.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现 window.ts**

```ts
export const MAX_WINDOW_SECS = 7 * 86400
export const MAX_WINDOW_ERROR = '时间窗不能超过 7 天'

export function oversizeWindowError(from?: number, to?: number): string | null {
  if (from == null || to == null) return null
  if (to - from > MAX_WINDOW_SECS) return MAX_WINDOW_ERROR
  return null
}
```

- [ ] **Step 4: 再跑前端测**

Same command as Step 2. Expected: prints `ok`，exit 0

- [ ] **Step 5: 接到查询页**

In `page.tsx` add:

```ts
import { MAX_WINDOW_ERROR, oversizeWindowError } from './window'
```

In `handleQuery`, after `请选择日志源`，before `setLoading(true)`:

```ts
    const spanErr = oversizeWindowError(queryBody.from, queryBody.to)
    if (spanErr) return notify.error(spanErr)
```

`notify.error` 接受 string（见 `useNotification.ts`）。用户可见文案必须是 `MAX_WINDOW_ERROR`。

Same `oversizeWindowError` check at the start of `openConsole`（在已有 `consoleUrl` 缓存打开之后、打 `consoleUrl` API 之前），避免超 7 天点「在阿里云打开」才撞后端 400。

Next to 开始 / 结束 inputs, add a hint. Prefer one line under the pair, not duplicating on both labels:

```tsx
            <p className="text-xs text-gray-500 sm:col-span-2">单次最长 7 天</p>
```

If the form is not a grid, put the same `<p className="text-xs text-gray-500">单次最长 7 天</p>` immediately after the 结束 `</label>`.

Do not change `nowSec - 3600` default range.

- [ ] **Step 6: Commit（用户要求时才执行）**

```bash
git add frontend-nextjs/app/workspace/\[projectId\]/cloud-logs/window.ts \
        frontend-nextjs/app/workspace/\[projectId\]/cloud-logs/window.test.ts \
        frontend-nextjs/app/workspace/\[projectId\]/cloud-logs/page.tsx
git commit -m "$(cat <<'EOF'
feat: 云日志页提示并拦截超过 7 天的查询。

EOF
)"
```

---

## Verification

- `cargo test --bin onebase -- cloud_log::tests`
- `node --experimental-strip-types frontend-nextjs/app/workspace/[projectId]/cloud-logs/window.test.ts`（或 `npx tsx` 同源文件）
- 云日志页：默认仍约 1 小时；跨 25 小时可查；跨 7 天 + 1 秒 toast「时间窗不能超过 7 天」且 Network 无 query POST
