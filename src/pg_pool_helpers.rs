//! M2 自助开通向导：PG 池公共 helper。
//!
//! 抽这一层的目的：
//!   - `pg_pool_handlers`（超管 CRUD）和 `tenant_handlers::provision_project`
//!     都需要"用 pool 的 admin 凭据连那台 PG，做点事"——CREATE DATABASE、
//!     SELECT 1 验证、跑模板 DDL——这些公共连接 / 池查找逻辑放这里，
//!     避免两个 handler 各自重复实现。
//!   - 把"明文 admin 密码只在这一层短暂解密"集中，方便后面真的要做密钥
//!     轮换 / Vault 集成时只改一处。
//!
//! 不在这里做的事：
//!   - 鉴权：调用方（handler）自己做 require_super_admin / require_xxx；
//!   - 业务校验（slug 唯一、模板存在等）：调用方做；
//!   - 写入 management.* 表：调用方做。

use crate::crypto::decrypt_secret;
use crate::error::{AppError, Result};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::time::Duration;

/// 直连 PG 的 admin 凭据（来自 PG 池解密或 wizard 手动填写）。
#[derive(Debug, Clone)]
pub struct PgAdminCredentials {
    pub db_host: String,
    pub db_port: i32,
    pub admin_user: String,
    pub admin_password: String,
}

impl PgAdminCredentials {
    pub fn validate(&self) -> Result<()> {
        if self.db_host.trim().is_empty() {
            return Err(AppError::InvalidQuery("db_host 不能为空".to_string()));
        }
        if self.admin_user.trim().is_empty() {
            return Err(AppError::InvalidQuery("admin_user 不能为空".to_string()));
        }
        if self.admin_password.is_empty() {
            return Err(AppError::InvalidQuery(
                "admin_password 不能为空".to_string(),
            ));
        }
        if !(1..=65535).contains(&self.db_port) {
            return Err(AppError::InvalidQuery(
                "db_port 必须在 1 ~ 65535".to_string(),
            ));
        }
        Ok(())
    }
}

/// PG 池条目（用户视角能看到的安全子集——不含密码字段）。
#[derive(Debug, Clone)]
pub struct PgPoolEntry {
    pub id: i32,
    pub name: String,
    pub db_host: String,
    pub db_port: i32,
    pub admin_user: String,
    pub note: Option<String>,
    pub is_active: bool,
}

/// 平台自身 DATABASE_URL 解析出的 PG 实例（不含凭据）。
#[derive(Debug, Clone)]
pub struct PlatformPgInstance {
    pub db_host: String,
    pub db_port: i32,
    pub management_db_name: String,
}

/// 从连接串解析出的凭据 + 库名。
#[derive(Debug, Clone)]
struct ParsedPgUrl {
    creds: PgAdminCredentials,
    database_name: String,
}

/// 内部用：含解密后明文密码的完整条目。
/// **绝不能** Serialize / 暴露给前端。
struct PgPoolEntryWithSecret {
    entry: PgPoolEntry,
    admin_password_plain: String,
}

/// 列出所有池条目（不论 is_active）。供超管页表格用。
pub async fn list_all_pools(pool: &PgPool) -> Result<Vec<PgPoolEntry>> {
    let rows = sqlx::query(
        r#"
        SELECT id, name, db_host, db_port, admin_user, note, is_active
        FROM management.pg_pools
        ORDER BY id ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.iter().map(row_to_entry).collect())
}

/// 列出 active 池。供用户视角的 wizard 用。
pub async fn list_active_pools(pool: &PgPool) -> Result<Vec<PgPoolEntry>> {
    let rows = sqlx::query(
        r#"
        SELECT id, name, db_host, db_port, admin_user, note, is_active
        FROM management.pg_pools
        WHERE is_active = true
        ORDER BY id ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.iter().map(row_to_entry).collect())
}

/// 解析平台管理库连接串，得到 host/port/库名（不含密码）。
pub fn platform_instance_from_env() -> Result<PlatformPgInstance> {
    let url = provision_connection_url()?;
    let parsed = parse_pg_connection_url(&url)?;
    Ok(PlatformPgInstance {
        db_host: parsed.creds.db_host,
        db_port: parsed.creds.db_port,
        management_db_name: parsed.database_name,
    })
}

/// provision 时用的 admin 凭据：优先 `PROVISION_PG_URL`，否则从 `DATABASE_URL` 派生（连 postgres 库）。
pub fn platform_provision_credentials() -> Result<PgAdminCredentials> {
    let url = provision_connection_url()?;
    let parsed = parse_pg_connection_url(&url)?;
    parsed.creds.validate()?;
    Ok(parsed.creds)
}

/// 探活：凭据能否连上 PG 的 postgres 库（开通向导 `provision_ready` 用）。
pub async fn probe_platform_provision() -> Result<()> {
    let creds = platform_provision_credentials()?;
    test_connection(&creds).await
}

/// 启动时：若 PG 池尚无与平台同 host:port 的条目，自动注册一条（运维免手工录入）。
pub async fn ensure_platform_pg_pool_entry(pool: &PgPool) -> Result<()> {
    use crate::crypto::encrypt_secret;

    let creds = platform_provision_credentials()?;
    let platform = platform_instance_from_env()?;
    let pools = list_active_pools(pool).await?;
    if pools
        .iter()
        .any(|e| same_pg_endpoint(&e.db_host, e.db_port, &platform.db_host, platform.db_port))
    {
        return Ok(());
    }

    let encrypted = encrypt_secret(&creds.admin_password)
        .map_err(|e| AppError::Internal(format!("平台 PG 池密码加密失败: {}", e)))?;

    let name = "platform-default";
    sqlx::query(
        r#"
        INSERT INTO management.pg_pools
            (name, db_host, db_port, admin_user, admin_password_encrypted, note, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, true)
        ON CONFLICT (name) DO UPDATE SET
            db_host = EXCLUDED.db_host,
            db_port = EXCLUDED.db_port,
            admin_user = EXCLUDED.admin_user,
            admin_password_encrypted = EXCLUDED.admin_password_encrypted,
            note = EXCLUDED.note,
            is_active = true
        "#,
    )
    .bind(name)
    .bind(&platform.db_host)
    .bind(platform.db_port)
    .bind(&creds.admin_user)
    .bind(&encrypted)
    .bind(format!(
        "自动同步自平台 DATABASE_URL / PROVISION_PG_URL（管理库 {}）",
        platform.management_db_name
    ))
    .execute(pool)
    .await?;

    tracing::info!(
        "已自动注册/更新 PG 池 '{}'（{}:{}）供开通向导使用",
        name,
        platform.db_host,
        platform.db_port
    );
    Ok(())
}

pub fn same_pg_endpoint(a_host: &str, a_port: i32, b_host: &str, b_port: i32) -> bool {
    normalize_pg_host(a_host) == normalize_pg_host(b_host) && a_port == b_port
}

fn provision_connection_url() -> Result<String> {
    if let Ok(url) = std::env::var("PROVISION_PG_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let db_url = std::env::var("DATABASE_URL")
        .map_err(|_| AppError::Internal("DATABASE_URL 未设置，无法使用平台 PG 实例".to_string()))?;
    let parsed = parse_pg_connection_url(&db_url)?;
    Ok(format!(
        "postgresql://{}:{}@{}:{}/postgres",
        url_encode(&parsed.creds.admin_user),
        url_encode(&parsed.creds.admin_password),
        parsed.creds.db_host,
        parsed.creds.db_port,
    ))
}

fn normalize_pg_host(host: &str) -> String {
    host.trim()
        .trim_matches(&['[', ']'][..])
        .to_ascii_lowercase()
}

/// 解析 `postgresql://` / `postgres://` 连接串。
fn parse_pg_connection_url(raw: &str) -> Result<ParsedPgUrl> {
    let url = raw.trim();
    let rest = url
        .strip_prefix("postgresql://")
        .or_else(|| url.strip_prefix("postgres://"))
        .ok_or_else(|| {
            AppError::Internal(format!(
                "无效的 PG 连接串（需 postgresql:// 或 postgres:// 开头）: {}",
                redact_connection_url(url)
            ))
        })?;

    let at = rest.rfind('@').ok_or_else(|| {
        AppError::Internal(format!(
            "无效的 PG 连接串（缺少 @）: {}",
            redact_connection_url(url)
        ))
    })?;
    let auth = &rest[..at];
    let host_db = &rest[at + 1..];

    let (user, password) = match auth.split_once(':') {
        Some((u, p)) => (url_decode(u), url_decode(p)),
        None => (url_decode(auth), String::new()),
    };

    let (host_port, dbname) = host_db
        .split_once('/')
        .map(|(hp, db)| (hp, db.split('?').next().unwrap_or(db)))
        .unwrap_or((host_db, "postgres"));

    let (host, port) = if host_port.starts_with('[') {
        let end = host_port.find(']').unwrap_or(host_port.len());
        let host = host_port[1..end].to_string();
        let port = host_port[end + 1..]
            .strip_prefix(':')
            .and_then(|p| p.parse::<i32>().ok())
            .unwrap_or(5432);
        (host, port)
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !h.is_empty() => {
                (h.to_string(), p.parse().unwrap_or(5432))
            }
            _ => (host_port.to_string(), 5432),
        }
    };

    if user.is_empty() {
        return Err(AppError::Internal("PG 连接串缺少用户名".to_string()));
    }

    Ok(ParsedPgUrl {
        creds: PgAdminCredentials {
            db_host: host,
            db_port: port,
            admin_user: user,
            admin_password: password,
        },
        database_name: if dbname.is_empty() {
            "postgres".to_string()
        } else {
            dbname.to_string()
        },
    })
}

fn redact_connection_url(url: &str) -> String {
    if let Some(at) = url.rfind('@') {
        if let Some(scheme_end) = url.find("://") {
            return format!("{}://***@{}", &url[..scheme_end + 3], &url[at + 1..]);
        }
    }
    "***".to_string()
}

pub async fn get_pool(pool: &PgPool, id: i32) -> Result<PgPoolEntry> {
    let row = sqlx::query(
        r#"
        SELECT id, name, db_host, db_port, admin_user, note, is_active
        FROM management.pg_pools
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("PG 池 {} 不存在", id)))?;

    Ok(row_to_entry(&row))
}

/// 拿完整条目（含明文密码）；仅本 module 内部使用。
async fn get_pool_with_secret(pool: &PgPool, id: i32) -> Result<PgPoolEntryWithSecret> {
    let row = sqlx::query(
        r#"
        SELECT id, name, db_host, db_port, admin_user, admin_password_encrypted, note, is_active
        FROM management.pg_pools
        WHERE id = $1 AND is_active = true
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("PG 池 {} 不存在或已停用", id)))?;

    let encrypted: String = row.try_get("admin_password_encrypted")?;
    let plain = decrypt_secret(&encrypted)
        .map_err(|e| AppError::Internal(format!("PG 池 {} 的 admin 密码解密失败: {}", id, e)))?;

    Ok(PgPoolEntryWithSecret {
        entry: row_to_entry(&row),
        admin_password_plain: plain,
    })
}

/// 用 admin 凭据建一条短期 sqlx 连接（默认连 `postgres` 库）。
/// 调用方应当在用完后立刻 drop pool 让连接释放，不要把它当长期池用。
async fn admin_connect_creds(creds: &PgAdminCredentials, target_db: &str) -> Result<PgPool> {
    let conn_str = format!(
        "postgres://{}:{}@{}:{}/{}",
        url_encode(&creds.admin_user),
        url_encode(&creds.admin_password),
        creds.db_host,
        creds.db_port,
        url_encode(target_db),
    );

    PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(8))
        .connect(&conn_str)
        .await
        .map_err(|e| {
            AppError::Internal(format!(
                "连接到 PG（{}:{}/{}）失败: {}",
                creds.db_host, creds.db_port, target_db, e
            ))
        })
}

async fn admin_connect(entry: &PgPoolEntryWithSecret, target_db: &str) -> Result<PgPool> {
    admin_connect_creds(
        &PgAdminCredentials {
            db_host: entry.entry.db_host.clone(),
            db_port: entry.entry.db_port,
            admin_user: entry.entry.admin_user.clone(),
            admin_password: entry.admin_password_plain.clone(),
        },
        target_db,
    )
    .await
}

/// 测试连接：用 admin 凭据连默认 `postgres` 库跑 `SELECT 1`。
pub async fn test_connection(creds: &PgAdminCredentials) -> Result<()> {
    creds.validate()?;
    let temp = admin_connect_creds(creds, "postgres").await?;
    sqlx::query("SELECT 1").execute(&temp).await.map_err(|e| {
        AppError::Internal(format!(
            "PG 探活 SELECT 1 失败（{}:{}）: {}",
            creds.db_host, creds.db_port, e
        ))
    })?;
    Ok(())
}

/// 测试连接：用 admin 凭据连默认 `postgres` 库跑 `SELECT 1`。
/// 返回 Ok 表示连得通；Err 携带原始错误用于 UI 展示。
pub async fn test_pool(pool: &PgPool, id: i32) -> Result<()> {
    let entry = get_pool_with_secret(pool, id).await?;
    let temp = admin_connect(&entry, "postgres").await?;
    sqlx::query("SELECT 1")
        .execute(&temp)
        .await
        .map_err(|e| AppError::Internal(format!("PG 池 {} 探活 SELECT 1 失败: {}", id, e)))?;
    Ok(())
}

/// 在指定 PG 上 CREATE DATABASE。返回**实际**创建的库名（可能带随机后缀）。
pub async fn create_database_with_credentials(
    creds: &PgAdminCredentials,
    requested_db_name: &str,
) -> Result<String> {
    creds.validate()?;
    let temp = admin_connect_creds(creds, "postgres").await?;

    if !is_valid_db_name(requested_db_name) {
        return Err(AppError::InvalidQuery(format!(
            "数据库名 '{}' 非法（必须 1-63 字符，字母/数字/下划线，首字符不能是数字）",
            requested_db_name
        )));
    }

    let mut attempt_name = requested_db_name.to_string();
    for retry in 0..4_usize {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)")
                .bind(&attempt_name)
                .fetch_one(&temp)
                .await?;

        if !exists {
            let sql = format!(r#"CREATE DATABASE "{}" TEMPLATE template0"#, attempt_name);
            sqlx::query(&sql).execute(&temp).await.map_err(|e| {
                AppError::Internal(format!(
                    "CREATE DATABASE \"{}\" 失败（{}:{}）: {}",
                    attempt_name, creds.db_host, creds.db_port, e
                ))
            })?;
            tracing::info!(
                "M2 provisioning: created database {} on {}:{} (attempt {})",
                attempt_name,
                creds.db_host,
                creds.db_port,
                retry + 1
            );
            return Ok(attempt_name);
        }

        attempt_name = format!("{}_{}", requested_db_name, random_suffix(6));
    }

    Err(AppError::Internal(format!(
        "CREATE DATABASE 重试 4 次仍冲突（基础名 {}，{}:{}）",
        requested_db_name, creds.db_host, creds.db_port
    )))
}

/// 在指定 pool 上 CREATE DATABASE。返回**实际**创建的库名（可能带随机后缀）。
///
/// 实现：
///   1. 连到 admin 默认 `postgres` 库
///   2. 检查 `pg_database` 是否已有同名库；若有，给请求名加 6 字符随机后缀重试，最多 3 次
///   3. `CREATE DATABASE "..." TEMPLATE template0` —— 用 template0 避开
///      "template1 is being accessed" 报错（参考 tenant_handlers::create_tenant 的处理）
///   4. 返回实际库名
///
/// 不写 management.* 表（调用方自己写）。
#[allow(dead_code)]
pub async fn create_database_on_pool(
    pool: &PgPool,
    pool_id: i32,
    requested_db_name: &str,
) -> Result<String> {
    let entry = get_pool_with_secret(pool, pool_id).await?;
    create_database_with_credentials(
        &PgAdminCredentials {
            db_host: entry.entry.db_host.clone(),
            db_port: entry.entry.db_port,
            admin_user: entry.entry.admin_user.clone(),
            admin_password: entry.admin_password_plain,
        },
        requested_db_name,
    )
    .await
}

// ─── P1.1：每项目独立 PG 登录角色 ──────────────────────────────────

/// 是否给每个项目库创建专属登录角色（而非复用 admin 凭据）。
///
/// `PROVISION_PER_PROJECT_ROLE`：
///   - `off` / `false` / `0`：关闭，沿用 admin 凭据（旧行为）；
///   - `require` / `strict`：强制；admin 无 CREATEROLE 权限时直接报错并回滚建库；
///   - 其它（含未设置）：`auto`——尝试创建，失败则回退 admin 凭据并告警。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PerProjectRoleMode {
    Off,
    Auto,
    Require,
}

pub fn per_project_role_mode() -> PerProjectRoleMode {
    match std::env::var("PROVISION_PER_PROJECT_ROLE")
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("off") | Some("false") | Some("0") | Some("no") => PerProjectRoleMode::Off,
        Some("require") | Some("required") | Some("strict") => PerProjectRoleMode::Require,
        _ => PerProjectRoleMode::Auto,
    }
}

/// 新建的项目专属登录角色 + 明文密码（仅在内存里短暂存在，随后加密写库）。
#[derive(Debug, Clone)]
pub struct ProvisionedRole {
    pub user: String,
    pub password: String,
}

/// 在 admin 所在 PG 上为某项目库创建专属 LOGIN 角色，并把该库的全部权限授予它。
///
/// 步骤（admin 身份）：
///   1. 连 `postgres` 库 → 生成唯一角色名 → `CREATE ROLE ... LOGIN PASSWORD`
///   2. `GRANT ALL PRIVILEGES ON DATABASE` 把库级权限给角色
///   3. 连项目库 → `GRANT ALL ON SCHEMA public` + 设置 default privileges，
///      使后续（admin 跑模板 DDL）建出的对象自动授权给该角色
///
/// 该角色**只**对这一个项目库有权限，对管理库 / 其它项目库无访问权。
pub async fn create_project_role(
    admin: &PgAdminCredentials,
    db_name: &str,
    role_base: &str,
) -> Result<ProvisionedRole> {
    admin.validate()?;
    if !is_valid_db_name(db_name) {
        return Err(AppError::InvalidQuery(format!(
            "拒绝为非法库名 '{}' 创建角色",
            db_name
        )));
    }

    let temp = admin_connect_creds(admin, "postgres").await?;

    let base = build_role_base(role_base);
    let mut role = base.clone();
    for retry in 0..5_usize {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1)")
                .bind(&role)
                .fetch_one(&temp)
                .await?;
        if !exists {
            break;
        }
        if retry == 4 {
            return Err(AppError::Internal(format!(
                "无法为项目库 {} 生成唯一角色名（基础名 {}）",
                db_name, base
            )));
        }
        role = format!("{}_{}", base, random_suffix(4));
    }

    if !is_valid_db_name(&role) {
        return Err(AppError::Internal(format!("生成的角色名非法: {}", role)));
    }

    // 密码取纯字母数字，避免在 CREATE ROLE 字面量里出现需要转义的引号。
    let password = random_password(32);

    let create_sql = format!(r#"CREATE ROLE "{}" LOGIN PASSWORD '{}'"#, role, password);
    sqlx::query(&create_sql).execute(&temp).await.map_err(|e| {
        AppError::Internal(format!(
            "CREATE ROLE \"{}\" 失败（{}:{}）: {}",
            role, admin.db_host, admin.db_port, e
        ))
    })?;

    let grant_db = format!(
        r#"GRANT ALL PRIVILEGES ON DATABASE "{}" TO "{}""#,
        db_name, role
    );
    if let Err(e) = sqlx::query(&grant_db).execute(&temp).await {
        // 角色已建出来：补偿 drop 再返回，避免遗留无用角色。
        let _ = sqlx::query(&format!(r#"DROP ROLE IF EXISTS "{}""#, role))
            .execute(&temp)
            .await;
        return Err(AppError::Internal(format!(
            "GRANT ON DATABASE \"{}\" TO \"{}\" 失败: {}",
            db_name, role, e
        )));
    }
    drop(temp);

    // 连项目库设 schema 权限 + default privileges（后续 admin 建对象自动授权）。
    let dbconn = admin_connect_creds(admin, db_name).await?;
    let stmts = [
        format!(r#"GRANT ALL ON SCHEMA public TO "{}""#, role),
        format!(
            r#"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "{}""#,
            role
        ),
        format!(
            r#"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "{}""#,
            role
        ),
        format!(
            r#"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "{}""#,
            role
        ),
    ];
    for stmt in stmts {
        sqlx::query(&stmt).execute(&dbconn).await.map_err(|e| {
            AppError::Internal(format!(
                "为角色 {} 授予 schema 权限失败（{}）: {}",
                role, db_name, e
            ))
        })?;
    }

    tracing::info!(
        "M2 provisioning: created project role {} for db {} on {}:{}",
        role,
        db_name,
        admin.db_host,
        admin.db_port
    );

    Ok(ProvisionedRole {
        user: role,
        password,
    })
}

/// 模板 DDL 跑完后，把库内**已存在**对象的权限补授给项目角色（幂等，兜底用）。
pub async fn grant_existing_objects_to_role(
    admin: &PgAdminCredentials,
    db_name: &str,
    role: &str,
) -> Result<()> {
    if !is_valid_db_name(role) {
        return Err(AppError::Internal(format!("非法角色名: {}", role)));
    }
    let dbconn = admin_connect_creds(admin, db_name).await?;
    let stmts = [
        format!(r#"GRANT ALL ON ALL TABLES IN SCHEMA public TO "{}""#, role),
        format!(
            r#"GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "{}""#,
            role
        ),
        format!(
            r#"GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "{}""#,
            role
        ),
    ];
    for stmt in stmts {
        sqlx::query(&stmt).execute(&dbconn).await.map_err(|e| {
            AppError::Internal(format!(
                "为角色 {} 补授已有对象权限失败（{}）: {}",
                role, db_name, e
            ))
        })?;
    }
    Ok(())
}

/// 回滚：删除项目角色。应在已 DROP DATABASE 之后调用（此时角色不再 own 任何对象）。
pub async fn drop_project_role(admin: &PgAdminCredentials, role: &str) -> Result<()> {
    if !is_valid_db_name(role) {
        return Err(AppError::Internal(format!("拒绝删除非法角色名: {}", role)));
    }
    let temp = admin_connect_creds(admin, "postgres").await?;
    let sql = format!(r#"DROP ROLE IF EXISTS "{}""#, role);
    sqlx::query(&sql)
        .execute(&temp)
        .await
        .map_err(|e| AppError::Internal(format!("DROP ROLE \"{}\" 失败: {}", role, e)))?;
    tracing::warn!("M2 provisioning 回滚：已删除项目角色 {}", role);
    Ok(())
}

/// 角色名基础：项目库名截断到 50 字符 + `_app`（保证 ≤ 63 且为合法标识符）。
fn build_role_base(db_name: &str) -> String {
    let max_base = 50;
    let truncated = if db_name.len() > max_base {
        &db_name[..max_base]
    } else {
        db_name
    };
    format!("{}_app", truncated)
}

/// 删除数据库（provisioning 失败时的补偿/回滚用）。
pub async fn drop_database_with_credentials(
    creds: &PgAdminCredentials,
    db_name: &str,
) -> Result<()> {
    if !is_valid_db_name(db_name) {
        return Err(AppError::InvalidQuery(format!(
            "拒绝删除非法库名 '{}'",
            db_name
        )));
    }

    let temp = admin_connect_creds(creds, "postgres").await?;
    let sql = format!(r#"DROP DATABASE IF EXISTS "{}""#, db_name);
    sqlx::query(&sql).execute(&temp).await.map_err(|e| {
        AppError::Internal(format!(
            "DROP DATABASE \"{}\" 失败（{}:{}）: {}",
            db_name, creds.db_host, creds.db_port, e
        ))
    })?;

    tracing::warn!(
        "M2 provisioning 回滚：已删除孤儿库 {} ({}:{})",
        db_name,
        creds.db_host,
        creds.db_port
    );
    Ok(())
}

/// 在指定 pool 上删除数据库（provisioning 失败时的补偿/回滚用）。
///
/// 仅用于「刚 `create_database_on_pool` 成功、但后续 management 写库失败」的孤儿库清理。
/// 用 `DROP DATABASE IF EXISTS`：刚建的库没有连接，普通 DROP 即可，幂等安全。
#[allow(dead_code)]
pub async fn drop_database_on_pool(pool: &PgPool, pool_id: i32, db_name: &str) -> Result<()> {
    let entry = get_pool_with_secret(pool, pool_id).await?;
    drop_database_with_credentials(
        &PgAdminCredentials {
            db_host: entry.entry.db_host.clone(),
            db_port: entry.entry.db_port,
            admin_user: entry.entry.admin_user.clone(),
            admin_password: entry.admin_password_plain,
        },
        db_name,
    )
    .await
}

/// 在指定库内执行模板 DDL（事务包裹）。
pub async fn apply_template_ddl_with_credentials(
    creds: &PgAdminCredentials,
    db_name: &str,
    ddl_sql: &str,
) -> Result<()> {
    if ddl_sql.trim().is_empty() {
        return Ok(());
    }

    let temp = admin_connect_creds(creds, db_name).await?;

    let mut tx = temp.begin().await?;
    sqlx::query(ddl_sql).execute(&mut *tx).await.map_err(|e| {
        AppError::Internal(format!(
            "在库 {}（{}:{}）上跑模板 DDL 失败: {}",
            db_name, creds.db_host, creds.db_port, e
        ))
    })?;
    tx.commit().await?;

    tracing::info!(
        "M2 provisioning: applied template DDL on {}/{}",
        creds.db_host,
        db_name
    );
    Ok(())
}

/// 在指定 pool 上、指定库内执行模板 DDL（事务包裹）。
///
/// `ddl_sql` 为空字符串时直接 Ok 返回（blank 模板路径）。
#[allow(dead_code)]
pub async fn apply_template_ddl_on_pool(
    pool: &PgPool,
    pool_id: i32,
    db_name: &str,
    ddl_sql: &str,
) -> Result<()> {
    if ddl_sql.trim().is_empty() {
        return Ok(());
    }

    let entry = get_pool_with_secret(pool, pool_id).await?;
    apply_template_ddl_with_credentials(
        &PgAdminCredentials {
            db_host: entry.entry.db_host.clone(),
            db_port: entry.entry.db_port,
            admin_user: entry.entry.admin_user.clone(),
            admin_password: entry.admin_password_plain,
        },
        db_name,
        ddl_sql,
    )
    .await
}

// ─── helpers ───────────────────────────────────────────────────────

fn row_to_entry(row: &sqlx::postgres::PgRow) -> PgPoolEntry {
    PgPoolEntry {
        id: row.get("id"),
        name: row.get("name"),
        db_host: row.get("db_host"),
        db_port: row.get("db_port"),
        admin_user: row.get("admin_user"),
        note: row.try_get("note").ok().flatten(),
        is_active: row.get("is_active"),
    }
}

/// PG identifier 规则的子集（更严）：1-63 字符，[A-Za-z_][A-Za-z0-9_]*。
/// 不允许引号、空格、`-`——避免后面拼接 SQL 时的转义麻烦。
pub fn is_valid_db_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 63 {
        return false;
    }
    let first = match name.chars().next() {
        Some(c) => c,
        None => return false,
    };
    if !first.is_ascii_alphabetic() && first != '_' {
        return false;
    }
    name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 把 user/password 里的特殊字符做 URL 编码，避免连接字符串解析爆炸。
/// 与 sso.rs 的 module-local urlencoding 同思路——避免新增依赖。
fn url_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn random_suffix(n: usize) -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..n)
        .map(|_| {
            let idx = rng.gen_range(0..CHARS.len());
            CHARS[idx] as char
        })
        .collect()
}

/// 生成纯字母数字密码（无引号 / 特殊字符），可安全嵌入 `CREATE ROLE ... PASSWORD '...'`。
fn random_password(n: usize) -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..n)
        .map(|_| {
            let idx = rng.gen_range(0..CHARS.len());
            CHARS[idx] as char
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_name_validation() {
        assert!(is_valid_db_name("project_blank"));
        assert!(is_valid_db_name("a"));
        assert!(is_valid_db_name("_underscored"));
        assert!(!is_valid_db_name(""));
        assert!(!is_valid_db_name("1starts_with_number"));
        assert!(!is_valid_db_name("has-dash"));
        assert!(!is_valid_db_name("has space"));
        assert!(!is_valid_db_name(&"x".repeat(64)));
    }

    #[test]
    fn suffix_lengths() {
        let s = random_suffix(6);
        assert_eq!(s.len(), 6);
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn parse_pg_url_basic() {
        let parsed =
            parse_pg_connection_url("postgresql://onebase:secret%40word@10.0.5.33:5432/onebase")
                .unwrap();
        assert_eq!(parsed.creds.db_host, "10.0.5.33");
        assert_eq!(parsed.creds.db_port, 5432);
        assert_eq!(parsed.creds.admin_user, "onebase");
        assert_eq!(parsed.creds.admin_password, "secret@word");
        assert_eq!(parsed.database_name, "onebase");
    }

    #[test]
    fn same_endpoint_normalizes_host() {
        assert!(same_pg_endpoint("10.0.5.33", 5432, "10.0.5.33", 5432));
        assert!(same_pg_endpoint("LOCALHOST", 5432, "localhost", 5432));
        assert!(!same_pg_endpoint("10.0.5.33", 5432, "10.0.5.34", 5432));
    }

    #[test]
    fn role_base_appends_app_and_truncates() {
        assert_eq!(build_role_base("my_blog"), "my_blog_app");
        let long = "x".repeat(60);
        let base = build_role_base(&long);
        assert!(base.len() <= 63);
        assert!(base.ends_with("_app"));
        assert!(is_valid_db_name(&base));
    }

    #[test]
    fn random_password_is_alphanumeric() {
        let p = random_password(32);
        assert_eq!(p.len(), 32);
        assert!(p.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn per_project_role_mode_parses() {
        // 默认（未设置）→ Auto；这里只验证解析分支不 panic。
        let _ = per_project_role_mode();
    }
}
