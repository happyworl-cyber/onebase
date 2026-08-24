# Account Settings Password Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已登录用户可从主要控制台进入 `/account`，查看只读账号信息并自愿修改密码。

**Architecture:** 独立页 `/account`（不套项目/平台/组织 layout），改密复用 `POST /auth/change-password`。强制改密仍走 `/change-password`。后端对新密码补齐 `validate_password`；旧密码错误改为 400，避免前端 401 拦截器把用户踢去登录页。

**Tech Stack:** Rust/Axum、Next.js App Router、现有 `authAPI` / Zustand `currentUser`。

**Spec:** `docs/superpowers/specs/2026-08-17-account-settings-password-design.md`

## Global Constraints

- 不改 `/change-password` 的拦截文案、不能返回、成功后跳转
- 不提供用户名/邮箱编辑、会话列表、忘记密码
- 不在 `/orgs`、`/workspace/no-projects` 加入口
- 新密码规则与注册一致：≥8 位，含大写、小写、数字
- 旧密码错误文案仍为「旧密码错误」，HTTP 改为 400（`InvalidQuery`），不要 401
- 除非用户明确要求，否则不 git commit（跳过各 Task 的 Commit 步）

## File map

| File | Responsibility |
|------|----------------|
| `src/auth.rs` | `validate_password` 单元测试 |
| `src/auth_handlers.rs` | 改密调用 `validate_password`；旧密码错误改 `InvalidQuery` |
| `frontend-nextjs/lib/api.ts` | `changePassword` 带类型 + `suppressErrorToast` |
| `frontend-nextjs/middleware.ts` | 把 `/account` 纳入未登录拦截 |
| `frontend-nextjs/app/account/page.tsx` | 账号设置页 |
| `frontend-nextjs/components/workspace/ProjectTopbar.tsx` | 工作区菜单入口 |
| `frontend-nextjs/components/PlatformSidebar.tsx` | 平台菜单入口 |
| `frontend-nextjs/components/OrgSidebar.tsx` | 租户菜单入口 |
| `frontend-nextjs/components/SidebarV3.tsx` | dashboard「个人资料」改为「账号设置」 |
| spec | 标已实现 |

---

### Task 1: 后端改密校验

**Files:**
- Modify: `src/auth.rs`（`#[cfg(test)] mod tests`，约 193 行起）
- Modify: `src/auth_handlers.rs`（`use crate::auth::...` 约第 11 行；`change_password` 约 406–438 行）

**Interfaces:**
- Consumes: 已有 `pub fn validate_password(p: &str) -> Result<(), AppError>`（`src/auth.rs`）
- Produces: `change_password` 在验证旧密码通过且新旧不同之后、哈希之前调用 `validate_password(&req.new_password)?`；旧密码错误返回 `AppError::InvalidQuery("旧密码错误".to_string())`

- [ ] **Step 1: 写 `validate_password` 单元测试**

在 `src/auth.rs` 的 `mod tests` 末尾（`test_validate_email_rejects_more_than_255_bytes` 之后）追加：

```rust
    #[test]
    fn test_validate_password_accepts_strong() {
        assert!(validate_password("Password123").is_ok());
    }

    #[test]
    fn test_validate_password_rejects_too_short() {
        let err = validate_password("Ab1").unwrap_err();
        match err {
            AppError::InvalidQuery(msg) => assert_eq!(msg, "密码至少需要 8 位"),
            other => panic!("expected InvalidQuery, got {other:?}"),
        }
    }

    #[test]
    fn test_validate_password_rejects_missing_classes() {
        assert!(validate_password("password123").is_err()); // 无大写
        assert!(validate_password("PASSWORD123").is_err()); // 无小写
        assert!(validate_password("Password").is_err()); // 无数字
    }
```

`AppError` 已由 `use super::*;` 引入（`auth.rs` 里已 `use crate::error::AppError`）。若测试模块编译报 `AppError` 未导入，在 `mod tests` 内加 `use crate::error::AppError;`。

- [ ] **Step 2: 跑测试（函数已存在，预期通过）**

Run: `cargo test -p onebase --lib auth::tests::test_validate_password -- --nocapture`

Expected: 3 passed。这是给已有函数补文档化测试，不是先红后绿。

- [ ] **Step 3: 改 `change_password`**

`src/auth_handlers.rs` 第 11 行 `use` 加上 `validate_password`：

```rust
use crate::auth::{
    generate_token, hash_password, jwt_expiration_secs, validate_password, verify_password, Claims,
};
```

把旧密码错误从 `Unauthorized` 改为 `InvalidQuery`（文案不变）。在「新旧不能相同」判断之后、「哈希新密码」之前插入 `validate_password`：

```rust
    if !password_valid {
        tracing::warn!(
            target: "auth",
            user_id,
            "修改密码失败：旧密码错误"
        );
        return Err(AppError::InvalidQuery("旧密码错误".to_string()));
    }

    // 新密码不能与旧密码相同——否则内置默认密码“只能用一次”的约束形同虚设。
    if req.new_password == req.old_password {
        return Err(AppError::InvalidQuery("新密码不能与旧密码相同".to_string()));
    }

    validate_password(&req.new_password)?;

    // 哈希新密码
    let new_password_hash = hash_password(&req.new_password)?;
```

不要改 `ChangePasswordRequest` 上 `#[validate(length(min = 8))]`（可保留作第一道长度门；强度由 `validate_password` 负责）。

- [ ] **Step 4: 再跑认证相关测试**

Run: `cargo test -p onebase --lib auth::tests -- --nocapture`

Expected: PASS。

- [ ] **Step 5: Commit（用户未要求则跳过）**

```bash
git add src/auth.rs src/auth_handlers.rs
git commit -m "fix: validate new password strength on change-password"
```

---

### Task 2: `/account` 页 + 中间件 + API 封装

**Files:**
- Modify: `frontend-nextjs/lib/api.ts`（`authAPI.changePassword` 约 242–243 行；文件顶部已有 `ApiRequestConfig`）
- Modify: `frontend-nextjs/middleware.ts`（`PROTECTED_PREFIXES` 约第 18 行；`config.matcher` 约 97–105 行）
- Create: `frontend-nextjs/app/account/page.tsx`

**Interfaces:**
- Consumes: `POST /auth/change-password` → `{ message: string, other_sessions_revoked: number }`
- Produces:

```ts
changePassword: (old_password: string, new_password: string) =>
  api.post<{ message: string; other_sessions_revoked: number }>(
    '/auth/change-password',
    { old_password, new_password },
    { suppressErrorToast: true } as ApiRequestConfig,
  )
```

- [ ] **Step 1: 更新 `authAPI.changePassword`**

把 `frontend-nextjs/lib/api.ts` 里现有两行换成上面的签名。`suppressErrorToast: true` 让错误只显示在表单内，不弹全局 toast。`/change-password` 页继续调用同一方法，行为可接受（它自己已经 `setError`）。

- [ ] **Step 2: 保护 `/account`**

`frontend-nextjs/middleware.ts`：

```ts
const PROTECTED_PREFIXES = ['/dashboard', '/platform', '/workspace', '/account'] as const
```

`config.matcher` 数组追加 `'/'` 不能乱加。只加：

```ts
    '/account',
    '/account/:path*',
```

放在现有 `'/workspace/:path*'` 附近即可。未登录访问 `/account` 会被 302 到 `/login?next=/account`。

- [ ] **Step 3: 新建账号设置页**

创建 `frontend-nextjs/app/account/page.tsx`，完整内容：

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { authAPI } from '@/lib/api'
import { getAuthToken } from '@/lib/auth'

function isStrongPassword(p: string): boolean {
  return p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p)
}

function validateForm(oldPassword: string, newPassword: string, confirmPassword: string): string | null {
  if (!oldPassword) return '请输入当前密码'
  if (newPassword.length < 8) return '密码至少需要 8 位'
  if (!isStrongPassword(newPassword)) return '密码必须包含大写字母、小写字母和数字'
  if (newPassword === oldPassword) return '新密码不能与当前密码相同'
  if (newPassword !== confirmPassword) return '两次输入的新密码不一致'
  return null
}

export default function AccountPage() {
  const router = useRouter()
  const currentUser = useAppStore((s) => s.currentUser)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    if (typeof window !== 'undefined' && !getAuthToken()) {
      router.replace('/login')
      return
    }
    if (currentUser?.must_change_password) {
      router.replace('/change-password')
    }
  }, [router, currentUser?.must_change_password])

  function goBack() {
    if (typeof document !== 'undefined') {
      try {
        const ref = document.referrer
        if (ref) {
          const url = new URL(ref)
          if (url.origin === window.location.origin) {
            router.back()
            return
          }
        }
      } catch {
        /* ignore */
      }
    }
    router.replace(currentUser?.is_superadmin ? '/platform' : '/orgs')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const v = validateForm(oldPassword, newPassword, confirmPassword)
    if (v) {
      setSuccess('')
      setError(v)
      return
    }
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      const res = await authAPI.changePassword(oldPassword, newPassword)
      const revoked = res.data?.other_sessions_revoked ?? 0
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSuccess(
        revoked > 0
          ? '密码修改成功，已让其它设备退出登录'
          : '密码修改成功',
      )
    } catch (err: any) {
      setError(err?.response?.data?.error || '修改密码失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  const inputClass =
    'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="h-14 bg-white border-b border-gray-200 flex items-center px-4 gap-3">
        <button
          type="button"
          onClick={goBack}
          className="text-sm text-gray-600 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-50"
        >
          <i className="fas fa-arrow-left mr-2" />
          返回
        </button>
        <h1 className="text-sm font-semibold text-gray-900">账号设置</h1>
      </header>

      <main className="max-w-xl mx-auto px-4 py-8 space-y-6">
        <section className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">账号信息</h2>
          <div>
            <div className="text-xs text-gray-500 mb-0.5">用户名</div>
            <div className="text-sm text-gray-800">{currentUser?.username || '—'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-0.5">邮箱</div>
            <div className="text-sm text-gray-800">{currentUser?.email || '—'}</div>
          </div>
        </section>

        <section className="bg-white border border-gray-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">修改密码</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">当前密码</label>
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                autoComplete="current-password"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">新密码</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                className={inputClass}
                placeholder="至少 8 位，含大小写字母和数字"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">确认新密码</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                className={inputClass}
              />
            </div>

            {error && (
              <div className="flex items-start space-x-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
                <i className="fas fa-exclamation-circle mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            {success && (
              <div className="flex items-start space-x-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded p-3">
                <i className="fas fa-check-circle mt-0.5" />
                <span>{success}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-500 disabled:opacity-50"
            >
              {loading ? '提交中...' : '修改密码'}
            </button>
          </form>
        </section>
      </main>
    </div>
  )
}
```

不要套 workspace/platform layout。不要改 `app/change-password/page.tsx`。

- [ ] **Step 4: 手工打开 `/account`**

- 未登录：应被 middleware 送到 `/login?next=/account`
- 已登录：浅底设置页，只读用户名/邮箱，改密表单。前端弱密码应拦在提交前。

- [ ] **Step 5: Commit（用户未要求则跳过）**

```bash
git add frontend-nextjs/lib/api.ts frontend-nextjs/middleware.ts frontend-nextjs/app/account/page.tsx
git commit -m "feat: add account settings page for self-service password change"
```

---

### Task 3: 用户菜单入口

**Files:**
- Modify: `frontend-nextjs/components/workspace/ProjectTopbar.tsx`（用户菜单，约 230–253 行；已 `import Link`）
- Modify: `frontend-nextjs/components/PlatformSidebar.tsx`（文件顶部 import；用户菜单约 152–163 行）
- Modify: `frontend-nextjs/components/OrgSidebar.tsx`（同上，约 177–189 行）
- Modify: `frontend-nextjs/components/SidebarV3.tsx`（约 341–346 行「个人资料」按钮）

**Interfaces:**
- Consumes: 路由 `/account`（Task 2）
- Produces: 四处菜单在「退出登录」上方（或替换原「个人资料」）出现「账号设置」

- [ ] **Step 1: `ProjectTopbar`**

在超管链接块之后、「退出登录」按钮之前插入：

```tsx
            <Link
              href="/account"
              onClick={() => setUserMenuOpen(false)}
              className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <i className="fas fa-user-cog mr-2"></i> 账号设置
            </Link>
```

所有登录用户都显示，不要包在 `is_superadmin` 条件里。

- [ ] **Step 2: `PlatformSidebar`**

文件顶部增加：`import Link from 'next/link'`

在用户菜单 `py-1` 内、退出登录按钮之前插入：

```tsx
              <Link
                href="/account"
                onClick={() => setShowUserMenu(false)}
                className="flex items-center space-x-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <i className="fas fa-user-cog text-xs w-4 text-gray-400"></i>
                <span>账号设置</span>
              </Link>
```

- [ ] **Step 3: `OrgSidebar`**

同样 `import Link from 'next/link'`，在退出登录之前插入与 Step 2 相同的 `Link`（`setShowUserMenu(false)`）。

- [ ] **Step 4: `SidebarV3`**

把无效的「个人资料」按钮改成跳转 `/account`，文案改为「账号设置」。`useRouter` 已存在。不要动下面的「设置」按钮（本期非目标）。

```tsx
                <button
                  type="button"
                  onClick={() => {
                    setShowUserMenu(false)
                    router.push('/account')
                  }}
                  className="w-full flex items-center space-x-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <i className="fas fa-user text-xs w-4 text-gray-400"></i>
                  <span>账号设置</span>
                </button>
```

- [ ] **Step 5: 手工点四个入口**

从项目工作区顶栏、平台侧栏、租户侧栏进入 `/account`；若本地会用到 `/dashboard`，再点一次 SidebarV3。返回：从控制台点进来应 `history.back()` 回去。

- [ ] **Step 6: Commit（用户未要求则跳过）**

```bash
git add frontend-nextjs/components/workspace/ProjectTopbar.tsx \
  frontend-nextjs/components/PlatformSidebar.tsx \
  frontend-nextjs/components/OrgSidebar.tsx \
  frontend-nextjs/components/SidebarV3.tsx
git commit -m "feat: add account settings entry to user menus"
```

---

### Task 4: 对照 spec 收口

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-account-settings-password-design.md`（状态行）

**Interfaces:**
- Consumes: Task 1–3 已落地的行为
- Produces: spec 状态改为「已实现」

- [ ] **Step 1: 手工核对清单**

- [ ] 工作区 / 平台 / 组织用户菜单有「账号设置」
- [ ] `/account` 只读用户名、邮箱；不可编辑
- [ ] 弱密码、两次不一致、与当前密码相同：前端拦截，不发请求
- [ ] 当前密码错误：表单显示「旧密码错误」，仍留在本页（不被踢去 `/login`）
- [ ] 成功：留在本页、表单清空、成功提示；若有其它会话则提示已退出
- [ ] `must_change_password` 用户进 `/account` 会被送到 `/change-password`
- [ ] `/change-password` 文案与不能返回的行为未改

- [ ] **Step 2: 再跑后端测试**

Run: `cargo test -p onebase --lib auth::tests -- --nocapture`

Expected: PASS。

- [ ] **Step 3: 标记 spec 已实现**

把 spec 头部：

```
**状态：** 已批准（待实现）
```

改成：

```
**状态：** 已实现
```

- [ ] **Step 4: Commit（用户未要求则跳过）**

```bash
git add docs/superpowers/specs/2026-08-17-account-settings-password-design.md
git commit -m "docs: mark account settings password design implemented"
```
