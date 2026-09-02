# License 功能限制集成指南

## 核心问题

**如何在不修改 PlaneOS 核心代码的情况下，实现 License 对功能的限制？**

---

## 解决方案：中间件拦截 + Handler 检查

### 架构图

```
┌─────────────┐
│  前端请求    │
└──────┬──────┘
       │
       ▼
┌─────────────────────────┐
│  auth_middleware        │  ← 验证用户身份
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│  license_middleware     │  ← 加载并验证 License（NEW）
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│  业务 Handler           │  ← 检查功能权限（NEW）
│  (tenant_handlers.rs)   │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│  PlaneOS 核心逻辑      │  ← 不需要修改！
└─────────────────────────┘
```

---

## 实现步骤

### 步骤 1：中间件注入 License 上下文

**文件**：`src/license_enforcement.rs`（已创建）

```rust
/// License 中间件：加载并验证 License，注入到请求上下文
pub async fn license_middleware(
    State(pool): State<PgPool>,
    mut req: Request,
    next: Next,
) -> std::result::Result<Response, AppError> {
    // 加载 License（从数据库或环境变量）
    let license_ctx = load_and_verify_license(&pool).await?;

    // 注入到请求扩展
    req.extensions_mut().insert(license_ctx);

    Ok(next.run(req).await)
}
```

**挂载位置**：`src/main.rs`

```rust
let app = Router::new()
    .route("/api/tenants", post(tenant_handlers::create_tenant))
    .layer(license_middleware)  // ← 在这里挂载
    .layer(auth_middleware);
```

---

### 步骤 2：Handler 中检查功能权限

**文件**：`src/tenant_handlers.rs`（需要修改）

```rust
use crate::license_enforcement::LicenseContext;
use crate::license_features::require_feature;

/// 创建租户（需要检查 License）
pub async fn create_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Extension(license): Extension<LicenseContext>,  // ← 从中间件获取
    Json(req): Json<CreateTenantRequest>,
) -> Result<impl IntoResponse> {
    // 1. 检查功能权限
    require_feature("multitenant_create", &license)?;

    // 2. 检查租户数量限制
    check_tenant_limit(&license, &pool).await?;

    // 3. PlaneOS 原有逻辑（不修改）
    let tenant = create_tenant_logic(&pool, &req).await?;

    Ok(Json(tenant))
}
```

---

### 步骤 3：使用功能注册表

**文件**：`src/license_features.rs`（已创建）

```rust
/// 全局功能注册表
pub static FEATURE_REGISTRY: Lazy<FeatureRegistry> = Lazy::new(|| {
    let mut registry = FeatureRegistry::new();

    // 注册功能：创建租户
    registry.register(FeatureRequirement {
        feature: "multitenant_create".to_string(),
        display_name: "创建租户".to_string(),
        min_edition: Some("standard".to_string()),  // ← 需要 Standard 版本
        required_modules: vec!["multitenant".to_string()],  // ← 需要多租户模块
        description: "创建新的租户实例".to_string(),
    });

    registry
});

/// 便捷函数：检查功能
pub fn require_feature(feature: &str, license: &LicenseContext) -> Result<()> {
    FEATURE_REGISTRY.check_feature(feature, license)
}
```

---

## 具体集成示例

### 示例 1：限制创建租户功能

#### 1.1 在 `tenant_handlers.rs` 中添加检查

```rust
// 在文件顶部添加导入
use crate::license_enforcement::{LicenseContext, check_tenant_limit};
use crate::license_features::require_feature;

/// 创建租户
pub async fn create_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Extension(license): Extension<LicenseContext>,  // ← 新增参数
    Json(req): Json<CreateTenantRequest>,
) -> Result<impl IntoResponse> {
    // ===== 新增：License 检查 =====
    // 1. 检查是否有"创建租户"功能权限
    require_feature("multitenant_create", &license)?;

    // 2. 检查是否达到租户数量上限
    check_tenant_limit(&license, &pool).await?;
    // ===== License 检查结束 =====

    // 原有的 PlaneOS 创建租户逻辑（不修改）
    let tenant_id: i32 = sqlx::query_scalar(
        "INSERT INTO management.tenants (...) VALUES (...) RETURNING id"
    )
    .bind(&req.name)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({ "id": tenant_id })))
}
```

#### 1.2 错误响应

如果 License 不满足要求，会返回：

```json
{
  "error": "forbidden",
  "message": "「创建租户」功能需要 standard 版本或更高版本（当前为 trial）"
}
```

或

```json
{
  "error": "forbidden",
  "message": "已达到租户数量上限（10），请升级 License 或删除未使用的租户"
}
```

---

### 示例 2：限制添加账号数量

#### 2.1 在 `user_handlers.rs` 中添加检查

```rust
use crate::license_enforcement::{LicenseContext, check_account_limit};

/// 添加用户到租户
pub async fn add_user_to_tenant(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    Extension(license): Extension<LicenseContext>,  // ← 新增
    Path(tenant_id): Path<i32>,
    Json(req): Json<AddUserRequest>,
) -> Result<impl IntoResponse> {
    // ===== 新增：检查账号数量限制 =====
    check_account_limit(&license, &pool, tenant_id).await?;
    // ===== 检查结束 =====

    // 原有的添加用户逻辑（不修改）
    let user_tenant_id = sqlx::query_scalar(
        "INSERT INTO management.user_tenants (...) VALUES (...) RETURNING id"
    )
    .bind(tenant_id)
    .bind(req.user_id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(json!({ "id": user_tenant_id })))
}
```

---

### 示例 3：限制 AI 功能

#### 3.1 在 `ai_handlers.rs` 中添加检查

```rust
use crate::license_features::require_feature;

/// AI 内容生成
pub async fn ai_generate_content(
    State(pool): State<PgPool>,
    Extension(license): Extension<LicenseContext>,  // ← 新增
    Json(req): Json<AiGenerateRequest>,
) -> Result<impl IntoResponse> {
    // ===== 检查 AI 模块权限 =====
    require_feature("ai_generation", &license)?;
    // ===== 检查结束 =====

    // 原有的 AI 生成逻辑（不修改）
    let result = call_ai_api(&req.prompt).await?;

    Ok(Json(result))
}
```

---

## 关键优势

### ✅ 不修改 PlaneOS 核心代码

- License 检查在 **Handler 入口处**，核心业务逻辑不变
- PlaneOS 的数据库操作、业务规则完全保留
- 只需在每个需要限制的 Handler 函数签名中添加 `Extension(license): Extension<LicenseContext>`

### ✅ 集中管理功能权限

- 所有功能权限定义在 `src/license_features.rs`
- 一处修改，全局生效
- 易于审计和维护

### ✅ 灵活配置

- 可以通过环境变量 `LICENSE_ENFORCE_MODE` 控制：
  - `enforce`：严格执行（生产环境）
  - `warn`：仅警告不拦截（开发环境）

---

## 需要修改的文件列表

### 必须修改（添加 License 检查）

| 文件 | 修改内容 | 难度 |
|------|---------|------|
| `src/tenant_handlers.rs` | 在 `create_tenant` 中添加检查 | ⭐ |
| `src/user_handlers.rs` | 在 `add_user_to_tenant` 中添加检查 | ⭐ |
| `src/ai_handlers.rs` | 在 AI 相关 handler 中添加检查 | ⭐ |
| `src/workflow_handlers.rs` | 在工作流 handler 中添加检查 | ⭐ |
| `src/sso_handlers.rs` | 在 SSO handler 中添加检查 | ⭐ |

**修改模式**：
```rust
// 1. 添加导入
use crate::license_enforcement::LicenseContext;
use crate::license_features::require_feature;

// 2. 函数签名添加参数
pub async fn your_handler(
    Extension(license): Extension<LicenseContext>,  // ← 新增这一行
    // ...其他参数
) -> Result<impl IntoResponse> {

// 3. 函数开头添加检查
    require_feature("your_feature_name", &license)?;

// 4. 原有逻辑不变
    // ...
}
```

### 已创建（无需修改）

| 文件 | 说明 |
|------|------|
| `src/license_enforcement.rs` | License 中间件和检查函数 |
| `src/license_features.rs` | 功能注册表 |
| `src/partner_models.rs` | 数据模型（包含 max_accounts_per_tenant） |
| `src/partner_handlers.rs` | 代理商 API（License 签发） |

---

## 挂载中间件

### 在 `src/main.rs` 中添加

```rust
// 1. 导入中间件
use crate::license_enforcement::license_middleware;

// 2. 挂载到需要限制的路由
let app = Router::new()
    // 需要 License 限制的路由
    .route("/api/tenants", post(tenant_handlers::create_tenant))
    .route("/api/tenants/:id/users", post(user_handlers::add_user_to_tenant))
    .route("/api/ai/generate", post(ai_handlers::ai_generate_content))
    .route("/api/workflows", post(workflow_handlers::create_workflow))
    .route("/api/sso/config", post(sso_handlers::configure_sso))

    // 挂载 License 中间件
    .layer(license_middleware)  // ← 在这里挂载

    // 其他中间件
    .layer(auth_middleware);

// 不需要 License 限制的路由（如登录、公开 API）
let public_routes = Router::new()
    .route("/api/auth/login", post(auth_handlers::login))
    .route("/api/health", get(health_check));

// 合并
let app = app.merge(public_routes);
```

---

## 常见问题

### Q1：如果用户绕过 License 检查怎么办？

**A**：用户无法绕过，因为：
1. License 验证在 **服务器端**（中间件）
2. 签名验证使用 **RSA-2048**（几乎不可能伪造）
3. 公钥编译在二进制文件中（`include_str!`）

### Q2：如何测试 License 限制？

**A**：两种方式：

**方式 1：环境变量切换模式**
```bash
# 开发环境：仅警告
export LICENSE_ENFORCE_MODE=warn
cargo run

# 生产环境：严格执行
export LICENSE_ENFORCE_MODE=enforce
cargo run
```

**方式 2：使用测试 License**
```bash
# 生成测试 License
cargo run --bin license_tool issue \
  --customer "测试客户" \
  --edition trial \
  --modules "" \
  --max-tenants 1 \
  --days 90 \
  --out test_license.lic

# 设置环境变量
export ONEBASE_LICENSE_FILE=./test_license.lic
```

### Q3：PlaneOS 的其他功能会受影响吗？

**A**：**不会！** 只有以下场景需要 License：
1. 创建租户（`POST /api/tenants`）
2. 添加账号（`POST /api/tenants/:id/users`）
3. 启用 AI（`POST /api/ai/*`）
4. 配置 SSO（`POST /api/sso/*`）
5. 创建工作流（`POST /api/workflows`）

其他功能（查询、更新、删除等）**不受影响**。

---

## 总结

### 核心思想

```
┌────────────────────────────────────────────────┐
│  License 检查 = 中间件注入 + Handler 验证     │
└────────────────────────────────────────────────┘
                      │
        ┌─────────────┴─────────────┐
        │                           │
        ▼                           ▼
┌────────────────┐          ┌────────────────┐
│  中间件        │          │  Handler       │
│  license_      │          │  添加 3 行代码 │
│  middleware    │          │  - 导入        │
│  (已创建)      │          │  - 参数        │
│                │          │  - 检查        │
└────────────────┘          └────────────────┘
```

### 工作量评估

| 任务 | 难度 | 预计时间 |
|------|------|---------|
| 挂载 license_middleware | ⭐ | 5 分钟 |
| 修改 tenant_handlers.rs | ⭐ | 15 分钟 |
| 修改 user_handlers.rs | ⭐ | 15 分钟 |
| 修改 ai_handlers.rs | ⭐ | 15 分钟 |
| 修改 workflow_handlers.rs | ⭐ | 15 分钟 |
| 修改 sso_handlers.rs | ⭐ | 15 分钟 |
| **总计** | - | **1.5 小时** |

### 关键文件

已创建（无需修改）：
- ✅ `src/license_enforcement.rs`
- ✅ `src/license_features.rs`

需要修改（添加 3 行代码）：
- ⏳ `src/main.rs` - 挂载中间件
- ⏳ `src/tenant_handlers.rs` - 租户功能检查
- ⏳ `src/user_handlers.rs` - 账号限制检查
- ⏳ `src/ai_handlers.rs` - AI 功能检查
- ⏳ `src/workflow_handlers.rs` - 工作流检查
- ⏳ `src/sso_handlers.rs` - SSO 检查

---

**文档版本**：v1.0
**创建时间**：2026-09-02
**说明**：本文档详细解释了如何在不修改 PlaneOS 核心代码的情况下集成 License 功能限制
