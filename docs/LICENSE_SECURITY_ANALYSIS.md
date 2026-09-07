# License 安全性分析与攻击向量

## 🎯 攻击目标

攻击者的目标：
1. **绕过版本限制** - 将 Trial 伪装成 Enterprise
2. **绕过模块限制** - 启用未购买的模块（AI、HA、SSO 等）
3. **绕过数量限制** - 突破租户数、账号数、节点数上限
4. **延长有效期** - 修改过期时间
5. **移除硬件绑定** - 一个 License 复制到多台机器

---

## 🔍 可能的攻击入手点

### 入手点 1: License 文件篡改 ⚠️ 难度：高

**攻击方式**：
```bash
# 读取 License 文件
cat /etc/onebase/license.lic

# 尝试解码 payload（base64）
echo "eyJlZGl0aW9uIjoidHJpYWwiLCJtb2R1bGVzIjpbXX0=" | base64 -d

# 修改为 enterprise 版本
echo '{"edition":"enterprise","modules":["ai","ha"]}' | base64

# 尝试替换回文件
```

**防御机制**：✅ **RSA-2048 数字签名**

```rust
// src/license.rs:215
pub fn verify_license_file(public_pem: &str, file_content: &str) -> Result<LicenseClaims, String> {
    let pub_key = RsaPublicKey::from_public_key_pem(public_pem)?;
    let verifying_key = VerifyingKey::<Sha256>::new(pub_key);

    // 任何payload 修改都会导致签名验证失败
    verifying_key.verify(&payload, &sig)
        .map_err(|_| "License 签名校验失败（文件被篡改或公钥不匹配）")?;
}
```

**破解难度**：⭐⭐⭐⭐⭐ **极高（几乎不可能）**

- RSA-2048 在目前的计算能力下无法破解（需要数百万年）
- 即使修改 1 个字节，签名也会失败
- 测试证明（见 `src/license.rs:672`）：
  ```rust
  #[test]
  fn tampered_payload_fails_verify() {
      // 篡改客户名后，签名验证失败
      assert!(verify_license_file(&pub_pem, &bad).is_err());
  }
  ```

**结论**：✅ **无法通过篡改 License 文件绕过**

---

### 入手点 2: 替换公钥 + 自签 License ⚠️ 难度：中高

**攻击方式**：
```bash
# 1. 生成自己的密钥对
cargo run --bin license_tool keygen --out-dir ./hacked

# 2. 用自己的私钥签发一个"无限制" License
cargo run --bin license_tool issue \
  --priv ./hacked/private.pem \
  --customer "Hacked" \
  --edition "enterprise" \
  --modules "ai,ha,multitenant,audit,pipeline" \
  --days 36500 \
  --out /etc/onebase/license.lic

# 3. 尝试替换验签公钥
export ONEBASE_LICENSE_PUBLIC_KEY="$(cat ./hacked/public.pem)"
```

**防御机制 1**：✅ **编译期公钥硬编码**

```rust
// src/license.rs:42
const EMBEDDED_PUBLIC_KEY: &str = include_str!("license_public.pem");

// src/license.rs:291
fn read_public_key() -> Option<String> {
    // 一旦编译期内嵌了真实公钥（含 "BEGIN"），就忽略环境变量
    if EMBEDDED_PUBLIC_KEY.contains("BEGIN") {
        return Some(EMBEDDED_PUBLIC_KEY.to_string());
    }
    // 仅当未内嵌时才回落到环境变量（开发模式）
    std::env::var("ONEBASE_LICENSE_PUBLIC_KEY").ok()
}
```

**原理**：
- 公钥在**编译时**被硬编码到二进制文件中（`include_str!`）
- 运行时**无法修改**二进制中的公钥
- 环境变量 `ONEBASE_LICENSE_PUBLIC_KEY` 只在**开发模式**有效（生产二进制忽略）

**破解难度**：⭐⭐⭐⭐ **高（需要二进制修改）**

**攻击者需要**：
1. 反编译 OneBase 二进制文件
2. 找到内嵌公钥的内存位置
3. 用 hex 编辑器替换公钥
4. 重新计算校验和（如果有）

**防御加固**：
- 二进制混淆
- 代码签名（macOS/Windows）
- 完整性检查（启动时校验）

**结论**：⚠️ **高级攻击者可能绕过，但需要逆向工程能力**

---

### 入手点 3: 修改二进制文件中的检查逻辑 ⚠️ 难度：高

**攻击方式**：
```bash
# 1. 反编译 OneBase 二进制
# 找到 require_module() 函数

# 2. 用 hex 编辑器修改机器码
# 将 "返回错误" 的指令改为 "返回成功"

# 3. 或者替换 has_module() 函数，让它永远返回 true
```

**示例代码位置**：
```rust
// src/license_enforcement.rs:146
pub fn require_module(ctx: &LicenseContext, module: &str) -> Result<()> {
    if ctx.has_module(module) {  // 👈 攻击者尝试让这里永远返回 true
        Ok(())
    } else {
        Err(AppError::Forbidden(...))
    }
}
```

**防御机制**：⚠️ **依赖二进制完整性**

目前**没有**针对二进制篡改的主动防御机制。

**破解难度**：⭐⭐⭐⭐ **高（需要逆向工程 + 重编译）**

**攻击者需要**：
1. Rust 逆向工程能力
2. 找到检查函数的机器码位置
3. 修改跳转指令或返回值
4. 重新签名二进制（如果有代码签名）

**防御加固建议**：
```rust
// 方案 A: 代码混淆
#[inline(never)]
#[no_mangle]
fn check_license_internal(ctx: &LicenseContext) -> bool {
    // 关键检查逻辑
    // 编译器优化后难以定位
}

// 方案 B: 多重验证
fn require_module(ctx: &LicenseContext, module: &str) -> Result<()> {
    // 1. 直接检查
    if !ctx.has_module(module) {
        return Err(...);
    }

    // 2. 重新解析 License 文件验证
    let claims = re_verify_license()?;
    if !claims.modules.contains(&module.to_string()) {
        return Err(...);
    }

    // 3. 随机抽查（增加篡改成本）
    Ok(())
}

// 方案 C: 启动时完整性检查
fn main() {
    verify_binary_checksum().expect("二进制文件被篡改");
    // ...
}
```

**结论**：⚠️ **可能被高级攻击者绕过，建议增加完整性检查**

---

### 入手点 4: 数据库直接操作 ⚠️ 难度：低

**攻击方式**：
```sql
-- 直接修改数据库，绕过 License 检查
-- 添加账号（无视 max_accounts_per_tenant 限制）
INSERT INTO management.user_tenants (user_id, tenant_id, role, is_active)
VALUES (999, 1, 'admin', true);

-- 创建租户（无视 max_tenants 限制）
INSERT INTO management.tenants (name, slug, status)
VALUES ('Hacked Tenant', 'hacked', 'active');
```

**防御机制**：✅ **中间件强制执行**

```rust
// src/license_enforcement.rs:78
pub async fn license_middleware(
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let license_ctx = load_and_verify_license().await?;
    req.extensions_mut().insert(license_ctx);  // 每次请求都验证
    Ok(next.run(req).await)
}

// 每个 Handler 都会检查
pub async fn add_project_member(
    license: LicenseContext,  // 👈 自动注入，无法绕过
    ...
) -> Result<impl IntoResponse> {
    check_account_limit(&license, &pool, project_id).await?;
    // ...
}
```

**原理**：
- 所有 API 请求都经过 `license_middleware`
- 每次操作都实时检查 License
- 直接操作数据库**不会触发 API**，但：
  - 用户无法通过前端界面触发
  - 需要数据库直接访问权限（通常只有管理员）

**破解难度**：⭐ **低（如果有数据库访问权限）**

**防御加固建议**：
```sql
-- 方案 A: 数据库触发器
CREATE OR REPLACE FUNCTION check_tenant_account_limit()
RETURNS TRIGGER AS $$
BEGIN
    -- 从某个 License 配置表读取限制
    -- 如果超限，拒绝插入
    RAISE EXCEPTION 'Account limit exceeded';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_insert_user_tenants
BEFORE INSERT ON management.user_tenants
FOR EACH ROW EXECUTE FUNCTION check_tenant_account_limit();
```

**结论**：⚠️ **有数据库权限的内部人员可以绕过，建议添加数据库层面的约束**

---

### 入手点 5: 环境变量覆盖 ⚠️ 难度：低（开发模式）

**攻击方式**：
```bash
# 尝试关闭 License 强制执行
export ONEBASE_LICENSE_ENFORCE=off

# 或者提供一个假的 License 文件
export ONEBASE_LICENSE_PATH=/tmp/fake_license.lic
```

**防御机制**：✅ **生产模式强制开启**

```rust
// src/license.rs:144
impl EnforceMode {
    pub fn from_env() -> Self {
        match std::env::var("ONEBASE_LICENSE_ENFORCE")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "off" => EnforceMode::Off,  // 只在开发环境有效
            "enforce" => EnforceMode::Enforce,
            _ => EnforceMode::Warn,  // 默认警告模式
        }
    }
}
```

**问题**：
- 默认是 `Warn` 模式（只告警不拦截）
- 生产环境应该设置为 `Enforce` 模式

**破解难度**：⭐ **极低（如果默认是 Warn 模式）**

**防御加固建议**：
```rust
// 编译时决定默认模式
pub fn from_env() -> Self {
    #[cfg(debug_assertions)]
    let default_mode = EnforceMode::Warn;

    #[cfg(not(debug_assertions))]
    let default_mode = EnforceMode::Enforce;  // 生产构建强制开启

    match std::env::var("ONEBASE_LICENSE_ENFORCE")
        .unwrap_or_default()
        .as_str()
    {
        "off" if cfg!(debug_assertions) => EnforceMode::Off,  // 只在 debug 构建允许 off
        "warn" => EnforceMode::Warn,
        _ => default_mode,
    }
}
```

**结论**：✅ **需要确保生产环境设置 `ONEBASE_LICENSE_ENFORCE=enforce`**

---

## 📊 攻击向量总结

| 攻击方式 | 难度 | 成功率 | 防御等级 | 建议加固 |
|---------|------|--------|---------|---------|
| 篡改 License 文件 | ⭐⭐⭐⭐⭐ | 0% | ✅ 优秀 | 无需加固 |
| 替换公钥 + 自签 | ⭐⭐⭐⭐ | 10% | ✅ 良好 | 二进制签名 |
| 修改二进制检查逻辑 | ⭐⭐⭐⭐ | 20% | ⚠️ 一般 | 完整性检查 + 混淆 |
| 直接操作数据库 | ⭐ | 80% | ⚠️ 弱 | 数据库触发器 |
| 环境变量覆盖 | ⭐ | 90% | ⚠️ 弱 | 强制 Enforce 模式 |

---

## 🛡️ 综合防御建议

### 立即实施（高优先级）

1. **强制 Enforce 模式（生产环境）**
   ```bash
   # 部署配置
   export ONEBASE_LICENSE_ENFORCE=enforce
   ```

2. **限制数据库访问权限**
   ```sql
   -- 应用账号只给 API 需要的权限，不给超管权限
   REVOKE ALL ON management.user_tenants FROM onebase_app;
   GRANT SELECT, INSERT, UPDATE ON management.user_tenants TO onebase_app;
   ```

3. **监控异常操作**
   ```rust
   // 审计日志记录所有 License 检查失败
   if let Err(e) = require_module(&license, "ai") {
       log_security_event("license_check_failed", &e);
   }
   ```

### 短期加固（1-2 周）

4. **数据库触发器**
   ```sql
   CREATE TRIGGER check_account_limit
   BEFORE INSERT ON management.user_tenants
   FOR EACH ROW EXECUTE FUNCTION validate_license_limit();
   ```

5. **二进制代码签名**
   ```bash
   # macOS
   codesign --sign "Developer ID" ./target/release/onebase

   # Windows
   signtool sign /f certificate.pfx /p password onebase.exe
   ```

6. **启动时完整性检查**
   ```rust
   fn main() {
       let binary_hash = calculate_self_hash();
       if binary_hash != EXPECTED_HASH {
           panic!("二进制文件被篡改");
       }
   }
   ```

### 长期加固（1-3 月）

7. **License 服务器在线验证（可选）**
   ```rust
   // 定期向 License 服务器报告使用情况
   async fn verify_with_server(license_id: &str) {
       let response = reqwest::get(
           format!("https://license.onebase.com/verify/{}", license_id)
       ).await?;

       if !response.is_valid() {
           revoke_license();
       }
   }
   ```

8. **硬件指纹强化**
   ```rust
   // 结合多个硬件特征
   fn enhanced_fingerprint() -> String {
       let hostname = get_hostname();
       let mac_address = get_primary_mac();
       let cpu_id = get_cpu_id();

       sha256(format!("{hostname}{mac_address}{cpu_id}"))
   }
   ```

9. **License 使用统计上报**
   ```rust
   // 每天上报使用情况（可选，需客户同意）
   async fn report_usage() {
       api.post("/usage", json!({
           "license_id": ctx.claims.license_id,
           "tenant_count": count_tenants(),
           "account_count": count_accounts(),
       })).await;
   }
   ```

---

## 🎯 被破解可能性评估

### 场景 A：普通用户（无技术背景）

**攻击能力**：
- ❌ 无法篡改 License 文件（RSA-2048 签名）
- ❌ 无法修改二进制文件（缺乏逆向工程能力）
- ❌ 无法访问数据库（无权限）

**破解可能性**：**0%** ✅

---

### 场景 B：技术用户（开发者）

**攻击能力**：
- ❌ 无法篡改 License 文件（RSA-2048 签名）
- ⚠️ 可能尝试修改二进制（但难度大）
- ⚠️ 可能有数据库访问权限（如果是管理员）
- ⚠️ 可能设置 `ENFORCE=off`（如果有服务器权限）

**破解可能性**：**10-30%** ⚠️

**防御措施**：
- 强制 Enforce 模式
- 限制数据库权限
- 监控异常操作

---

### 场景 C：高级攻击者（安全研究员/黑客）

**攻击能力**：
- ❌ 无法篡改 License 文件（RSA-2048 签名）
- ✅ 可以修改二进制文件（逆向工程）
- ✅ 可以修改编译器/构建流程
- ✅ 可以部署自己编译的版本

**破解可能性**：**60-80%** 🔴

**但是**：
- 需要大量时间（数天到数周）
- 需要专业技能（Rust 逆向、汇编）
- 每次更新都需要重新破解
- 法律风险（软件盗版）

**防御措施**：
- 二进制混淆
- 代码签名
- 启动完整性检查
- 法律协议约束

---

## 📝 总结

### ✅ 当前防御强度

| 维度 | 强度 | 说明 |
|------|------|------|
| **License 签名** | ⭐⭐⭐⭐⭐ | RSA-2048，几乎不可破解 |
| **公钥保护** | ⭐⭐⭐⭐ | 编译期内嵌，难以替换 |
| **运行时检查** | ⭐⭐⭐ | 中间件强制，但依赖 Enforce 模式 |
| **数据库防护** | ⭐⭐ | 可直接操作绕过 |
| **二进制保护** | ⭐⭐ | 可被高级攻击者篡改 |

### 🎯 破解可能性评估

- **普通用户**：0% ✅
- **技术用户**：10-30% ⚠️
- **高级攻击者**：60-80% 🔴

### 🔒 推荐安全等级

**现状**：⭐⭐⭐⭐ （良好）

**加固后**：⭐⭐⭐⭐⭐ （优秀）

**关键措施**：
1. ✅ **立即**：强制 Enforce 模式 + 限制数据库权限
2. ⚠️ **短期**：数据库触发器 + 二进制签名
3. 💡 **长期**：在线验证 + 完整性检查

---

**版本**: v1.0
**创建日期**: 2026-09-01
**状态**: ✅ 分析完成
