# License 功能限制强制执行指南

## 概述

OneBase License 支持多维度功能限制，确保客户只能使用已购买的功能。

## 限制维度

| 字段 | 说明 | 示例 |
|------|------|------|
| `edition` | 版本等级 | trial < standard < enterprise |
| `modules` | 功能模块 | ai, ha, multitenant, audit, pipeline |
| `max_nodes` | 集群节点上限 | 1（单节点）, 3（3节点集群）, None（不限） |
| `max_tenants` | 租户数上限 | 5（5个租户）, None（不限） |
| `max_accounts_per_tenant` | 单租户账号上限 | 3（最多3账号）, 10, None（不限） |
| `expires_at` | 到期时间 | 2027-09-01（自动校验） |
| `fingerprint` | 硬件绑定 | a1b2c3d4（防止复制） |

---

## 一、在 Handler 中使用 License 限制

### 方式 1: 使用 Extractor（推荐）

```rust
use crate::license_enforcement::{LicenseContext, require_module, require_edition};

// Handler 签名中直接获取 License
pub async fn create_workflow(
    State(pool): State<PgPool>,
    Extension(claims): Extension<Claims>,
    license: LicenseContext,  // 👈 自动注入 License 上下文
    Json(req): Json<CreateWorkflowRequest>,
) -> Result<impl IntoResponse> {
    // 1. 检查版本要求（工作流需要 standard 或以上）
    require_edition(&license, "standard")?;

    // 2. 检查模块授权（AI 工作流需要 ai 模块）
    if req.use_ai {
        require_module(&license, "ai")?;
    }

    // 3. 执行业务逻辑
    let workflow = create_workflow_internal(&pool, &req).await?;

    Ok(Json(workflow))
}
```

### 方式 2: 从请求扩展获取

```rust
pub async fn some_handler(
    mut req: Request,
    next: Next,
) -> Result<Response> {
    // 从扩展中获取 License
    let license = req.extensions()
        .get::<LicenseContext>()
        .ok_or_else(|| AppError::Internal("License 未加载"))?;

    // 检查模块
    if !license.has_module("ha") {
        return Err(AppError::Forbidden("此功能需要高可用（HA）模块"));
    }

    Ok(next.run(req).await)
}
```

---

## 二、功能限制示例

### 1. AI 模块限制

```rust
// ❌ 错误示例（未检查）
pub async fn generate_with_ai(prompt: String) -> Result<String> {
    call_openai_api(&prompt).await  // 直接调用，License 未授权也能用
}

// ✅ 正确示例
pub async fn generate_with_ai(
    license: LicenseContext,
    prompt: String,
) -> Result<String> {
    // 检查是否授权 AI 模块
    require_module(&license, "ai")?;

    call_openai_api(&prompt).await
}
```

### 2. 高可用（HA）模块限制

```rust
// 创建副本时检查 HA 模块
pub async fn create_read_replica(
    State(pool): State<PgPool>,
    license: LicenseContext,
    Json(req): Json<CreateReplicaRequest>,
) -> Result<impl IntoResponse> {
    // HA 功能需要 ha 模块
    require_module(&license, "ha")?;

    // 创建副本
    let replica = sqlx::query!(
        "INSERT INTO read_replicas (host, port) VALUES ($1, $2) RETURNING id",
        req.host, req.port
    )
    .fetch_one(&pool)
    .await?;

    Ok(Json(replica))
}
```

### 3. 多租户模块限制

```rust
// 创建租户时检查模块和数量限制
pub async fn create_tenant(
    State(pool): State<PgPool>,
    license: LicenseContext,
    Json(req): Json<CreateTenantRequest>,
) -> Result<impl IntoResponse> {
    // 1. 检查多租户模块
    require_module(&license, "multitenant")?;

    // 2. 检查租户数量限制
    check_tenant_limit(&license, &pool).await?;

    // 3. 创建租户
    let tenant = sqlx::query_as!(
        Tenant,
        "INSERT INTO management.tenants (name, slug) VALUES ($1, $2) RETURNING *",
        req.name, req.slug
    )
    .fetch_one(&pool)
    .await?;

    Ok(Json(tenant))
}
```

### 4. 版本等级限制

```rust
// 高级功能需要 enterprise 版本
pub async fn configure_sso(
    license: LicenseContext,
    Json(req): Json<SsoConfig>,
) -> Result<impl IntoResponse> {
    // SSO 只在 enterprise 版本可用
    require_edition(&license, "enterprise")?;

    // 配置 SSO
    save_sso_config(&req).await?;

    Ok(Json(json!({"message": "SSO 配置成功"})))
}
```

### 5. 节点数量限制

```rust
// 添加集群节点时检查限制
pub async fn add_cluster_node(
    State(pool): State<PgPool>,
    license: LicenseContext,
    Json(req): Json<AddNodeRequest>,
) -> Result<impl IntoResponse> {
    // 检查节点数量限制
    check_node_limit(&license, &pool).await?;

    // 添加节点
    let node = sqlx::query!(
        "INSERT INTO management.cluster_nodes (host, port) VALUES ($1, $2) RETURNING id",
        req.host, req.port
    )
    .fetch_one(&pool)
    .await?;

    Ok(Json(node))
}
```

### 6. 租户账号数量限制

```rust
// 添加成员到租户时检查账号限制
pub async fn add_project_member(
    State(pool): State<PgPool>,
    license: LicenseContext,
    Extension(claims): Extension<Claims>,
    Path(project_id): Path<i32>,
    Json(req): Json<AddProjectMemberRequest>,
) -> Result<impl IntoResponse> {
    // 检查账号数量限制
    check_account_limit(&license, &pool, project_id).await?;

    // 添加用户到租户
    sqlx::query!(
        r#"
        INSERT INTO management.user_tenants (user_id, tenant_id, role, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (user_id, tenant_id)
        DO UPDATE SET role = $3, is_active = true
        "#,
        req.user_id, project_id, req.role
    )
    .execute(&pool)
    .await?;

    Ok(Json(json!({"message": "成员添加成功"})))
}
```

---

## 三、中间件挂载

在 `main.rs` 中挂载 `license_middleware`：

```rust
mod license_enforcement;

use crate::license_enforcement::license_middleware;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ...

    // 业务路由（需要 License 校验）
    let protected_routes = Router::new()
        .route("/api/workflows", post(create_workflow))
        .route("/api/tenants", post(create_tenant))
        .route("/api/replicas", post(create_read_replica))
        // 👇 License 中间件（在 auth 之后）
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            license_middleware,
        ))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            middleware::auth_middleware,
        ));

    // ...
}
```

**中间件顺序**（从内到外）:
```
Handler
  ↓
license_middleware  // 注入 LicenseContext
  ↓
auth_middleware     // 注入 Claims
  ↓
Request
```

---

## 四、前端提示集成

### 1. 获取 License 信息

```typescript
// 前端 API
export const licenseAPI = {
  getInfo: () => api.get<{
    edition: string
    modules: string[]
    max_nodes: number | null
    max_tenants: number | null
    expires_at: string
    status: 'active' | 'grace' | 'expired'
  }>('/api/license/info'),
}
```

### 2. 条件渲染功能

```tsx
// React 组件
function WorkflowPage() {
  const { data: license } = useQuery('license', licenseAPI.getInfo)

  // AI 功能按钮
  const canUseAI = license?.modules.includes('ai')

  return (
    <div>
      <button disabled={!canUseAI}>
        生成 AI 工作流
      </button>
      {!canUseAI && (
        <p className="text-red-500">
          此功能需要 AI 模块，请升级 License
        </p>
      )}
    </div>
  )
}
```

### 3. 版本升级提示

```tsx
// 版本限制提示
function SsoSettings() {
  const { data: license } = useQuery('license', licenseAPI.getInfo)

  if (license?.edition !== 'enterprise') {
    return (
      <div className="bg-yellow-50 border border-yellow-200 p-4 rounded">
        <h3 className="font-semibold text-yellow-800">需要 Enterprise 版本</h3>
        <p className="text-yellow-700 mt-2">
          SSO 单点登录功能仅在 Enterprise 版本可用
        </p>
        <button className="mt-3 px-4 py-2 bg-blue-600 text-white rounded">
          联系销售升级
        </button>
      </div>
    )
  }

  return <SsoConfigForm />
}
```

---

## 五、License 信息 API

在 `src/license_handlers.rs` 中添加：

```rust
/// 获取当前 License 信息（脱敏）
pub async fn get_license_info(
    license: LicenseContext,
) -> Result<impl IntoResponse> {
    Ok(Json(json!({
        "edition": license.claims.edition,
        "modules": license.claims.modules,
        "max_nodes": license.claims.max_nodes,
        "max_tenants": license.claims.max_tenants,
        "expires_at": chrono::DateTime::from_timestamp(license.claims.expires_at, 0)
            .unwrap_or_default()
            .to_rfc3339(),
        "status": license.status.as_str(),
        "customer": license.claims.customer,
    })))
}
```

路由：
```rust
let license_routes = Router::new()
    .route("/api/license/info", get(get_license_info))
    .layer(axum_middleware::from_fn_with_state(
        pool.clone(),
        license_middleware,
    ));
```

---

## 六、版本对照表

| 功能 | Trial | Standard | Enterprise |
|------|-------|----------|------------|
| 基础 CRUD | ✅ | ✅ | ✅ |
| 工作流自动化 | ❌ | ✅ | ✅ |
| AI 能力（需 ai 模块） | ❌ | ✅ | ✅ |
| 高可用（需 ha 模块） | ❌ | ❌ | ✅ |
| 多租户（需 multitenant 模块） | ❌ | ✅ | ✅ |
| SSO 单点登录 | ❌ | ❌ | ✅ |
| 审计日志（需 audit 模块） | ❌ | ❌ | ✅ |
| CI/CD 流水线（需 pipeline 模块） | ❌ | ✅ | ✅ |
| 最大租户数 | 1 | 5 | 不限 |
| 每租户最大账号数 | 3 | 10 | 不限 |
| 最大节点数 | 1 | 1 | 不限 |

---

## 七、错误提示示例

### 用户视角

**场景 1: 尝试使用未授权模块**
```
❌ 错误：当前 License 未授权「AI」模块，请升级 License
```

**场景 2: 达到租户数量上限**
```
❌ 错误：已达到租户数量上限（5），请升级 License 或删除未使用的租户
```

**场景 3: 版本等级不足**
```
❌ 错误：此功能需要「Enterprise」版本或更高版本，当前为「Standard」
```

**场景 4: License 已过期**
```
⚠️ 警告：授权已到期，处于宽限期（剩余约 15 天），请尽快续期
系统已进入只读降级模式，无法执行写操作
```

---

## 八、常见问题

### Q1: 如何临时解除限制（测试环境）？

设置环境变量：
```bash
export ONEBASE_LICENSE_ENFORCE=off
```

### Q2: 如何查看当前 License 信息？

```bash
curl http://localhost:3010/api/license/info \
  -H "Authorization: Bearer $TOKEN"
```

### Q3: 如何动态调整限制（不重新签发）？

**不支持**。License 是签名文件，任何修改都会导致签名失败。
需要重新签发新 License 替换旧文件。

### Q4: 如何实现软限制（警告但不拦截）？

修改检查函数：
```rust
pub fn warn_module(ctx: &LicenseContext, module: &str) -> Result<()> {
    if !ctx.has_module(module) {
        tracing::warn!("使用了未授权模块: {}", module);
        // 不返回错误，仅记录日志
    }
    Ok(())
}
```

---

**版本**: v1.0
**更新日期**: 2026-09-01
**状态**: ✅ 已实现
