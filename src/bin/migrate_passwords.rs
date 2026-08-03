//! 一次性密码迁移工具
//!
//! 把 `management.tenant_databases.db_password_encrypted` 中所有非 `v2:` 前缀
//! （即旧格式：`ENCRYPTED:<plain>` 或裸 base64）的密码用 AES-256-GCM 重新加密为
//! `v2:<base64(nonce || ciphertext+tag)>`。
//!
//! 用法：
//!     # 容器里：
//!     /app/onebase-migrate-passwords
//!
//!     # 本地：
//!     DATABASE_URL=... ENCRYPTION_KEY=... cargo run --bin migrate_passwords
//!
//! - 工具是幂等的：v2: 行直接跳过；
//! - 成功输出 `OK -> v2`，失败行打印 FAIL 并继续；
//! - 工具不打印明文密码，只打印 id / connection_name / 状态；
//! - 全部失败为 0 才返回 exit code 0。

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::Engine;
use sqlx::{postgres::PgPoolOptions, Row};

const PREFIX_V2: &str = "v2:";
const PREFIX_LEGACY_PLAIN: &str = "ENCRYPTED:";
const NONCE_LEN: usize = 12;
const GCM_TAG_LEN: usize = 16;

fn load_key() -> [u8; 32] {
    let raw = std::env::var("ENCRYPTION_KEY").unwrap_or_default();
    if raw.is_empty() {
        panic!("ENCRYPTION_KEY 未设置（必须与运行中的 onebase 进程使用同一密钥）");
    }
    let key = base64::engine::general_purpose::STANDARD
        .decode(&raw)
        .expect("ENCRYPTION_KEY 不是合法 base64");
    if key.len() != 32 {
        panic!(
            "ENCRYPTION_KEY 解码后必须为 32 字节，实际 {} 字节",
            key.len()
        );
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&key);
    k
}

fn encrypt_v2(key: &[u8; 32], plain: &str) -> String {
    let cipher = Aes256Gcm::new(key.as_slice().into());
    let nonce_bytes = Aes256Gcm::generate_nonce(&mut OsRng);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plain.as_bytes())
        .expect("AES-GCM 加密失败");
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    format!(
        "{}{}",
        PREFIX_V2,
        base64::engine::general_purpose::STANDARD.encode(&out)
    )
}

fn decrypt_legacy(key: &[u8; 32], encoded: &str) -> Result<String, String> {
    if let Some(rest) = encoded.strip_prefix(PREFIX_V2) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(rest)
            .map_err(|e| format!("v2 base64 解码失败: {}", e))?;
        if bytes.len() < NONCE_LEN + GCM_TAG_LEN {
            return Err("v2 密文长度无效".into());
        }
        let (n, ct) = bytes.split_at(NONCE_LEN);
        let cipher = Aes256Gcm::new(key.as_slice().into());
        let plain = cipher
            .decrypt(Nonce::from_slice(n), ct)
            .map_err(|e| format!("v2 解密失败: {}", e))?;
        return String::from_utf8(plain).map_err(|e| format!("UTF-8 解码失败: {}", e));
    }
    if let Some(rest) = encoded.strip_prefix(PREFIX_LEGACY_PLAIN) {
        return Ok(rest.to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("旧 base64 解码失败: {}", e))?;
    String::from_utf8(bytes).map_err(|e| format!("旧 base64 内容非 UTF-8: {}", e))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let database_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL 必须设置（或在 .env 中）");

    let key = load_key();

    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await?;

    println!("=== Onebase 密码迁移到 v2 格式 ===");

    let rows = sqlx::query(
        "SELECT id, connection_name, db_password_encrypted \
         FROM management.tenant_databases \
         ORDER BY id",
    )
    .fetch_all(&pool)
    .await?;

    let mut total = 0u64;
    let mut migrated = 0u64;
    let mut already_v2 = 0u64;
    let mut failed = 0u64;

    for row in rows {
        total += 1;
        let id: i32 = row.get("id");
        let name: String = row.get("connection_name");
        let cur: String = row.get("db_password_encrypted");

        if cur.starts_with(PREFIX_V2) {
            already_v2 += 1;
            println!("[{:>4}] skip   v2  | {}", id, name);
            continue;
        }

        let plain = match decrypt_legacy(&key, &cur) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[{:>4}] FAIL  解密失败 | {} | {}", id, name, e);
                failed += 1;
                continue;
            }
        };

        let new_enc = encrypt_v2(&key, &plain);

        let res = sqlx::query(
            "UPDATE management.tenant_databases SET db_password_encrypted = $1 WHERE id = $2",
        )
        .bind(&new_enc)
        .bind(id)
        .execute(&pool)
        .await;

        match res {
            Ok(_) => {
                migrated += 1;
                println!("[{:>4}] OK    -> v2 | {}", id, name);
            }
            Err(e) => {
                eprintln!("[{:>4}] FAIL  写库失败 | {} | {}", id, name, e);
                failed += 1;
            }
        }
    }

    println!(
        "=== 完成：总计 {} | 已迁移 {} | 已为 v2 {} | 失败 {} ===",
        total, migrated, already_v2, failed
    );

    if failed > 0 {
        std::process::exit(1);
    }
    Ok(())
}
