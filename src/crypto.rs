//! 对称加密：用于租户数据库密码、外部 token 等敏感字段
//!
//! - 算法：AES-256-GCM（authenticated encryption，防篡改）
//! - 密钥：来自环境变量 `ENCRYPTION_KEY`（base64 编码 32 字节）
//! - 输出格式：`v2:<base64(nonce(12B) || ciphertext+tag)>`
//!
//! 兼容历史格式（仅解密时支持，加密一律产出 v2）：
//! - `ENCRYPTED:<plain>` 字面量前缀
//! - 裸 base64（早期把 base64 当"加密"的实现）
//!
//! 启动时若 `ENCRYPTION_KEY` 未设置且非 dev：直接 panic。

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::Engine;
use once_cell::sync::Lazy;
use std::env;

use crate::error::AppError;

const NONCE_LEN: usize = 12;
const GCM_TAG_LEN: usize = 16;
const PREFIX_V2: &str = "v2:";
const PREFIX_LEGACY_PLAIN: &str = "ENCRYPTED:";

static ENCRYPTION_KEY: Lazy<[u8; 32]> = Lazy::new(|| {
    let raw = env::var("ENCRYPTION_KEY").unwrap_or_default();
    let is_dev = env::var("RUST_ENV").unwrap_or_default() == "development";

    if raw.is_empty() {
        if is_dev {
            tracing::warn!("ENCRYPTION_KEY 未设置，使用开发默认值（仅限开发环境！）");
            return [0xAB; 32];
        }
        panic!("ENCRYPTION_KEY 未设置。生产环境必须提供 base64 编码的 32 字节密钥（可用 `openssl rand -base64 32` 生成）。");
    }

    let key = base64::engine::general_purpose::STANDARD
        .decode(&raw)
        .unwrap_or_else(|e| panic!("ENCRYPTION_KEY 解码失败: {}", e));
    if key.len() != 32 {
        panic!(
            "ENCRYPTION_KEY 长度无效：期望 32 字节（base64 解码后），实际 {} 字节",
            key.len()
        );
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&key);
    k
});

/// 强制初始化密钥（用于启动期 fail-fast）
pub fn ensure_initialized() {
    let _ = &*ENCRYPTION_KEY;
}

/// 加密敏感字符串。输出形如 `v2:base64...`。
pub fn encrypt_secret(plain: &str) -> Result<String, AppError> {
    let cipher = Aes256Gcm::new(ENCRYPTION_KEY.as_slice().into());
    let nonce_bytes = Aes256Gcm::generate_nonce(&mut OsRng);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| AppError::Internal(format!("加密失败: {}", e)))?;

    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(format!(
        "{}{}",
        PREFIX_V2,
        base64::engine::general_purpose::STANDARD.encode(&out)
    ))
}

/// 解密敏感字符串。
///
/// 兼容三种历史格式（解密时尝试，按序）：
/// 1. `v2:...`（当前规范）
/// 2. `ENCRYPTED:...`（明文裸接前缀）
/// 3. 裸 base64（早期把 base64 当"加密"）
pub fn decrypt_secret(encoded: &str) -> Result<String, AppError> {
    // 新格式
    if let Some(rest) = encoded.strip_prefix(PREFIX_V2) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(rest)
            .map_err(|e| AppError::Internal(format!("v2 base64 解码失败: {}", e)))?;
        if bytes.len() < NONCE_LEN + GCM_TAG_LEN {
            return Err(AppError::Internal("v2 密文长度无效".into()));
        }
        let (n, ct) = bytes.split_at(NONCE_LEN);
        let cipher = Aes256Gcm::new(ENCRYPTION_KEY.as_slice().into());
        let plain = cipher
            .decrypt(Nonce::from_slice(n), ct)
            .map_err(|e| AppError::Internal(format!("v2 解密失败（密钥可能不匹配）: {}", e)))?;
        return String::from_utf8(plain)
            .map_err(|e| AppError::Internal(format!("UTF-8 解码失败: {}", e)));
    }

    // 旧格式 1：ENCRYPTED:<plain>
    if let Some(rest) = encoded.strip_prefix(PREFIX_LEGACY_PLAIN) {
        tracing::warn!("检测到 ENCRYPTED: 前缀的明文密码，请尽快用 v2 格式重新加密");
        return Ok(rest.to_string());
    }

    // 旧格式 2：裸 base64
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| AppError::Internal(format!("旧 base64 解码失败: {}", e)))?;
    tracing::warn!("检测到裸 base64 密码，请尽快用 v2 格式重新加密");
    Ok(String::from_utf8(bytes).unwrap_or_default())
}

/// 解密兼容版：失败时返回空字符串（用于历史调用方）
pub fn decrypt_secret_lossy(encoded: &str) -> String {
    decrypt_secret(encoded).unwrap_or_else(|e| {
        tracing::error!("密码解密失败: {}", e);
        String::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试时 lock 一个固定密钥（避免不同测试线程读环境变量竞争）
    fn ensure_test_key() {
        // 测试用固定 key（32 字节 0xAB）
        std::env::set_var("RUST_ENV", "development");
        // 触发 Lazy 初始化
        let _ = &*ENCRYPTION_KEY;
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        ensure_test_key();
        let plain = "super-secret-password-123";
        let enc = encrypt_secret(plain).unwrap();
        assert!(enc.starts_with("v2:"));
        let dec = decrypt_secret(&enc).unwrap();
        assert_eq!(dec, plain);
    }

    #[test]
    fn test_encrypt_produces_distinct_ciphertext_for_same_plain() {
        ensure_test_key();
        let a = encrypt_secret("foo").unwrap();
        let b = encrypt_secret("foo").unwrap();
        assert_ne!(a, b, "每次加密应使用不同 nonce 产生不同密文");
    }

    #[test]
    fn test_decrypt_legacy_plain_prefix() {
        ensure_test_key();
        let v = "ENCRYPTED:hello123";
        assert_eq!(decrypt_secret(v).unwrap(), "hello123");
    }

    #[test]
    fn test_decrypt_legacy_bare_base64() {
        ensure_test_key();
        let plain = "abc";
        let b64 = base64::engine::general_purpose::STANDARD.encode(plain);
        assert_eq!(decrypt_secret(&b64).unwrap(), plain);
    }

    #[test]
    fn test_decrypt_v2_with_tampered_ciphertext_fails() {
        ensure_test_key();
        let enc = encrypt_secret("original").unwrap();
        // 篡改最后一个字符
        let mut bytes: Vec<u8> = enc.bytes().collect();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes).unwrap();
        assert!(decrypt_secret(&tampered).is_err());
    }
}
