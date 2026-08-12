//! 商用离线 License（授权 / 续保控制）模块。
//!
//! 设计目标（对应私有化 + 渠道绑定策略）：
//! - **离线可验证**：License 是一份 RSA 签名的 JSON 文件，随交付包一起放到客户内网，
//!   无需回连任何服务器即可校验。私钥只在原厂手里，客户拿不到、也伪造不了。
//! - **续保 = 换新文件**：续期就是原厂重新签发一份到期日更晚的 License 文件替换进去。
//!   "收到续保结算才发新授权" 这条商业杠杆在技术上就此落地。
//! - **到期降级而非停机**：过期先进宽限期（仍可写、只告警），宽限期满进入
//!   **只读降级**（放行读、拦截写），把续费压力推给客户/渠道，同时不至于一刀切停机。
//! - **部署指纹绑定**：可把 License 绑定到某个部署指纹，防止一份授权复制到多处。
//!
//! 依赖只用 Cargo.toml 里已有的 crate（rsa / sha2 / base64 / serde / chrono），
//! 不额外引入重量；签发 / 校验逻辑集中在此，服务端与 `license_tool` CLI 共用。
//!
//! 环境变量：
//! - `ONEBASE_LICENSE_ENFORCE`      off | warn | enforce（默认 warn：只告警不拦截）
//! - `ONEBASE_LICENSE_PATH`         License 文件路径（默认探测 ./license.lic、/etc/onebase/license.lic）
//! - `ONEBASE_LICENSE_PUBLIC_KEY`   验签公钥（PEM 内联字符串）
//! - `ONEBASE_LICENSE_PUBLIC_KEY_PATH` 验签公钥文件路径（与上者二选一）
//! - `ONEBASE_DEPLOY_FINGERPRINT`   覆盖当前部署指纹（默认由主机名派生）
//! - `ONEBASE_LICENSE_REFRESH_SECS` 后台重载间隔秒（默认 300）

use std::sync::Arc;

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use rsa::pkcs1v15::{Signature, SigningKey, VerifyingKey};
use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey, LineEnding};
use rsa::signature::{RandomizedSigner, SignatureEncoding, Verifier};
use rsa::{RsaPrivateKey, RsaPublicKey};
use sha2::{Digest, Sha256};

/// 编译期内嵌的验签公钥（`src/license_public.pem`）。
/// - 默认仓库里放的是**占位文件**（不含 PEM），此时视为"未内嵌"，回落到环境变量；
/// - 原厂用 `license_tool keygen` 生成公钥后覆盖该文件并重编，即完成硬内嵌：
///   一旦内嵌真实公钥，`read_public_key` 就【忽略】环境变量，客户无法通过替换公钥
///   文件 + 自签授权来绕过校验。私钥只留原厂，切勿入库。
const EMBEDDED_PUBLIC_KEY: &str = include_str!("license_public.pem");

// ============================ 数据结构 ============================

/// License 声明（被签名的实际载荷）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseClaims {
    /// 许可证编号（便于对账 / 吊销登记）。
    pub license_id: String,
    /// 客户名称。
    pub customer: String,
    /// 版本：standard / enterprise / group。
    pub edition: String,
    /// 启用的模块开关（对齐报价单加购项）：multitenant / ai / xinchuang / ha / audit / pipeline。
    #[serde(default)]
    pub modules: Vec<String>,
    /// 部署节点上限（None = 不限）。
    #[serde(default)]
    pub max_nodes: Option<u32>,
    /// 租户上限（None = 不限）。
    #[serde(default)]
    pub max_tenants: Option<u32>,
    /// 签发时间（Unix 秒）。
    pub issued_at: i64,
    /// 到期时间（Unix 秒）。
    pub expires_at: i64,
    /// 宽限天数：到期后仍可写的缓冲期，满后进入只读降级。
    #[serde(default = "default_grace_days")]
    pub grace_days: i64,
    /// 绑定的部署指纹（None / 空 = 不绑定）。
    #[serde(default)]
    pub fingerprint: Option<String>,
    /// 备注（可选）。
    #[serde(default)]
    pub notes: Option<String>,
}

fn default_grace_days() -> i64 {
    30
}

impl LicenseClaims {
    /// 是否启用了某模块。
    pub fn has_module(&self, key: &str) -> bool {
        self.modules.iter().any(|m| m.eq_ignore_ascii_case(key))
    }
}

/// License 文件封装（落盘 / 传输格式）：签名 + base64 载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseFile {
    /// 签名算法标识（当前固定 RS256 = RSA-PKCS1v15 + SHA-256）。
    pub alg: String,
    /// base64(被签名的 claims JSON 原始字节)。
    pub payload: String,
    /// base64(RSA 签名)。
    pub signature: String,
}

/// 授权状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LicenseStatus {
    /// 有效。
    Active,
    /// 已到期、宽限期内（仍可写，仅告警）。
    Grace,
    /// 宽限期满、只读降级。
    Expired,
    /// 签名无效 / 指纹不匹配 / 文件损坏。
    Invalid,
    /// 未找到 License 或未配置公钥。
    Missing,
    /// 未启用授权校验（enforce=off）。
    Unlicensed,
}

impl LicenseStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            LicenseStatus::Active => "active",
            LicenseStatus::Grace => "grace",
            LicenseStatus::Expired => "expired",
            LicenseStatus::Invalid => "invalid",
            LicenseStatus::Missing => "missing",
            LicenseStatus::Unlicensed => "unlicensed",
        }
    }
}

/// 强制模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnforceMode {
    /// 完全不校验（开发 / 兼容旧部署）。
    Off,
    /// 校验并暴露状态、大声告警，但永不拦截写操作（默认）。
    Warn,
    /// 到期 / 无效时拦截写操作（只读降级）。
    Enforce,
}

impl EnforceMode {
    pub fn from_env() -> Self {
        match std::env::var("ONEBASE_LICENSE_ENFORCE")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "off" | "false" | "0" | "none" => EnforceMode::Off,
            "enforce" | "strict" | "on" | "1" => EnforceMode::Enforce,
            _ => EnforceMode::Warn,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            EnforceMode::Off => "off",
            EnforceMode::Warn => "warn",
            EnforceMode::Enforce => "enforce",
        }
    }
}

/// 某一时刻的授权快照（供中间件与状态接口读取）。
#[derive(Debug, Clone)]
pub struct LicenseSnapshot {
    pub status: LicenseStatus,
    pub message: String,
    pub claims: Option<LicenseClaims>,
    pub checked_at: i64,
}

/// 授权状态句柄：内部持有一个可原子替换的快照，后台任务定期重载。
#[derive(Clone)]
pub struct LicenseState {
    mode: EnforceMode,
    inner: Arc<std::sync::RwLock<Arc<LicenseSnapshot>>>,
}

// ============================ 密钥 / 签发 / 校验 ============================

/// 生成一对 RSA-2048 密钥，返回 (私钥 PEM, 公钥 PEM)。私钥务必只留在原厂。
pub fn generate_keypair() -> Result<(String, String), String> {
    let mut rng = rand::thread_rng();
    let priv_key = RsaPrivateKey::new(&mut rng, 2048).map_err(|e| format!("生成私钥失败: {e}"))?;
    let pub_key = RsaPublicKey::from(&priv_key);
    let priv_pem = priv_key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| format!("私钥 PEM 编码失败: {e}"))?
        .to_string();
    let pub_pem = pub_key
        .to_public_key_pem(LineEnding::LF)
        .map_err(|e| format!("公钥 PEM 编码失败: {e}"))?;
    Ok((priv_pem, pub_pem))
}

/// 用私钥签发一份 License，返回可直接落盘的 JSON 文件内容。
pub fn sign_license(private_pem: &str, claims: &LicenseClaims) -> Result<String, String> {
    let priv_key =
        RsaPrivateKey::from_pkcs8_pem(private_pem).map_err(|e| format!("解析私钥失败: {e}"))?;
    let signing_key = SigningKey::<Sha256>::new(priv_key);
    let payload = serde_json::to_vec(claims).map_err(|e| format!("claims 序列化失败: {e}"))?;
    let mut rng = rand::thread_rng();
    let sig = signing_key.sign_with_rng(&mut rng, &payload);
    let file = LicenseFile {
        alg: "RS256".to_string(),
        payload: general_purpose::STANDARD.encode(&payload),
        signature: general_purpose::STANDARD.encode(sig.to_bytes()),
    };
    serde_json::to_string_pretty(&file).map_err(|e| format!("License 文件序列化失败: {e}"))
}

/// 用公钥校验 License 文件并解析出 claims（不判断是否过期）。
pub fn verify_license_file(public_pem: &str, file_content: &str) -> Result<LicenseClaims, String> {
    let file: LicenseFile =
        serde_json::from_str(file_content).map_err(|e| format!("License 文件格式错误: {e}"))?;
    let pub_key =
        RsaPublicKey::from_public_key_pem(public_pem).map_err(|e| format!("解析公钥失败: {e}"))?;
    let verifying_key = VerifyingKey::<Sha256>::new(pub_key);
    let payload = general_purpose::STANDARD
        .decode(file.payload.as_bytes())
        .map_err(|e| format!("payload 解码失败: {e}"))?;
    let sig_bytes = general_purpose::STANDARD
        .decode(file.signature.as_bytes())
        .map_err(|e| format!("签名解码失败: {e}"))?;
    let sig =
        Signature::try_from(sig_bytes.as_slice()).map_err(|e| format!("签名解析失败: {e}"))?;
    verifying_key
        .verify(&payload, &sig)
        .map_err(|_| "License 签名校验失败（文件被篡改或公钥不匹配）".to_string())?;
    serde_json::from_slice(&payload).map_err(|e| format!("claims 解析失败: {e}"))
}

/// 依据 claims + 当前时间 + 当前指纹，判定授权状态。
pub fn evaluate(claims: &LicenseClaims, now: i64, current_fp: &str) -> (LicenseStatus, String) {
    if let Some(fp) = &claims.fingerprint {
        if !fp.is_empty() && fp != current_fp {
            return (
                LicenseStatus::Invalid,
                format!("部署指纹不匹配（授权绑定 {fp}，当前 {current_fp}）"),
            );
        }
    }
    let grace = claims.grace_days.max(0) * 86_400;
    if now <= claims.expires_at {
        (LicenseStatus::Active, "授权有效".to_string())
    } else if now <= claims.expires_at + grace {
        let left = ((claims.expires_at + grace - now) / 86_400).max(0);
        (
            LicenseStatus::Grace,
            format!("授权已到期，处于宽限期（剩余约 {left} 天），请尽快续期"),
        )
    } else {
        (
            LicenseStatus::Expired,
            "授权已过期，系统进入只读降级模式；续期并替换 License 后自动恢复写入".to_string(),
        )
    }
}

// ============================ 部署指纹 ============================

fn hostname_best_effort() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty()))
        .or_else(|| std::env::var("HOST").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "unknown-host".to_string())
}

/// 当前部署指纹：优先取环境变量覆盖，否则由主机名派生（sha256 前 8 字节 hex）。
pub fn current_fingerprint() -> String {
    if let Ok(fp) = std::env::var("ONEBASE_DEPLOY_FINGERPRINT") {
        if !fp.is_empty() {
            return fp;
        }
    }
    let mut h = Sha256::new();
    h.update(hostname_best_effort().as_bytes());
    let digest = h.finalize();
    hex::encode(&digest[..8])
}

// ============================ 加载 / 状态机 ============================

fn read_public_key() -> Option<String> {
    // 内嵌公钥优先：一旦编译期内嵌了真实公钥（含 "BEGIN"），就忽略环境变量，
    // 防止客户替换公钥文件 + 自签授权绕过校验——这正是"内嵌"的硬化意义。
    if EMBEDDED_PUBLIC_KEY.contains("BEGIN") {
        return Some(EMBEDDED_PUBLIC_KEY.to_string());
    }
    // 仅当未内嵌真实公钥（占位文件）时，回落到环境变量，便于开发 / 尚未内嵌前使用。
    if let Ok(pem) = std::env::var("ONEBASE_LICENSE_PUBLIC_KEY") {
        if pem.contains("BEGIN") {
            return Some(pem);
        }
    }
    if let Ok(path) = std::env::var("ONEBASE_LICENSE_PUBLIC_KEY_PATH") {
        if let Ok(pem) = std::fs::read_to_string(&path) {
            if pem.contains("BEGIN") {
                return Some(pem);
            }
        }
    }
    None
}

fn read_license_file() -> Option<String> {
    if let Ok(path) = std::env::var("ONEBASE_LICENSE_PATH") {
        return std::fs::read_to_string(&path).ok();
    }
    for candidate in ["./license.lic", "/etc/onebase/license.lic"] {
        if let Ok(content) = std::fs::read_to_string(candidate) {
            return Some(content);
        }
    }
    None
}

fn load_snapshot() -> LicenseSnapshot {
    let now = chrono::Utc::now().timestamp();
    let public_pem = match read_public_key() {
        Some(p) => p,
        None => {
            return LicenseSnapshot {
                status: LicenseStatus::Missing,
                message: "未配置验签公钥（ONEBASE_LICENSE_PUBLIC_KEY[_PATH]）".to_string(),
                claims: None,
                checked_at: now,
            };
        }
    };
    let file_content = match read_license_file() {
        Some(c) => c,
        None => {
            return LicenseSnapshot {
                status: LicenseStatus::Missing,
                message: "未找到 License 文件（ONEBASE_LICENSE_PATH / ./license.lic）".to_string(),
                claims: None,
                checked_at: now,
            };
        }
    };
    match verify_license_file(&public_pem, &file_content) {
        Ok(claims) => {
            let (status, message) = evaluate(&claims, now, &current_fingerprint());
            LicenseSnapshot {
                status,
                message,
                claims: Some(claims),
                checked_at: now,
            }
        }
        Err(e) => LicenseSnapshot {
            status: LicenseStatus::Invalid,
            message: e,
            claims: None,
            checked_at: now,
        },
    }
}

impl LicenseState {
    /// 从环境变量初始化：读取强制模式并加载一次快照。
    pub fn init_from_env() -> Self {
        let mode = EnforceMode::from_env();
        let snapshot = if mode == EnforceMode::Off {
            LicenseSnapshot {
                status: LicenseStatus::Unlicensed,
                message: "授权校验已关闭（ONEBASE_LICENSE_ENFORCE=off）".to_string(),
                claims: None,
                checked_at: chrono::Utc::now().timestamp(),
            }
        } else {
            load_snapshot()
        };
        LicenseState {
            mode,
            inner: Arc::new(std::sync::RwLock::new(Arc::new(snapshot))),
        }
    }

    pub fn mode(&self) -> EnforceMode {
        self.mode
    }

    /// 取当前快照（克隆 Arc，锁只在瞬间持有，不跨 await）。
    pub fn snapshot(&self) -> Arc<LicenseSnapshot> {
        self.inner.read().expect("license lock poisoned").clone()
    }

    fn store(&self, snap: LicenseSnapshot) {
        *self.inner.write().expect("license lock poisoned") = Arc::new(snap);
    }

    /// 重新加载 License（续期换文件 / 到期状态迁移都靠它生效）。
    pub fn reload(&self) {
        if self.mode == EnforceMode::Off {
            return;
        }
        self.store(load_snapshot());
    }

    /// 当前是否允许写操作。返回 (是否允许, 拒绝原因)。
    pub fn allows_write(&self) -> (bool, Option<String>) {
        match self.mode {
            EnforceMode::Off | EnforceMode::Warn => (true, None),
            EnforceMode::Enforce => {
                let snap = self.snapshot();
                match snap.status {
                    LicenseStatus::Active
                    | LicenseStatus::Grace
                    | LicenseStatus::Unlicensed => (true, None),
                    LicenseStatus::Expired | LicenseStatus::Invalid | LicenseStatus::Missing => {
                        (false, Some(snap.message.clone()))
                    }
                }
            }
        }
    }

    /// 当前授权是否包含某模块（对齐报价单加购项）。返回 (是否允许, 拒绝原因)。
    /// warn / off 模式下永不拦截；enforce 模式下要求授权有效且已购该模块。
    pub fn allows_module(&self, module: &str) -> (bool, Option<String>) {
        match self.mode {
            EnforceMode::Off | EnforceMode::Warn => (true, None),
            EnforceMode::Enforce => {
                let snap = self.snapshot();
                match snap.status {
                    LicenseStatus::Active | LicenseStatus::Grace => {
                        let has = snap
                            .claims
                            .as_ref()
                            .map(|c| c.has_module(module))
                            .unwrap_or(false);
                        if has {
                            (true, None)
                        } else {
                            (
                                false,
                                Some(format!(
                                    "当前授权未包含「{}」模块，请联系原厂开通后续期授权",
                                    module_label(module)
                                )),
                            )
                        }
                    }
                    // enforce 模式下不会出现 Unlicensed（那是 off 专属）；其余（过期/无效/缺失）走全局原因。
                    LicenseStatus::Unlicensed => (true, None),
                    _ => (false, Some(snap.message.clone())),
                }
            }
        }
    }

    /// 供 /api/license 与根路径展示的状态摘要（不含签名等敏感字段）。
    pub fn summary_json(&self) -> Value {
        let snap = self.snapshot();
        let mut out = json!({
            "status": snap.status.as_str(),
            "enforcement": self.mode.as_str(),
            "message": snap.message,
            "fingerprint_current": current_fingerprint(),
            "checked_at": to_rfc3339(snap.checked_at),
        });
        if let Some(c) = &snap.claims {
            out["license_id"] = json!(c.license_id);
            out["customer"] = json!(c.customer);
            out["edition"] = json!(c.edition);
            out["modules"] = json!(c.modules);
            out["max_nodes"] = json!(c.max_nodes);
            out["max_tenants"] = json!(c.max_tenants);
            out["issued_at"] = json!(to_rfc3339(c.issued_at));
            out["expires_at"] = json!(to_rfc3339(c.expires_at));
            out["grace_days"] = json!(c.grace_days);
            out["fingerprint_bound"] = json!(c.fingerprint);
        }
        out
    }

    /// 启动时打一条授权状态日志。
    pub fn log_startup(&self) {
        let snap = self.snapshot();
        match snap.status {
            LicenseStatus::Active => {
                tracing::info!(
                    status = snap.status.as_str(),
                    enforcement = self.mode.as_str(),
                    "OneBase 授权校验：{}",
                    snap.message
                );
            }
            LicenseStatus::Unlicensed => {
                tracing::info!("OneBase 授权校验已关闭（enforce=off）");
            }
            _ => {
                tracing::warn!(
                    status = snap.status.as_str(),
                    enforcement = self.mode.as_str(),
                    "OneBase 授权校验：{}（enforce=enforce 时写操作将被拦截并降级为只读）",
                    snap.message
                );
            }
        }
    }

    /// 启动后台重载任务：周期性重新读取 License 文件，让续期 / 到期迁移无需重启即可生效。
    pub fn spawn_refresh(&self) {
        if self.mode == EnforceMode::Off {
            return;
        }
        let secs = std::env::var("ONEBASE_LICENSE_REFRESH_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v >= 5)
            .unwrap_or(300);
        let this = self.clone();
        tokio::spawn(async move {
            let mut prev = this.snapshot().status;
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(secs));
            ticker.tick().await; // 立即触发的首个 tick 跳过（启动已加载过）
            loop {
                ticker.tick().await;
                this.reload();
                let now = this.snapshot();
                if now.status != prev {
                    tracing::warn!(
                        from = prev.as_str(),
                        to = now.status.as_str(),
                        "OneBase 授权状态发生变化：{}",
                        now.message
                    );
                    prev = now.status;
                }
            }
        });
    }
}

/// 模块 key → 中文名（错误提示用），对齐报价单加购项。
fn module_label(module: &str) -> &str {
    match module {
        "multitenant" => "多租户增强",
        "ai" => "AI / MCP 智能体",
        "xinchuang" => "信创适配",
        "ha" => "高可用 / 容灾",
        "audit" => "审计 / 合规",
        "pipeline" => "Kafka / ES 数据管道",
        other => other,
    }
}

fn to_rfc3339(secs: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| secs.to_string())
}

// ============================ Axum 中间件 ============================

/// 授权强制中间件：enforce 模式下、授权无效时拦截写操作（放行读，实现"只读降级"）。
///
/// 豁免：认证 / 健康探针 / 授权状态接口本身，保证客户即便到期也能登录、查看状态、
/// 导入新 License 恢复。
pub async fn license_enforcement_middleware(
    state: Option<axum::extract::Extension<LicenseState>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::Method;
    use axum::response::IntoResponse;

    let state = match state {
        Some(axum::extract::Extension(s)) => s,
        None => return next.run(req).await,
    };

    let method = req.method().clone();
    let is_write = method == Method::POST
        || method == Method::PUT
        || method == Method::PATCH
        || method == Method::DELETE;
    if is_write {
        let path = req.uri().path();
        let exempt = path == "/"
            || path.starts_with("/auth/")
            || path.starts_with("/health")
            || path == "/api/license";
        if !exempt {
            let (ok, reason) = state.allows_write();
            if !ok {
                let body = json!({
                    "error": "license_required",
                    "message": reason.unwrap_or_else(|| {
                        "授权无效或已过期，系统当前为只读模式，请续期后替换 License 文件".to_string()
                    }),
                    "license": state.summary_json(),
                });
                return (axum::http::StatusCode::PAYMENT_REQUIRED, axum::Json(body))
                    .into_response();
            }
        }
    }
    next.run(req).await
}

/// 模块闸门中间件：enforce 模式下、授权未包含指定模块时拦截整组路由（返回 402）。
///
/// 从请求扩展读取 `LicenseState`（由全局 `Extension` 注入，位于最外层，先于本层执行）。
/// 挂在按模块划分的路由组上，例如：
/// ```ignore
/// .layer(axum_middleware::from_fn(|req, next| {
///     onebase::license::require_module(req, next, "pipeline")
/// }))
/// ```
pub async fn require_module(
    req: axum::extract::Request,
    next: axum::middleware::Next,
    module: &str,
) -> axum::response::Response {
    use axum::response::IntoResponse;

    if let Some(state) = req.extensions().get::<LicenseState>().cloned() {
        let (ok, reason) = state.allows_module(module);
        if !ok {
            let body = json!({
                "error": "license_module_required",
                "module": module,
                "message": reason.unwrap_or_default(),
                "license": state.summary_json(),
            });
            return (axum::http::StatusCode::PAYMENT_REQUIRED, axum::Json(body)).into_response();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_claims(expires_at: i64) -> LicenseClaims {
        LicenseClaims {
            license_id: "LIC-TEST-001".to_string(),
            customer: "测试客户".to_string(),
            edition: "enterprise".to_string(),
            modules: vec!["ai".to_string(), "ha".to_string()],
            max_nodes: Some(3),
            max_tenants: None,
            issued_at: 1_000,
            expires_at,
            grace_days: 30,
            fingerprint: None,
            notes: None,
        }
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let (priv_pem, pub_pem) = generate_keypair().unwrap();
        let claims = sample_claims(2_000_000_000);
        let file = sign_license(&priv_pem, &claims).unwrap();
        let parsed = verify_license_file(&pub_pem, &file).unwrap();
        assert_eq!(parsed.license_id, claims.license_id);
        assert_eq!(parsed.customer, claims.customer);
        assert!(parsed.has_module("AI"));
    }

    #[test]
    fn tampered_payload_fails_verify() {
        let (priv_pem, pub_pem) = generate_keypair().unwrap();
        let claims = sample_claims(2_000_000_000);
        let file = sign_license(&priv_pem, &claims).unwrap();
        let mut f: LicenseFile = serde_json::from_str(&file).unwrap();
        // 篡改载荷：把客户名改掉再重新 base64，签名对不上应校验失败。
        let mut tampered = claims.clone();
        tampered.customer = "冒充客户".to_string();
        f.payload = general_purpose::STANDARD.encode(serde_json::to_vec(&tampered).unwrap());
        let bad = serde_json::to_string(&f).unwrap();
        assert!(verify_license_file(&pub_pem, &bad).is_err());
    }

    #[test]
    fn wrong_key_fails_verify() {
        let (priv_pem, _pub_pem) = generate_keypair().unwrap();
        let (_priv2, pub_pem2) = generate_keypair().unwrap();
        let file = sign_license(&priv_pem, &sample_claims(2_000_000_000)).unwrap();
        assert!(verify_license_file(&pub_pem2, &file).is_err());
    }

    #[test]
    fn evaluate_active_grace_expired() {
        let claims = sample_claims(1_000_000);
        // now 在到期前 → Active
        assert_eq!(evaluate(&claims, 999_999, "fp").0, LicenseStatus::Active);
        // now 在宽限期内 → Grace
        let in_grace = 1_000_000 + 10 * 86_400;
        assert_eq!(evaluate(&claims, in_grace, "fp").0, LicenseStatus::Grace);
        // now 超过宽限期 → Expired
        let after = 1_000_000 + 40 * 86_400;
        assert_eq!(evaluate(&claims, after, "fp").0, LicenseStatus::Expired);
    }

    #[test]
    fn fingerprint_mismatch_is_invalid() {
        let mut claims = sample_claims(2_000_000_000);
        claims.fingerprint = Some("bound-fp".to_string());
        assert_eq!(
            evaluate(&claims, 1_500, "other-fp").0,
            LicenseStatus::Invalid
        );
        assert_eq!(evaluate(&claims, 1_500, "bound-fp").0, LicenseStatus::Active);
    }
}
