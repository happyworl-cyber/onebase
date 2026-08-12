# Project Member User Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让项目 owner/admin 在成员管理页重置成员密码、改用户名/邮箱、启停账号（全局生效）。

**Architecture:** 新增项目作用域 API（`/api/projects/:id/members/:user_id/{profile,reset-password,status}`），鉴权为 `require_tenant_admin` + 目标为本项目活跃成员 + 禁止改自己。新增 `users.is_active`，登录与 JWT 会话中间件拦截停用账号。前端成员页增加「管理」抽屉。

**Tech Stack:** Rust/Axum/sqlx、Next.js、现有 `Drawer` / `projectMembersAPI`、bash e2e（`tests/m1_workspace_members_test.sh` 风格）

**Spec:** `docs/superpowers/specs/2026-08-12-project-member-user-admin-design.md`

## Global Constraints

- 调用者：项目 owner/admin 或平台超管（`require_tenant_admin`）
- 目标：本项目活跃成员；禁止 `user_id == claims.sub`
- 允许改本项目内的平台超管；不暴露改 `is_superadmin`
- 密码强度：≥8，含大小写字母与数字（复用 `admin_handlers::validate_password`）
- 重置密码 / 停用：吊销目标用户全部会话
- 改邮箱/用户名/停用：全局生效（`users` 表）
- 本期不设置 `must_change_password`

## File Structure

| File | Responsibility |
|------|----------------|
| `migrations/059_users_is_active.sql` | 新增 `users.is_active`（合并 develop 后编号；原 feature 分支曾为 057） |
| `src/migrate.rs` | 注册迁移 |
| `src/admin_handlers.rs` | 将 `validate_password` / `validate_username` / `validate_email` 改为 `pub(crate)` |
| `src/tenant_handlers.rs` | 成员列表加 `is_active`；共用前置 helper；三个新 handler |
| `src/main.rs` | 注册三条新路由（须在 `/:user_id` 之前或用更具体 path） |
| `src/auth_handlers.rs` | login 拒绝 `is_active=false` |
| `src/middleware.rs` | JWT 会话校验拒绝已停用用户 |
| `frontend-nextjs/lib/api.ts` | `ProjectMember.is_active` + API 方法 |
| `frontend-nextjs/app/workspace/[projectId]/settings/members/page.tsx` | 管理抽屉 UI |
| `tests/m1_workspace_member_admin_test.sh` | 新接口 e2e |

---

### Task 1: Migration + list members returns `is_active`

**Files:**
- Create: `migrations/059_users_is_active.sql`
- Modify: `src/migrate.rs` (append to `MIGRATIONS` after 056)
- Modify: `src/tenant_handlers.rs` (`list_project_members` SQL + `member_row_to_json`)

**Interfaces:**
- Produces: `users.is_active BOOLEAN NOT NULL DEFAULT true`; list JSON field `is_active: bool`

- [ ] **Step 1: Add migration file**

```sql
-- 059_users_is_active.sql
-- 平台用户启停：false 时禁止登录，且 JWT 会话中间件拒绝后续请求。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN users.is_active IS
  'false=账号停用：禁止登录，已签发会话在 auth_middleware 中拒绝';
```

- [ ] **Step 2: Register in `src/migrate.rs`**

Append after object-storage migrations (057/058 on develop):

```rust
    (
        "059 users is_active",
        include_str!("../migrations/059_users_is_active.sql"),
    ),
```

- [ ] **Step 3: Extend list SQL and JSON**

In `list_project_members` SELECT, add:

```sql
COALESCE(u.is_active, true) AS is_active,
```

In `member_row_to_json`:

```rust
"is_active": row.get::<bool, _>("is_active"),
```

Ensure every other query that feeds `member_row_to_json` also selects `is_active` (add/create/update member return paths). Grep `member_row_to_json` and fix each SELECT.

- [ ] **Step 4: Run migrate (dev) and smoke list**

```bash
# 按项目惯例跑迁移后启动服务，用 admin JWT：
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/api/projects/$PROJECT_ID/members" | jq '.[0] | has("is_active")'
```

Expected: `true`

- [ ] **Step 5: Commit**

```bash
git add migrations/059_users_is_active.sql src/migrate.rs src/tenant_handlers.rs
git commit -m "$(cat <<'EOF'
feat(members): add users.is_active and expose it on member list

EOF
)"
```

---

### Task 2: Shared authz helper + profile PATCH

**Files:**
- Modify: `src/admin_handlers.rs` — `pub(crate) fn validate_password/username/email`
- Modify: `src/tenant_handlers.rs` — helper + `update_project_member_profile`
- Modify: `src/main.rs` — route registration

**Interfaces:**
- Consumes: `permissions::require_tenant_admin`, `admin_handlers::{validate_username, validate_email}`
- Produces:
  - `async fn require_manageable_project_member(pool, claims, project_id, target_user_id) -> Result<()>`
  - `pub async fn update_project_member_profile(...) -> Result<Json<Value>>`
  - Route: `PATCH /api/projects/:id/members/:user_id/profile`

- [ ] **Step 1: Write failing unit test for helper**

Add at bottom of `src/tenant_handlers.rs` (or next to members helpers):

```rust
#[cfg(test)]
mod member_admin_tests {
    use super::*;

    #[test]
    fn reject_self_management_error_message() {
        // 纯逻辑：文档化错误文案约定（集成测覆盖 DB）
        let msg = "不能管理自己的账号；请使用「修改密码」或联系其他管理员";
        assert!(msg.contains("自己"));
    }
}
```

Prefer a real helper test if you extract a sync predicate:

```rust
fn forbid_self(actor: i32, target: i32) -> bool {
    actor == target
}

#[test]
fn forbid_self_when_same_id() {
    assert!(forbid_self(3, 3));
    assert!(!forbid_self(3, 4));
}
```

- [ ] **Step 2: Make validators reusable**

In `src/admin_handlers.rs` change:

```rust
pub(crate) fn validate_password(p: &str) -> Result<()> { ... }
pub(crate) fn validate_username(name: &str) -> Result<()> { ... }
pub(crate) fn validate_email(email: &str) -> Result<()> { ... }
```

- [ ] **Step 3: Implement helper + profile handler in `tenant_handlers.rs`**

```rust
#[derive(Debug, Deserialize)]
pub struct UpdateMemberProfileRequest {
    pub username: Option<String>,
    pub email: Option<String>,
}

/// 项目 admin 可管理目标用户的前置条件。
async fn require_manageable_project_member(
    pool: &PgPool,
    claims: &Claims,
    project_id: i32,
    target_user_id: i32,
) -> Result<()> {
    permissions::require_tenant_admin(pool, claims, project_id).await?;
    if claims.sub == target_user_id {
        return Err(AppError::Forbidden(
            "不能管理自己的账号；请使用「修改密码」或联系其他管理员".to_string(),
        ));
    }
    let is_member: bool = sqlx::query_scalar(
        "SELECT EXISTS(\
           SELECT 1 FROM management.user_tenants \
           WHERE tenant_id = $1 AND user_id = $2 AND is_active = true)",
    )
    .bind(project_id)
    .bind(target_user_id)
    .fetch_one(pool)
    .await?;
    if !is_member {
        return Err(AppError::Forbidden(
            "目标用户不是本项目成员".to_string(),
        ));
    }
    Ok(())
}

pub async fn update_project_member_profile(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, target_user_id)): Path<(i32, i32)>,
    Json(req): Json<UpdateMemberProfileRequest>,
) -> Result<Json<serde_json::Value>> {
    require_manageable_project_member(&pool, &claims, project_id, target_user_id).await?;
    if req.username.is_none() && req.email.is_none() {
        return Err(AppError::InvalidQuery(
            "请求体为空，至少需要 username 或 email".to_string(),
        ));
    }

    let (cur_username, cur_email): (String, String) = sqlx::query_as(
        "SELECT username, email FROM users WHERE id = $1",
    )
    .bind(target_user_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("用户 {} 不存在", target_user_id)))?;

    let new_username = if let Some(ref name) = req.username {
        crate::admin_handlers::validate_username(name)?;
        Some(name.trim().to_string())
    } else {
        None
    };
    let new_email = if let Some(ref email) = req.email {
        crate::admin_handlers::validate_email(email)?;
        Some(email.trim().to_string())
    } else {
        None
    };

    if let Some(ref u) = new_username {
        if u != &cur_username {
            let dup: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM users WHERE username = $1 AND id <> $2)",
            )
            .bind(u)
            .bind(target_user_id)
            .fetch_one(&pool)
            .await?;
            if dup {
                return Err(AppError::InvalidQuery("用户名已被使用".to_string()));
            }
        }
    }
    if let Some(ref e) = new_email {
        if e != &cur_email {
            let dup: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1 AND id <> $2)",
            )
            .bind(e)
            .bind(target_user_id)
            .fetch_one(&pool)
            .await?;
            if dup {
                return Err(AppError::InvalidQuery("邮箱已被使用".to_string()));
            }
        }
    }

    sqlx::query(
        r#"
        UPDATE users
        SET username = COALESCE($2, username),
            email    = COALESCE($3, email)
        WHERE id = $1
        "#,
    )
    .bind(target_user_id)
    .bind(new_username.as_deref())
    .bind(new_email.as_deref())
    .execute(&pool)
    .await?;

    let (username, email): (String, String) =
        sqlx::query_as("SELECT username, email FROM users WHERE id = $1")
            .bind(target_user_id)
            .fetch_one(&pool)
            .await?;

    Ok(Json(json!({
        "ok": true,
        "user_id": target_user_id,
        "username": username,
        "email": email,
    })))
}
```

Note: `admin_handlers` is currently bin-only via `main.rs`. If `tenant_handlers` cannot call `crate::admin_handlers` from lib tests, keep validators in `tenant_handlers` by copying the three small functions, or move them to `src/auth.rs` / a tiny `user_validators` mod in both crates. **Preferred:** move the three `validate_*` functions into `src/auth.rs` (already shared by lib+bin) and update `admin_handlers` call sites.

- [ ] **Step 4: Register route in `main.rs` BEFORE `/:user_id` catch-all**

```rust
.route(
    "/api/projects/:id/members/:user_id/profile",
    axum::routing::patch(tenant_handlers::update_project_member_profile),
)
```

Place with other member admin routes (near create-user / before or after `/:user_id` — more specific paths are fine in axum 0.7 as separate routes).

- [ ] **Step 5: Manual verify**

```bash
# 项目 admin 改成员用户名
curl -sS -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"renamed_user"}' \
  "$API_BASE/api/projects/$PID/members/$UID/profile"
# 改自己 → 403
curl -sS -o /dev/null -w "%{http_code}" -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"username":"x"}' \
  "$API_BASE/api/projects/$PID/members/$ADMIN_UID/profile"
```

Expected: first 200；second `403`

- [ ] **Step 6: Commit**

```bash
git add src/auth.rs src/admin_handlers.rs src/tenant_handlers.rs src/main.rs
git commit -m "$(cat <<'EOF'
feat(members): add project-scoped member profile update API

EOF
)"
```

---

### Task 3: Reset password API

**Files:**
- Modify: `src/tenant_handlers.rs`
- Modify: `src/main.rs`

**Interfaces:**
- Consumes: `require_manageable_project_member`, `validate_password`, `auth::hash_password`, `permissions::revoke_user_sessions`
- Produces: `POST /api/projects/:id/members/:user_id/reset-password`

- [ ] **Step 1: Implement handler**

```rust
#[derive(Debug, Deserialize)]
pub struct ResetMemberPasswordRequest {
    pub new_password: String,
}

pub async fn reset_project_member_password(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, target_user_id)): Path<(i32, i32)>,
    Json(req): Json<ResetMemberPasswordRequest>,
) -> Result<Json<serde_json::Value>> {
    require_manageable_project_member(&pool, &claims, project_id, target_user_id).await?;
    // 若 validators 已迁到 auth：crate::auth::validate_password
    crate::admin_handlers::validate_password(&req.new_password)?;

    let new_hash = crate::auth::hash_password(&req.new_password)?;
    let res = sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(&new_hash)
        .bind(target_user_id)
        .execute(&pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("用户 {} 不存在", target_user_id)));
    }

    let _ = permissions::revoke_user_sessions(
        &pool,
        target_user_id,
        "password_reset_by_project_admin",
    )
    .await;

    Ok(Json(json!({
        "ok": true,
        "message": "密码已重置，目标用户需要重新登录",
    })))
}
```

- [ ] **Step 2: Register route**

```rust
.route(
    "/api/projects/:id/members/:user_id/reset-password",
    axum::routing::post(tenant_handlers::reset_project_member_password),
)
```

- [ ] **Step 3: Verify weak password rejected + session revoked**

```bash
curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"new_password":"short"}' \
  "$API_BASE/api/projects/$PID/members/$UID/reset-password"
# expect 400

curl -sS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"new_password":"NewPass12"}' \
  "$API_BASE/api/projects/$PID/members/$UID/reset-password"
# expect ok; target's old token → 401 on /auth/me
```

- [ ] **Step 4: Commit**

```bash
git add src/tenant_handlers.rs src/main.rs
git commit -m "$(cat <<'EOF'
feat(members): allow project admins to reset member passwords

EOF
)"
```

---

### Task 4: Status API + login/middleware gate

**Files:**
- Modify: `src/tenant_handlers.rs`
- Modify: `src/main.rs`
- Modify: `src/auth_handlers.rs` (`UserRow` + login SELECT + early reject)
- Modify: `src/middleware.rs` (session query includes `u.is_active`)

**Interfaces:**
- Produces: `PATCH /api/projects/:id/members/:user_id/status` body `{ "is_active": bool }`

- [ ] **Step 1: Status handler**

```rust
#[derive(Debug, Deserialize)]
pub struct UpdateMemberStatusRequest {
    pub is_active: bool,
}

pub async fn update_project_member_status(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Path((project_id, target_user_id)): Path<(i32, i32)>,
    Json(req): Json<UpdateMemberStatusRequest>,
) -> Result<Json<serde_json::Value>> {
    require_manageable_project_member(&pool, &claims, project_id, target_user_id).await?;

    let res = sqlx::query("UPDATE users SET is_active = $1 WHERE id = $2")
        .bind(req.is_active)
        .bind(target_user_id)
        .execute(&pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("用户 {} 不存在", target_user_id)));
    }

    if !req.is_active {
        let _ = permissions::revoke_user_sessions(
            &pool,
            target_user_id,
            "user_deactivated_by_project_admin",
        )
        .await;
    }

    Ok(Json(json!({
        "ok": true,
        "user_id": target_user_id,
        "is_active": req.is_active,
    })))
}
```

Register:

```rust
.route(
    "/api/projects/:id/members/:user_id/status",
    axum::routing::patch(tenant_handlers::update_project_member_status),
)
```

- [ ] **Step 2: Login rejects inactive users**

In `UserRow` add `is_active: bool`.

Login SELECT:

```sql
SELECT id, username, email, password_hash, role,
       COALESCE(is_superadmin, false) AS is_superadmin,
       COALESCE(must_change_password, false) AS must_change_password,
       COALESCE(is_active, true) AS is_active,
       created_at
FROM users
WHERE email = $1
```

After fetching user, **before** password verify (or immediately after, before issuing token):

```rust
if !user.is_active {
    return Err(AppError::Forbidden("账号已停用，请联系管理员".to_string()));
}
```

Prefer checking after password verify to avoid user-enumeration timing differences — **match existing email-not-found behavior**: still return generic `"邮箱或密码错误"` if you want parity, OR return explicit 403 as spec says「账号已停用」。**Use explicit Forbidden per spec.**

- [ ] **Step 3: Middleware rejects inactive sessions**

Extend session query in `auth_middleware`:

```sql
SELECT s.revoked, s.expires_at,
       COALESCE(u.must_change_password, false) AS must_change_password,
       COALESCE(u.is_active, true) AS is_active
FROM user_sessions s
JOIN users u ON u.id = s.user_id
WHERE s.jti = $1::uuid
```

After revoked/expiry checks:

```rust
let is_active: bool = row.try_get("is_active").unwrap_or(true);
if !is_active {
    return Err(AppError::Forbidden("账号已停用，请联系管理员".to_string()));
}
```

- [ ] **Step 4: Verify**

```bash
# deactivate
curl -sS -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"is_active":false}' \
  "$API_BASE/api/projects/$PID/members/$UID/status"
# login as that user → 403 账号已停用
# reactivate → login works
```

- [ ] **Step 5: Commit**

```bash
git add src/tenant_handlers.rs src/main.rs src/auth_handlers.rs src/middleware.rs
git commit -m "$(cat <<'EOF'
feat(members): project admin can deactivate users; block login/session

EOF
)"
```

---

### Task 5: Frontend API client

**Files:**
- Modify: `frontend-nextjs/lib/api.ts`

**Interfaces:**
- Produces:
  - `ProjectMember.is_active: boolean`
  - `projectMembersAPI.updateProfile(projectId, userId, { username?, email? })`
  - `projectMembersAPI.resetPassword(projectId, userId, newPassword)`
  - `projectMembersAPI.updateStatus(projectId, userId, isActive)`

- [ ] **Step 1: Update types and methods**

```ts
export interface ProjectMember {
  user_id: number
  username: string
  email: string
  is_superadmin: boolean
  is_active: boolean
  role: 'owner' | 'admin' | 'member' | 'viewer'
  created_at: string
}

// inside projectMembersAPI:
  updateProfile: (
    projectId: number,
    userId: number,
    body: { username?: string; email?: string },
  ) =>
    api.patch<{ ok: boolean; user_id: number; username: string; email: string }>(
      `/api/projects/${projectId}/members/${userId}/profile`,
      body,
    ),

  resetPassword: (projectId: number, userId: number, newPassword: string) =>
    api.post<{ ok: boolean; message: string }>(
      `/api/projects/${projectId}/members/${userId}/reset-password`,
      { new_password: newPassword },
    ),

  updateStatus: (projectId: number, userId: number, isActive: boolean) =>
    api.patch<{ ok: boolean; user_id: number; is_active: boolean }>(
      `/api/projects/${projectId}/members/${userId}/status`,
      { is_active: isActive },
    ),
```

- [ ] **Step 2: Commit**

```bash
git add frontend-nextjs/lib/api.ts
git commit -m "$(cat <<'EOF'
feat(frontend): projectMembersAPI for profile/password/status

EOF
)"
```

---

### Task 6: Members page management drawer

**Files:**
- Modify: `frontend-nextjs/app/workspace/[projectId]/settings/members/page.tsx`
- Reference: `frontend-nextjs/app/platform/users/page.tsx` (reset password form + `isStrongPassword`)

**Interfaces:**
- Consumes: `projectMembersAPI.updateProfile|resetPassword|updateStatus`

- [ ] **Step 1: Extend local member type / state**

Add:

```ts
const [manageTarget, setManageTarget] = useState<ProjectMember | null>(null)
const [profileForm, setProfileForm] = useState({ username: '', email: '' })
const [pwdForm, setPwdForm] = useState({ p1: '', p2: '' })
const [savingProfile, setSavingProfile] = useState(false)
const [resettingPwd, setResettingPwd] = useState(false)
const [togglingActive, setTogglingActive] = useState(false)

const isStrongPassword = (p: string) =>
  p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p)
```

When opening drawer:

```ts
const openManage = (m: ProjectMember) => {
  setManageTarget(m)
  setProfileForm({ username: m.username, email: m.email })
  setPwdForm({ p1: '', p2: '' })
}
```

- [ ] **Step 2: Table UX**

- Row class: `!m.is_active && 'opacity-60'`
- Badge next to username when `!m.is_active`: `<span className="text-xs text-gray-600 bg-gray-100 ...">已停用</span>`
- In operations column (when `!isSelf`): button **管理** calling `openManage(m)` before 移除

Increase `colSpan` if empty-state uses it (still 4 columns).

- [ ] **Step 3: Drawer UI**

Reuse `Drawer` already imported on page (or import if missing). Sections:

1. 资料 — inputs + 保存 → `updateProfile` → `loadMembers()` + update `manageTarget`
2. 密码 — p1/p2 + 重置 → validate strong + match → `resetPassword` → toast
3. 状态 — button 停用/启用 with `window.confirm` copy:

```
确认停用用户 "email" 吗？

此操作全局生效：该用户将无法登录任何项目，所有会话立即失效。
```

Call `updateStatus(projectId, userId, next)`.

4. Hint text under title: `修改资料 / 密码 / 启停会影响该用户在所有项目中的账号。`

Do **not** add is_superadmin toggle.

- [ ] **Step 4: Manual UI check**

As project admin: open 管理 → rename → reset password → deactivate → confirm badge + login fails → reactivate.

- [ ] **Step 5: Commit**

```bash
git add frontend-nextjs/app/workspace/[projectId]/settings/members/page.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): member management drawer for password and account admin

EOF
)"
```

---

### Task 7: E2E shell tests

**Files:**
- Create: `tests/m1_workspace_member_admin_test.sh`
- Optional: extend `tests/m1_workspace_members_test.sh` with a short pointer comment

**Interfaces:**
- Consumes: all three new APIs + login

- [ ] **Step 1: Write script** (mirror header/login helpers from `m1_workspace_members_test.sh`)

Cover at minimum:

1. Non-admin / no token → 401/403 on profile  
2. Admin cannot PATCH own profile → 403  
3. Admin can PATCH another member username (then restore)  
4. Weak password → 400；strong password → 200；old token 401  
5. Deactivate → login Forbidden；reactivate → login OK  
6. List includes `is_active`

Use a disposable user created via `POST .../members/create-user` so tests do not brick shared accounts. At end: reactivate + optional remove.

- [ ] **Step 2: Run**

```bash
chmod +x tests/m1_workspace_member_admin_test.sh
API_BASE=http://127.0.0.1:3010 ./tests/m1_workspace_member_admin_test.sh
```

Expected: all PASS (or documented SKIP)

- [ ] **Step 3: Commit**

```bash
git add tests/m1_workspace_member_admin_test.sh
git commit -m "$(cat <<'EOF'
test(members): e2e for project-scoped member user admin APIs

EOF
)"
```

---

## Spec Coverage Checklist

| Spec requirement | Task |
|------------------|------|
| `users.is_active` migration | 1 |
| List returns `is_active` | 1 |
| PATCH profile | 2 |
| POST reset-password + session revoke | 3 |
| PATCH status + session revoke on deactivate | 4 |
| Login blocks inactive | 4 |
| Middleware blocks inactive | 4 |
| Authz: tenant admin + member + not self | 2 (helper used by 3–4) |
| Can manage project superadmin members | covered by helper (no extra deny) |
| No is_superadmin mutation | 2–6 (omitted) |
| Frontend drawer + badges | 6 |
| API client | 5 |
| E2E tests | 7 |
| No `must_change_password` on reset | 3 (omitted intentionally) |

## Self-Review Notes

- Validators: prefer moving to `auth.rs` so lib/bin both can use them without coupling to `admin_handlers`.
- Routes for `/profile` `/reset-password` `/status` must not be swallowed by `PATCH/DELETE .../:user_id` — register as distinct routes.
- Disposable test user required so deactivate/reset does not lock `test@example.com`.
