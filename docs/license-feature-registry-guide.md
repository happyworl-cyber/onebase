# License 功能注册表使用指南

## 概述

功能注册表提供**集中式**的功能-License 映射管理，替代分散在各个 handler 中的手动检查。

## 核心优势

✅ **集中管理** - 所有功能权限在一个文件中定义
✅ **声明式配置** - 一眼看清功能需要哪些 License
✅ **易于维护** - 新增功能只需注册即可
✅ **统一错误提示** - 自动生成友好的错误消息
✅ **可审计** - 清晰的功能-权限映射关系

---

## 一、功能注册表结构

### FeatureRequirement - 功能权限定义

```rust
pub struct FeatureRequirement {
    /// 功能标识符（唯一）
    pub feature: String,

    /// 功能显示名称（给用户看的）
    pub display_name: String,

    /// 最低版本要求（trial/standard/enterprise）
    pub min_edition: Option<String>,

    /// 必需的模块列表
    pub required_modules: Vec<String>,

    /// 功能描述
    pub description: String,
}
```

### 注册表示例

```rust
// src/license_features.rs
fn register_builtin_features(&mut self) {
    // AI 内容生成功能
    self.register(FeatureRequirement {
        feature: "ai_generation".to_string(),
        display_name: "AI 内容生成".to_string(),
        min_edition: Some("standard".to_string()),  // 需要 standard 或更高
        required_modules: vec!["ai".to_string()],   // 需要 ai 模块
        description: "使用 AI 生成内容".to_string(),
    });

    // SSO 功能
    self.register(FeatureRequirement {
        feature: "sso_saml".to_string(),
        display_name: "SAML 单点登录".to_string(),
        min_edition: Some("enterprise".to_string()), // 只有 enterprise 可用
        required_modules: vec![],                     // 不需要额外模块
        description: "SAML 2.0 单点登录集成".to_string(),
    });

    // 高可用功能
    self.register(FeatureRequirement {
        feature: "ha_replica".to_string(),
        display_name: "数据库副本".to_string(),
        min_edition: Some("enterprise".to_string()),
        required_modules: vec!["ha".to_string()],    // 需要 ha 模块
        description: "创建和管理只读副本".to_string(),
    });
}
```

---

## 二、在 Handler 中使用

### 方式 1: 直接调用 require_feature（推荐）

```rust
use crate::license_enforcement::LicenseContext;
use crate::license_features::require_feature;

// ✅ 推荐：使用功能标识符检查
pub async fn generate_with_ai(
    license: LicenseContext,
    prompt: String,
) -> Result<String> {
    // 一行代码完成检查
    require_feature("ai_generation", &license)?;

    // 业务逻辑
    call_openai_api(&prompt).await
}

pub async fn configure_sso(
    license: LicenseContext,
    Json(req): Json<SsoConfig>,
) -> Result<impl IntoResponse> {
    // 检查 SSO 功能
    require_feature("sso_saml", &license)?;

    save_sso_config(&req).await?;
    Ok(Json(json!({"message": "SSO 配置成功"})))
}

pub async fn create_read_replica(
    license: LicenseContext,
    State(pool): State<PgPool>,
    Json(req): Json<CreateReplicaRequest>,
) -> Result<impl IntoResponse> {
    // 检查高可用功能
    require_feature("ha_replica", &license)?;

    let replica = create_replica_internal(&pool, &req).await?;
    Ok(Json(replica))
}
```

### 方式 2: 使用注册表实例

```rust
use crate::license_features::FEATURE_REGISTRY;

pub async fn some_handler(
    license: LicenseContext,
) -> Result<impl IntoResponse> {
    // 直接使用全局注册表
    FEATURE_REGISTRY.check_feature("custom_domain", &license)?;

    // 业务逻辑...
}
```

---

## 三、对比：旧方式 vs 新方式

### ❌ 旧方式（分散式，不推荐）

```rust
pub async fn generate_with_ai(
    license: LicenseContext,
    prompt: String,
) -> Result<String> {
    // 需要手动检查版本和模块
    require_edition(&license, "standard")?;
    require_module(&license, "ai")?;

    call_openai_api(&prompt).await
}

pub async fn configure_sso(
    license: LicenseContext,
    Json(req): Json<SsoConfig>,
) -> Result<impl IntoResponse> {
    // 需要记住 SSO 需要什么版本
    require_edition(&license, "enterprise")?;

    save_sso_config(&req).await?;
    Ok(Json(json!({"message": "SSO 配置成功"})))
}
```

**问题**：
- 需要记住每个功能的 License 要求
- 功能-License 映射分散在各个文件中
- 修改权限策略需要找到所有相关代码
- 容易遗漏或不一致

### ✅ 新方式（集中式，推荐）

```rust
pub async fn generate_with_ai(
    license: LicenseContext,
    prompt: String,
) -> Result<String> {
    // 功能标识符一目了然
    require_feature("ai_generation", &license)?;

    call_openai_api(&prompt).await
}

pub async fn configure_sso(
    license: LicenseContext,
    Json(req): Json<SsoConfig>,
) -> Result<impl IntoResponse> {
    // 功能标识符清晰表达意图
    require_feature("sso_saml", &license)?;

    save_sso_config(&req).await?;
    Ok(Json(json!({"message": "SSO 配置成功"})))
}
```

**优势**：
- ✅ 功能标识符语义清晰
- ✅ License 要求在注册表中统一管理
- ✅ 修改权限策略只需改注册表
- ✅ 自动生成友好的错误消息

---

## 四、查询功能列表

### 1. 获取所有可用功能

```rust
use crate::license_features::get_available_features;

pub async fn get_capabilities(
    license: LicenseContext,
) -> Result<Json<Vec<String>>> {
    // 返回当前 License 可用的所有功能
    let features = get_available_features(&license);
    Ok(Json(features))
}

// 响应示例（standard 版本 + ai 模块）:
// [
//   "basic_crud",
//   "workflow",
//   "ai_generation",
//   "ai_mcp",
//   "multitenant_create",
//   "pipeline_kafka"
// ]
```

### 2. 获取功能详情

```rust
use crate::license_features::FEATURE_REGISTRY;

pub async fn get_feature_info(
    Path(feature): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let info = FEATURE_REGISTRY.get_feature(&feature)
        .ok_or_else(|| AppError::NotFound("功能不存在".to_string()))?;

    Ok(Json(json!({
        "feature": info.feature,
        "display_name": info.display_name,
        "min_edition": info.min_edition,
        "required_modules": info.required_modules,
        "description": info.description,
    })))
}
```

### 3. 列出所有功能（不考虑 License）

```rust
pub async fn list_all_features() -> Result<Json<Vec<serde_json::Value>>> {
    let features: Vec<_> = FEATURE_REGISTRY
        .list_features()
        .iter()
        .map(|f| json!({
            "feature": f.feature,
            "display_name": f.display_name,
            "min_edition": f.min_edition,
            "required_modules": f.required_modules,
        }))
        .collect();

    Ok(Json(features))
}
```

---

## 五、前端集成

### 1. 获取可用功能列表

```typescript
// 前端 API
export const licenseAPI = {
  getCapabilities: () => api.get<{
    features: string[]
  }>('/api/license/capabilities'),

  getFeatureInfo: (feature: string) => api.get<{
    feature: string
    display_name: string
    min_edition: string | null
    required_modules: string[]
    description: string
  }>(`/api/features/${feature}`),
}
```

### 2. 条件渲染功能

```tsx
function FeatureGate({ feature, children }: { feature: string, children: React.ReactNode }) {
  const { data: capabilities } = useQuery('capabilities', licenseAPI.getCapabilities)

  // 检查功能是否可用
  const isAvailable = capabilities?.features.includes(feature)

  if (!isAvailable) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 p-4 rounded">
        <i className="fas fa-lock text-yellow-600 mr-2"></i>
        <span>此功能需要升级 License</span>
      </div>
    )
  }

  return <>{children}</>
}

// 使用
function WorkflowPage() {
  return (
    <FeatureGate feature="workflow">
      <WorkflowEditor />
    </FeatureGate>
  )
}

function AIGenerationButton() {
  return (
    <FeatureGate feature="ai_generation">
      <button>生成 AI 内容</button>
    </FeatureGate>
  )
}
```

### 3. 功能发现

```tsx
function FeatureShowcase() {
  const { data: allFeatures } = useQuery('all-features', () =>
    api.get('/api/features/all')
  )
  const { data: capabilities } = useQuery('capabilities', licenseAPI.getCapabilities)

  return (
    <div className="grid grid-cols-3 gap-4">
      {allFeatures?.map(feature => {
        const available = capabilities?.features.includes(feature.feature)

        return (
          <div key={feature.feature} className={`p-4 rounded border ${
            available ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'
          }`}>
            <h3 className="font-semibold">{feature.display_name}</h3>
            <p className="text-sm text-gray-600">{feature.description}</p>

            {!available && (
              <button className="mt-2 text-sm text-blue-600">
                升级 License 解锁
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

---

## 六、添加新功能

### 步骤 1: 在注册表中注册功能

```rust
// src/license_features.rs
fn register_builtin_features(&mut self) {
    // ... 其他功能

    // 新增功能
    self.register(FeatureRequirement {
        feature: "custom_webhook".to_string(),
        display_name: "自定义 Webhook".to_string(),
        min_edition: Some("standard".to_string()),
        required_modules: vec![],
        description: "配置自定义 Webhook 回调".to_string(),
    });
}
```

### 步骤 2: 在 Handler 中使用

```rust
pub async fn create_webhook(
    license: LicenseContext,
    Json(req): Json<CreateWebhookRequest>,
) -> Result<impl IntoResponse> {
    // 自动检查功能权限
    require_feature("custom_webhook", &license)?;

    // 创建 webhook
    let webhook = save_webhook(&req).await?;
    Ok(Json(webhook))
}
```

### 步骤 3: 前端使用

```tsx
<FeatureGate feature="custom_webhook">
  <WebhookConfigForm />
</FeatureGate>
```

**完成！** 无需在多个地方添加 License 检查代码。

---

## 七、功能矩阵（配置参考）

| 功能标识符 | 显示名称 | 最低版本 | 必需模块 | 说明 |
|-----------|---------|---------|---------|------|
| `basic_crud` | 基础 CRUD | - | - | 所有版本都支持 |
| `workflow` | 工作流自动化 | standard | - | 创建自动化流程 |
| `ai_generation` | AI 内容生成 | standard | ai | AI 生成功能 |
| `ai_mcp` | MCP 智能体 | standard | ai | MCP 协议集成 |
| `ha_replica` | 数据库副本 | enterprise | ha | 只读副本 |
| `ha_failover` | 自动故障转移 | enterprise | ha | 主备切换 |
| `multitenant_create` | 创建租户 | standard | multitenant | 多租户支持 |
| `sso_saml` | SAML 登录 | enterprise | - | SAML 2.0 |
| `sso_oidc` | OIDC 登录 | enterprise | - | OpenID Connect |
| `audit_log` | 审计日志 | enterprise | audit | 操作记录 |
| `audit_export` | 审计导出 | enterprise | audit | 导出合规报告 |
| `pipeline_kafka` | Kafka 管道 | standard | pipeline | Kafka 集成 |
| `custom_domain` | 自定义域名 | enterprise | - | 租户域名 |
| `white_label` | 白标定制 | enterprise | - | 品牌定制 |

---

## 八、错误提示

### 自动生成的友好错误

当 License 不满足要求时，系统自动生成清晰的错误消息：

```
❌ 「AI 内容生成」功能需要「ai」模块，请升级 License

❌ 「SAML 单点登录」功能需要 enterprise 版本或更高版本（当前为 standard）

❌ 「数据库副本」功能需要 enterprise 版本或更高版本（当前为 standard）
❌ 「数据库副本」功能需要「ha」模块，请升级 License
```

**优势**：
- 显示功能的中文名称（用户友好）
- 明确指出缺少什么（版本或模块）
- 统一格式，易于理解

---

## 九、迁移指南

### 从旧方式迁移到新方式

#### Before（旧代码）
```rust
pub async fn generate_with_ai(
    license: LicenseContext,
    prompt: String,
) -> Result<String> {
    require_edition(&license, "standard")?;
    require_module(&license, "ai")?;
    call_openai_api(&prompt).await
}
```

#### After（新代码）
```rust
pub async fn generate_with_ai(
    license: LicenseContext,
    prompt: String,
) -> Result<String> {
    require_feature("ai_generation", &license)?;
    call_openai_api(&prompt).await
}
```

#### 迁移步骤

1. **识别功能** - 确定 handler 对应的功能标识符
2. **查找注册表** - 在 `license_features.rs` 中查找功能定义
3. **如果不存在** - 先注册功能
4. **替换检查代码** - 用 `require_feature()` 替换原有检查
5. **删除旧代码** - 移除 `require_edition()` 和 `require_module()` 调用
6. **测试** - 验证权限检查正常工作

---

## 十、常见问题

### Q1: 如何定义需要多个模块的功能？

```rust
self.register(FeatureRequirement {
    feature: "advanced_analytics".to_string(),
    display_name: "高级分析".to_string(),
    min_edition: Some("enterprise".to_string()),
    required_modules: vec!["ai".to_string(), "pipeline".to_string()], // 需要多个模块
    description: "AI 驱动的实时分析".to_string(),
});
```

### Q2: 如何定义只需要模块、不限制版本的功能？

```rust
self.register(FeatureRequirement {
    feature: "basic_ai".to_string(),
    display_name: "基础 AI 功能".to_string(),
    min_edition: None, // 不限制版本
    required_modules: vec!["ai".to_string()], // 但需要 ai 模块
    description: "基础的 AI 能力".to_string(),
});
```

### Q3: 如何在运行时动态添加功能？

```rust
use crate::license_features::FEATURE_REGISTRY;

// 注意：FEATURE_REGISTRY 是只读的，需要修改为 RwLock 才能动态添加
// 当前设计推荐在编译时注册所有功能
```

### Q4: 旧的 require_edition() 和 require_module() 还能用吗？

可以！新旧方式可以共存：
- **新功能** - 使用 `require_feature()`（推荐）
- **旧代码** - 保持 `require_edition()` / `require_module()`（兼容）

---

## 十一、最佳实践

### ✅ DO

1. **功能标识符命名规范**
   - 使用 `snake_case`
   - 前缀表示分类：`ai_`, `ha_`, `sso_`, `audit_` 等
   - 清晰描述功能：`ai_generation` 而不是 `ai1`

2. **及时注册新功能**
   - 添加新功能时立即注册
   - 不要等到后期批量注册

3. **统一使用 require_feature()**
   - 新代码一律使用功能注册表
   - 逐步迁移旧代码

### ❌ DON'T

1. **不要重复注册**
   - 一个功能只注册一次
   - 相同功能使用同一个标识符

2. **不要在业务代码中硬编码 License 要求**
   - ❌ `if license.edition != "enterprise"`
   - ✅ `require_feature("sso_saml", &license)?`

3. **不要跳过功能注册**
   - 即使是简单功能也应该注册
   - 便于统一管理和审计

---

## 十二、实施清单

### 立即可用

- [x] 功能注册表核心代码（`src/license_features.rs`）
- [x] 内置功能注册（AI、HA、SSO、审计等）
- [x] 单元测试覆盖

### 待集成

- [ ] 在 `src/main.rs` 中导出模块
- [ ] 在现有 handlers 中迁移到新方式
- [ ] 添加 `/api/license/capabilities` API
- [ ] 添加 `/api/features/:feature` API
- [ ] 前端 FeatureGate 组件
- [ ] 前端功能发现界面

---

**版本**: v1.0
**创建日期**: 2026-09-01
**状态**: ✅ 设计完成，等待集成
