# License 功能映射关系设计

## 📊 概述

本文档说明 OneBase 中**功能与 License 的映射关系**，以及两种实现方案的对比。

---

## 🎯 映射关系定义

### 核心概念

**功能（Feature）** = 系统中某个独立的能力或模块
**License 要求** = 使用该功能所需的 License 条件

### 多维度限制

OneBase License 支持多维度限制，功能可用性取决于：

1. **edition（版本等级）** - trial < standard < enterprise
2. **modules（功能模块）** - ai, ha, multitenant, audit, pipeline
3. **max_tenants（租户数）** - 数量限制
4. **max_nodes（节点数）** - 数量限制
5. **max_accounts_per_tenant（账号数）** - 数量限制

---

## 🔀 两种实现方案对比

### 方案 A：分散式检查（当前默认方式）

#### 实现方式

在每个 Handler 中手动调用检查函数：

```rust
pub async fn generate_with_ai(
    license: LicenseContext,
    prompt: String,
) -> Result<String> {
    // 手动检查版本
    require_edition(&license, "standard")?;

    // 手动检查模块
    require_module(&license, "ai")?;

    call_openai_api(&prompt).await
}
```

#### 优点

✅ **简单直接** - 不需要额外的注册机制
✅ **灵活性高** - 可以动态组合检查逻辑
✅ **无依赖** - 不依赖全局状态

#### 缺点

❌ **分散管理** - 功能-License 映射分散在各个文件中
❌ **难以审计** - 查看某功能需要什么 License 需要找代码
❌ **容易遗漏** - 新功能可能忘记添加检查
❌ **重复代码** - 相同的检查逻辑重复多次
❌ **维护困难** - 修改权限策略需要找到所有相关代码

#### 适用场景

- 小型项目（< 20 个功能）
- 功能权限简单且稳定
- 开发团队小，易于协调

---

### 方案 B：集中式注册表（推荐）

#### 实现方式

在注册表中声明式定义功能要求：

```rust
// src/license_features.rs - 集中定义
fn register_builtin_features(&mut self) {
    self.register(FeatureRequirement {
        feature: "ai_generation".to_string(),
        display_name: "AI 内容生成".to_string(),
        min_edition: Some("standard".to_string()),
        required_modules: vec!["ai".to_string()],
        description: "使用 AI 生成内容".to_string(),
    });
}

// Handler - 一行调用
pub async fn generate_with_ai(
    license: LicenseContext,
    prompt: String,
) -> Result<String> {
    require_feature("ai_generation", &license)?;
    call_openai_api(&prompt).await
}
```

#### 优点

✅ **集中管理** - 所有功能权限在一个文件中
✅ **易于审计** - 一眼看清所有功能的 License 要求
✅ **不易遗漏** - 统一入口，强制注册
✅ **代码简洁** - Handler 中只需一行检查
✅ **易于维护** - 修改权限策略只需改注册表
✅ **可查询** - 支持查询可用功能列表
✅ **友好错误** - 自动生成含功能名称的错误提示

#### 缺点

⚠️ **需要注册** - 每个功能都需要先注册
⚠️ **全局状态** - 使用 Lazy 静态变量
⚠️ **学习成本** - 开发者需要了解注册机制

#### 适用场景

- 中大型项目（> 20 个功能）
- 功能权限复杂且频繁变化
- 多团队协作，需要统一管理
- 需要向前端暴露功能列表

---

## 📋 功能矩阵（注册表配置）

### 已注册的内置功能

| 功能标识符 | 显示名称 | 最低版本 | 必需模块 | 说明 |
|-----------|---------|---------|---------|------|
| `basic_crud` | 基础 CRUD | - | - | 所有版本支持 |
| `workflow` | 工作流自动化 | standard | - | 创建自动化流程 |
| `ai_generation` | AI 内容生成 | standard | ai | AI 生成功能 |
| `ai_mcp` | MCP 智能体 | standard | ai | MCP 协议集成 |
| `ha_replica` | 数据库副本 | enterprise | ha | 只读副本 |
| `ha_failover` | 自动故障转移 | enterprise | ha | 主备切换 |
| `multitenant_create` | 创建租户 | standard | multitenant | 多租户支持 |
| `multitenant_isolation` | 租户隔离 | standard | multitenant | 数据隔离 |
| `sso_saml` | SAML 登录 | enterprise | - | SAML 2.0 |
| `sso_oidc` | OIDC 登录 | enterprise | - | OpenID Connect |
| `audit_log` | 审计日志 | enterprise | audit | 操作记录 |
| `audit_export` | 审计导出 | enterprise | audit | 导出合规报告 |
| `pipeline_kafka` | Kafka 管道 | standard | pipeline | Kafka 集成 |
| `pipeline_elasticsearch` | ES 集成 | standard | pipeline | Elasticsearch |
| `custom_domain` | 自定义域名 | enterprise | - | 租户域名 |
| `white_label` | 白标定制 | enterprise | - | 品牌定制 |
| `api_rate_limit_custom` | 自定义限流 | enterprise | - | 租户限流策略 |

---

## 🔄 使用示例对比

### 示例 1: AI 功能

#### 方案 A（分散式）

```rust
// ❌ 需要记住 AI 功能需要 standard + ai 模块
pub async fn generate_with_ai(
    license: LicenseContext,
    prompt: String,
) -> Result<String> {
    require_edition(&license, "standard")?;
    require_module(&license, "ai")?;
    call_openai_api(&prompt).await
}
```

#### 方案 B（集中式）

```rust
// ✅ 功能标识符清晰，License 要求在注册表中
pub async fn generate_with_ai(
    license: LicenseContext,
    prompt: String,
) -> Result<String> {
    require_feature("ai_generation", &license)?;
    call_openai_api(&prompt).await
}
```

---

### 示例 2: SSO 功能

#### 方案 A（分散式）

```rust
// ❌ SSO 需要 enterprise，可能忘记检查
pub async fn configure_sso(
    license: LicenseContext,
    Json(req): Json<SsoConfig>,
) -> Result<impl IntoResponse> {
    require_edition(&license, "enterprise")?;
    save_sso_config(&req).await?;
    Ok(Json(json!({"message": "SSO 配置成功"})))
}
```

#### 方案 B（集中式）

```rust
// ✅ 功能标识符明确意图
pub async fn configure_sso(
    license: LicenseContext,
    Json(req): Json<SsoConfig>,
) -> Result<impl IntoResponse> {
    require_feature("sso_saml", &license)?;
    save_sso_config(&req).await?;
    Ok(Json(json!({"message": "SSO 配置成功"})))
}
```

---

### 示例 3: 高可用功能

#### 方案 A（分散式）

```rust
// ❌ 需要同时检查版本和模块，容易漏
pub async fn create_read_replica(
    license: LicenseContext,
    State(pool): State<PgPool>,
    Json(req): Json<CreateReplicaRequest>,
) -> Result<impl IntoResponse> {
    require_edition(&license, "enterprise")?;
    require_module(&license, "ha")?;

    let replica = create_replica_internal(&pool, &req).await?;
    Ok(Json(replica))
}
```

#### 方案 B（集中式）

```rust
// ✅ 一行搞定，要求在注册表中
pub async fn create_read_replica(
    license: LicenseContext,
    State(pool): State<PgPool>,
    Json(req): Json<CreateReplicaRequest>,
) -> Result<impl IntoResponse> {
    require_feature("ha_replica", &license)?;

    let replica = create_replica_internal(&pool, &req).await?;
    Ok(Json(replica))
}
```

---

## 📊 错误提示对比

### 方案 A（分散式）

```
❌ 此功能需要「enterprise」版本或更高版本，当前为「standard」
❌ 当前 License 未授权「ha」模块，请升级 License
```

**问题**：不知道是哪个功能报错

---

### 方案 B（集中式）

```
❌ 「数据库副本」功能需要 enterprise 版本或更高版本（当前为 standard）
❌ 「数据库副本」功能需要「ha」模块，请升级 License
```

**优势**：明确指出功能名称，用户友好

---

## 🎯 推荐策略

### 适合方案 A 的场景

- 项目初期，功能少（< 10 个）
- 原型开发，快速迭代
- License 要求非常简单
- 单人开发

### 适合方案 B 的场景

- 项目成熟期，功能多（> 20 个）
- 多团队协作
- License 策略复杂（多维度限制）
- 需要向前端提供功能列表
- 需要生成功能权限报告

### 混合使用

可以两种方案并存：
- **新功能** - 使用注册表（方案 B）
- **旧代码** - 保持原样（方案 A）
- **核心功能** - 迁移到注册表
- **简单功能** - 保持分散式

---

## 🚀 迁移建议

### 阶段 1: 试点（1 周）

1. 创建 `license_features.rs` 模块
2. 注册 5-10 个核心功能
3. 在 1-2 个 handler 中试用
4. 收集反馈

### 阶段 2: 推广（2-4 周）

1. 注册所有功能（30+ 个）
2. 迁移 50% 的 handlers
3. 创建前端 API（/api/license/capabilities）
4. 更新文档

### 阶段 3: 完成（1-2 周）

1. 迁移剩余 handlers
2. 添加功能发现界面
3. 生成功能权限报告
4. 废弃旧检查函数

---

## 📝 实施清单

### 核心文件

- [x] `src/license_features.rs` - 功能注册表核心代码
- [x] `docs/license-feature-registry-guide.md` - 使用指南
- [ ] `src/lib.rs` 或 `src/main.rs` - 导出模块
- [ ] `Cargo.toml` - 添加 once_cell 依赖（如果没有）

### API 端点

- [ ] `GET /api/license/capabilities` - 获取可用功能列表
- [ ] `GET /api/features/:feature` - 获取功能详情
- [ ] `GET /api/features/all` - 获取所有功能列表

### 前端组件

- [ ] `FeatureGate` 组件 - 功能权限门控
- [ ] 功能发现界面 - 展示所有功能及状态
- [ ] License 升级引导 - 缺少功能时引导升级

### 文档

- [x] 功能注册表使用指南
- [x] 功能映射关系说明
- [ ] API 文档更新
- [ ] 前端集成指南

---

## 🎓 最佳实践总结

### ✅ DO

1. **统一使用注册表**（新项目或重构时）
2. **及时注册新功能**
3. **功能标识符语义清晰**（`ai_generation` 而不是 `feat1`）
4. **分类命名**（`ai_*`, `ha_*`, `sso_*`）
5. **完善描述**（description 字段）

### ❌ DON'T

1. **不要混用方式**（同一个功能不要既注册又分散检查）
2. **不要跳过注册**（即使简单功能也应注册）
3. **不要硬编码 License 要求**（用功能标识符）
4. **不要忽略错误提示**（利用友好的错误消息）

---

## 📌 总结

| 维度 | 方案 A（分散式） | 方案 B（集中式） |
|------|----------------|----------------|
| **代码量** | 少（每次 2-3 行） | 多（需注册） |
| **可维护性** | ⭐⭐ | ⭐⭐⭐⭐⭐ |
| **可审计性** | ⭐⭐ | ⭐⭐⭐⭐⭐ |
| **错误提示** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **灵活性** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **学习成本** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **适用规模** | 小型 | 中大型 |

**推荐**：
- 🌟 **中大型项目** → 方案 B（集中式注册表）
- 🎯 **快速原型** → 方案 A（分散式检查）
- 🔄 **现有项目** → 逐步迁移到方案 B

---

**版本**: v1.0
**创建日期**: 2026-09-01
**更新日期**: 2026-09-01
**状态**: ✅ 设计完成
