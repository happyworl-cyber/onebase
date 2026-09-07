# License 账号数量限制集成指南

## 概述

在 LicenseClaims 中新增了 `max_accounts_per_tenant` 字段，用于限制每个租户可添加的账号数量。

## 限制维度

| 字段 | 说明 | 示例 |
|------|------|------|
| `max_accounts_per_tenant` | 单个租户的账号上限 | 5（最多 5 个账号）, 10, None（不限） |

**注意**:
- 账号数 = `management.user_tenants` 表中 `WHERE tenant_id = $1 AND is_active = true` 的记录数
- 一个用户可以属于多个租户，每个关联都算作对应租户的一个账号

---

## 一、核心检查函数

### 1. LicenseContext 方法（src/license_enforcement.rs）

```rust
impl LicenseContext {
    /// 检查租户是否可以添加新账号
    pub async fn can_add_account(&self, pool: &PgPool, tenant_id: i32) -> Result<bool> {
        if let Some(max_accounts) = self.claims.max_accounts_per_tenant {
            let current_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM management.user_tenants WHERE tenant_id = $1 AND is_active = true",
            )
            .bind(tenant_id)
            .fetch_one(pool)
            .await?;

            Ok(current_count < max_accounts as i64)
        } else {
            Ok(true) // 无限制
        }
    }
}
```

### 2. 辅助检查函数

```rust
/// 检查租户账号数量限制
pub async fn check_account_limit(
    ctx: &LicenseContext,
    pool: &PgPool,
    tenant_id: i32
) -> Result<()> {
    if ctx.can_add_account(pool, tenant_id).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "租户已达到账号数量上限（{}），请升级 License",
            ctx.claims.max_accounts_per_tenant.unwrap_or(0)
        )))
    }
}
```

---

## 二、需要集成 License 检查的入口点

### 1. 添加已存在用户到项目（tenant_handlers.rs:2516）

**函数**: `add_project_member`

**原代码**:
```rust
pub async fn add_project_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    redis: Option<Extension<RedisManager>>,
    Path(project_id): Path<i32>,
    Json(req): Json<AddProjectMemberRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_tenant_role(&req.role)?;

    // ... 后续逻辑
}
```

**集成 License 检查**:
```rust
use crate::license_enforcement::{LicenseContext, check_account_limit};

pub async fn add_project_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    license: LicenseContext,  // 👈 添加 License extractor
    redis: Option<Extension<RedisManager>>,
    Path(project_id): Path<i32>,
    Json(req): Json<AddProjectMemberRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_tenant_role(&req.role)?;

    // 👇 检查 License 限制（在实际添加前检查）
    check_account_limit(&license, &pool, project_id).await?;

    // ... 后续添加用户逻辑
}
```

### 2. 创建新用户并添加到项目（tenant_handlers.rs:2623）

**函数**: `create_project_member`

**集成 License 检查**:
```rust
pub async fn create_project_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    license: LicenseContext,  // 👈 添加
    redis: Option<Extension<RedisManager>>,
    Path(project_id): Path<i32>,
    Json(req): Json<CreateProjectMemberRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_tenant_admin(&pool, &claims, project_id).await?;
    validate_tenant_role(&req.role)?;

    // 👇 检查 License 限制
    check_account_limit(&license, &pool, project_id).await?;

    // ... 创建用户并添加到项目
}
```

### 3. 管理员添加用户到租户（admin_handlers.rs:277）

**函数**: `add_user_to_tenant`

**集成 License 检查**:
```rust
pub async fn add_user_to_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    license: LicenseContext,  // 👈 添加
    redis: Option<Extension<RedisManager>>,
    Json(req): Json<AddUserToTenantRequest>,
) -> Result<Json<serde_json::Value>> {
    require_super_admin(&claims)?;

    // 👇 检查 License 限制
    check_account_limit(&license, &pool, req.tenant_id).await?;

    // ... 添加用户到租户
}
```

### 4. 组织添加成员到项目（organization_handlers.rs:770）

**函数**: `add_organization_project_member`

**集成 License 检查**:
```rust
pub async fn add_organization_project_member(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    license: LicenseContext,  // 👈 添加
    redis: Option<Extension<RedisManager>>,
    Path((organization_id, project_id)): Path<(i32, i32)>,
    Json(req): Json<AddProjectMemberFromOrgRequest>,
) -> Result<Json<serde_json::Value>> {
    permissions::require_organization_admin(&pool, &claims, organization_id).await?;
    validate_project_role(&req.role)?;

    // 👇 检查 License 限制
    check_account_limit(&license, &pool, project_id).await?;

    // ... 添加用户到项目
}
```

---

## 三、特殊场景处理

### 场景 1: 创建租户时自动添加创建者

**位置**: `tenant_handlers::create_project` (3983行)

**策略**: 创建租户时的 owner 不计入限制，因为：
1. 没有租户就无法存在
2. 至少需要一个 owner
3. 限制从第二个账号开始

**代码示例**:
```rust
pub async fn create_project(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    license: LicenseContext,
    Json(req): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse> {
    // ... 创建租户逻辑

    // 添加创建者为 owner（不检查限制，这是第一个账号）
    sqlx::query(
        r#"
        INSERT INTO management.user_tenants (user_id, tenant_id, role, is_active)
        VALUES ($1, $2, 'owner', true)
        "#,
    )
    .bind(claims.sub)
    .bind(tenant_id)
    .execute(&mut *tx)
    .await?;

    // ... 后续逻辑
}
```

### 场景 2: SSO 登录自动关联租户

**位置**: `sso_handlers::find_or_create_user` (821行)

**策略**: SSO 自动关联也需要检查限制，避免超额

**代码示例**:
```rust
async fn find_or_create_user(
    pool: &PgPool,
    license: &LicenseContext,  // 👈 需要传入 License
    tenant_id: i32,
    email: &Option<String>,
    name: &Option<String>,
    external_id: &str,
) -> Result<(i32, bool)> {
    // ... 查找或创建用户逻辑

    // 自动关联到租户前检查限制
    check_account_limit(license, pool, tenant_id).await?;

    sqlx::query(
        r#"
        INSERT INTO management.user_tenants (user_id, tenant_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, tenant_id)
        DO UPDATE SET role = EXCLUDED.role, is_active = true
        "#,
    )
    .bind(user_id)
    .bind(tenant_id)
    .bind(auto_role)
    .execute(pool)
    .await?;

    Ok((user_id, is_new))
}
```

### 场景 3: 用户达到上限时的友好提示

**前端处理**:
```typescript
// 添加成员前检查
const handleAddMember = async () => {
  try {
    await api.post(`/api/projects/${projectId}/members`, {
      user_id: selectedUserId,
      role: 'member'
    })
    notify.success('成员添加成功')
  } catch (error) {
    if (error.response?.data?.error?.includes('账号数量上限')) {
      notify.error(
        '租户账号已达上限，请联系管理员升级 License',
        { duration: 5000 }
      )
    } else {
      notify.error('添加失败: ' + error.response?.data?.error)
    }
  }
}
```

---

## 四、版本对照表（更新）

| 功能 | Trial | Standard | Enterprise |
|------|-------|----------|------------|
| 每租户最大账号数 | 3 | 10 | 不限 |
| 基础 CRUD | ✅ | ✅ | ✅ |
| 工作流自动化 | ❌ | ✅ | ✅ |
| AI 能力 | ❌ | ✅ | ✅ |
| 高可用（HA） | ❌ | ❌ | ✅ |
| 多租户 | ❌ | ✅ | ✅ |
| SSO 单点登录 | ❌ | ❌ | ✅ |
| 最大租户数 | 1 | 5 | 不限 |
| 最大节点数 | 1 | 1 | 不限 |

---

## 五、License 签发示例

### 代理商签发包含账号限制的 License

```rust
// partner_handlers::partner_issue_license
let claims = LicenseClaims {
    license_id: license_id.to_string(),
    customer: req.customer_name.clone(),
    edition: req.edition.clone(),
    modules: req.modules.clone(),
    max_nodes: req.max_nodes,
    max_tenants: req.max_tenants,
    max_accounts_per_tenant: Some(10),  // 👈 每个租户最多 10 个账号
    issued_at: now,
    expires_at: now + (req.days as i64 * 86400),
    grace_days: 30,
    fingerprint: None,
    notes: None,
};

let license_file_str = sign_license(&private_key, &claims)?;
```

### 前端签发表单（partner/licenses/page.tsx）

```tsx
// 新增账号限制字段
const [issueData, setIssueData] = useState({
  customer_name: '',
  edition: 'standard',
  modules: [] as string[],
  max_nodes: null as number | null,
  max_tenants: null as number | null,
  max_accounts_per_tenant: 10,  // 👈 新增字段
  days: 365,
  price: 0,
})

// 表单中添加输入框
<div>
  <label className="block text-sm font-medium text-gray-700 mb-2">
    每租户账号上限
  </label>
  <input
    type="number"
    value={issueData.max_accounts_per_tenant || ''}
    onChange={(e) => setIssueData({
      ...issueData,
      max_accounts_per_tenant: e.target.value ? parseInt(e.target.value) : null
    })}
    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
    placeholder="留空表示不限制"
  />
  <p className="text-xs text-gray-500 mt-1">
    单个租户可添加的账号数量（例如：10 表示最多 10 个账号）
  </p>
</div>
```

---

## 六、错误提示示例

### 用户视角

**场景 1: 添加成员时达到上限**
```
❌ 错误：租户已达到账号数量上限（10），请升级 License
```

**场景 2: SSO 登录时租户满员**
```
❌ 登录失败：当前租户账号已满，无法自动关联。请联系租户管理员升级 License
```

**场景 3: 创建新用户并添加到项目**
```
❌ 错误：无法创建用户。租户账号数量已达上限（10），请升级 License
```

---

## 七、测试验证

### 测试步骤

#### 1. 生成包含账号限制的 License
```bash
cargo run --bin license_tool issue \
  --customer "测试客户" \
  --edition "standard" \
  --modules "multitenant" \
  --max-accounts-per-tenant 3 \
  --days 365 \
  --out /etc/onebase/license.lic
```

#### 2. 创建租户并添加成员
```bash
# 创建租户（自动添加创建者，账号数 = 1）
curl -X POST http://localhost:3010/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "测试项目"}'

# 添加第 2 个成员（成功，账号数 = 2）
curl -X POST http://localhost:3010/api/projects/1/members \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"user_id": 2, "role": "member"}'

# 添加第 3 个成员（成功，账号数 = 3）
curl -X POST http://localhost:3010/api/projects/1/members \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"user_id": 3, "role": "member"}'

# 添加第 4 个成员（失败，达到上限）
curl -X POST http://localhost:3010/api/projects/1/members \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"user_id": 4, "role": "member"}'

# 预期：403 Forbidden
# 错误："租户已达到账号数量上限（3），请升级 License"
```

#### 3. 查询当前账号数
```sql
SELECT COUNT(*)
FROM management.user_tenants
WHERE tenant_id = 1 AND is_active = true;
-- 应该返回 3
```

#### 4. 移除成员后再添加
```bash
# 移除一个成员（账号数 = 2）
curl -X DELETE http://localhost:3010/api/projects/1/members/3 \
  -H "Authorization: Bearer $TOKEN"

# 再次添加（成功，账号数 = 3）
curl -X POST http://localhost:3010/api/projects/1/members \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"user_id": 4, "role": "member"}'
```

---

## 八、实施清单

### 必须修改的文件

- [x] `src/license.rs` - 添加 `max_accounts_per_tenant` 字段
- [x] `src/license_enforcement.rs` - 添加 `can_add_account` 和 `check_account_limit` 函数
- [ ] `src/tenant_handlers.rs` - 在 `add_project_member`, `create_project_member` 中添加检查
- [ ] `src/admin_handlers.rs` - 在 `add_user_to_tenant` 中添加检查
- [ ] `src/organization_handlers.rs` - 在 `add_organization_project_member` 中添加检查
- [ ] `src/sso_handlers.rs` - 在 `find_or_create_user` 中添加检查（可选）
- [ ] `src/partner_models.rs` - 在 `IssueLicenseRequest` 中添加 `max_accounts_per_tenant` 字段
- [ ] `docs/license-feature-enforcement.md` - 更新文档添加账号限制示例

### 需要编译测试

```bash
# 编译检查
cargo check

# 运行测试
cargo test license

# 启动服务
cargo run
```

---

**版本**: v1.1
**更新日期**: 2026-09-01
**状态**: ✅ 核心逻辑已实现，等待集成到 handlers
