# PG row JSON smallint/float4 decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `pg_row_to_json` so Postgres `smallint`/`int2` and `real`/`float4` decode to JSON numbers instead of silent `null`.

**Architecture:** Single change in `src/pg_row_json.rs` `decode_pg_value`: add `i16`/`Option<i16>` and `f32`/`Option<f32>` try_get branches next to existing integer/float branches. Integration-style unit test hits a live PG (skip if no `DATABASE_URL` / `DATABASE_URL_TEST`).

**Tech Stack:** Rust, sqlx 0.7 Postgres, serde_json

## Global Constraints

- Only modify `src/pg_row_json.rs` (and its tests).
- Do not change workflow SQL, #49, or cutover flags.
- Unknown PG types still fall through to `Value::Null`.
- Do not change MySQL row decoding.

---

### Task 1: Failing test + decode branches for i16/f32

**Files:**
- Modify: `src/pg_row_json.rs`

**Interfaces:**
- Consumes: `pg_row_to_json(&PgRow) -> Value` (existing)
- Produces: same function; additionally decodes `i16`/`Option<i16>`/`f32`/`Option<f32>`

- [x] **Step 1: Write the failing test**

Add to `src/pg_row_json.rs` `#[cfg(test)] mod tests`:

```rust
async fn connect_test_pg() -> Option<sqlx::PgPool> {
    let url = std::env::var("DATABASE_URL_TEST")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .ok()
}

#[tokio::test]
async fn smallint_and_real_decode_as_json_numbers_not_null() {
    let Some(pool) = connect_test_pg().await else {
        eprintln!("DATABASE_URL(_TEST) unset/unreachable, skip");
        return;
    };
    let row = sqlx::query(
        "SELECT 1::smallint AS s, NULL::smallint AS s_null, 1.5::real AS r, NULL::real AS r_null",
    )
    .fetch_one(&pool)
    .await
    .expect("query");
    let v = pg_row_to_json(&row);
    assert_eq!(v["s"], json!(1));
    assert_eq!(v["s_null"], Value::Null);
    assert_eq!(v["r"], json!(1.5));
    assert_eq!(v["r_null"], Value::Null);
}
```

Ensure `tokio` is already a crate dependency (it is). Keep existing `uuid_formats_as_hyphenated_string` test.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p onebase --lib pg_row_json::tests::smallint_and_real_decode_as_json_numbers_not_null -- --nocapture`

Expected (with DB available): FAIL — `s` is `Null` (or `r` is `Null`), not the expected number.

If DB unavailable and test skips: still proceed, but note skip in commit message; prefer running against `.env` `DATABASE_URL`.

- [x] **Step 3: Write minimal implementation**

In `decode_pg_value`, after the non-Option `i64` branch, add:

```rust
if let Ok(v) = row.try_get::<i16, _>(idx) {
    return json!(v);
}
```

After the non-Option `f64` branch, add:

```rust
if let Ok(v) = row.try_get::<f32, _>(idx) {
    return json!(v);
}
```

In the Option section, after `Option<i64>`, add:

```rust
if let Ok(v) = row.try_get::<Option<i16>, _>(idx) {
    return v.map(|n| json!(n)).unwrap_or(Value::Null);
}
```

After `Option<f64>`, add:

```rust
if let Ok(v) = row.try_get::<Option<f32>, _>(idx) {
    return v.map(|n| json!(n)).unwrap_or(Value::Null);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: same `cargo test` command as Step 2.

Expected: PASS (or skip only if DB truly unreachable).

Also run: `cargo test -p onebase --lib pg_row_json::tests -- --nocapture`

Expected: both unit tests pass / skip cleanly.

- [x] **Step 5: Commit**

```bash
git add src/pg_row_json.rs
git commit -m "$(cat <<'EOF'
fix: decode PG smallint/real in pg_row_to_json

EOF
)"
```

- [x] **Step 6: Update spec status**

In `docs/superpowers/specs/2026-07-29-pg-row-json-smallint-design.md`, set `状态：已实现`. Commit:

```bash
git add docs/superpowers/specs/2026-07-29-pg-row-json-smallint-design.md
git commit -m "$(cat <<'EOF'
docs: mark pg_row_json smallint design implemented

EOF
)"
```
