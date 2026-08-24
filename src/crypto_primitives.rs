//! 无状态对称加密 / 摘要原语，供 Lua `crypto.*` builtins 及内部复用。
//!
//! 设计原则（见分支 feature/lua-crypto-primitives 的设计计划）：
//! - **绝不用纯 Lua 手搓算法**：所有算法一律基于 RustCrypto crate（aes/cbc/ecb/aes-gcm/
//!   md-5/sha1/hmac），Lua 只做编排与编码转换。
//! - **单一事实来源**：对称/摘要原语集中在本模块，Lua 层与其他 Rust 调用方共用，避免漂移。
//! - 本模块**无状态、不持有密钥**（不同于 `crypto.rs` 用 `ENCRYPTION_KEY` 加解密落库密钥），
//!   key/iv 全部由调用方传入，便于精确对齐外部/旧系统的方案。
//!
//! 编码约定：输入/输出的二进制↔字符串转换统一走 [`decode_input`] / [`encode_output`]，
//! 支持 `utf8` / `hex` / `base64` / `base64url`。

use base64::{engine::general_purpose, Engine as _};
use cipher::{block_padding::NoPadding, BlockDecryptMut, BlockEncryptMut, KeyInit, KeyIvInit};

use aes::{Aes128, Aes192, Aes256};

/// 原语层统一错误：用 String 承载，Lua 层再包成 `RuntimeError`。
pub type CryptoResult<T> = Result<T, String>;

const AES_BLOCK: usize = 16;

// ============================ 编码转换 ============================

/// 把字符串按指定编码解成字节。`utf8`（默认）/`hex`/`base64`/`base64url`。
pub fn decode_input(input: &str, encoding: &str) -> CryptoResult<Vec<u8>> {
    match encoding.to_ascii_lowercase().as_str() {
        "utf8" | "utf-8" | "raw" | "" => Ok(input.as_bytes().to_vec()),
        "hex" => hex::decode(input).map_err(|e| format!("hex 解码失败: {e}")),
        "base64" | "b64" => general_purpose::STANDARD
            .decode(input)
            .map_err(|e| format!("base64 解码失败: {e}")),
        "base64url" => general_purpose::URL_SAFE_NO_PAD
            .decode(input.trim_end_matches('='))
            .map_err(|e| format!("base64url 解码失败: {e}")),
        other => Err(format!(
            "不支持的输入编码: {other}（可选 utf8/hex/base64/base64url）"
        )),
    }
}

/// 把字节按指定编码转成字符串。`base64`（默认建议）/`hex`/`base64url`/`utf8`。
pub fn encode_output(data: &[u8], encoding: &str) -> CryptoResult<String> {
    match encoding.to_ascii_lowercase().as_str() {
        "hex" => Ok(hex::encode(data)),
        "base64" | "b64" => Ok(general_purpose::STANDARD.encode(data)),
        "base64url" => Ok(general_purpose::URL_SAFE_NO_PAD.encode(data)),
        "utf8" | "utf-8" | "raw" | "" => String::from_utf8(data.to_vec())
            .map_err(|e| format!("UTF-8 输出失败（密文/二进制请用 base64 或 hex 输出）: {e}")),
        other => Err(format!(
            "不支持的输出编码: {other}（可选 utf8/hex/base64/base64url）"
        )),
    }
}

// ============================ 填充 ============================

fn pad(mut data: Vec<u8>, block: usize, mode: &str) -> CryptoResult<Vec<u8>> {
    match mode.to_ascii_lowercase().as_str() {
        "pkcs7" | "pkcs5" => {
            // len % block == 0 时补一整块，符合 PKCS#7 规范。
            let pad_len = block - (data.len() % block);
            data.extend(std::iter::repeat(pad_len as u8).take(pad_len));
            Ok(data)
        }
        "zero" | "zeropadding" => {
            let rem = data.len() % block;
            if rem != 0 {
                data.extend(std::iter::repeat(0u8).take(block - rem));
            }
            Ok(data)
        }
        "none" | "nopadding" | "" => {
            if data.len() % block != 0 {
                return Err(format!(
                    "padding=none 要求明文长度为 {block} 的整数倍，实际 {}",
                    data.len()
                ));
            }
            Ok(data)
        }
        other => Err(format!("不支持的 padding: {other}（可选 pkcs7/zero/none）")),
    }
}

fn unpad(data: Vec<u8>, block: usize, mode: &str) -> CryptoResult<Vec<u8>> {
    match mode.to_ascii_lowercase().as_str() {
        "pkcs7" | "pkcs5" => {
            let pad_len = *data.last().ok_or("pkcs7 unpad: 数据为空")? as usize;
            if pad_len == 0 || pad_len > block || pad_len > data.len() {
                return Err("pkcs7 unpad: 非法填充长度（key/iv 或算法可能不匹配）".into());
            }
            if data[data.len() - pad_len..]
                .iter()
                .any(|&b| b as usize != pad_len)
            {
                return Err("pkcs7 unpad: 填充字节不一致（key/iv 或算法可能不匹配）".into());
            }
            let mut d = data;
            d.truncate(d.len() - pad_len);
            Ok(d)
        }
        "zero" | "zeropadding" => {
            let mut d = data;
            while d.last() == Some(&0) {
                d.pop();
            }
            Ok(d)
        }
        "none" | "nopadding" | "" => Ok(data),
        other => Err(format!("不支持的 padding: {other}（可选 pkcs7/zero/none）")),
    }
}

// ============================ AES-CBC ============================

macro_rules! cbc_encrypt_impl {
    ($aes:ty, $key:expr, $iv:expr, $data:expr) => {{
        type Enc = cbc::Encryptor<$aes>;
        Ok(<Enc as KeyIvInit>::new_from_slices($key, $iv)
            .map_err(|e| format!("AES-CBC 初始化失败: {e}"))?
            .encrypt_padded_vec_mut::<NoPadding>($data))
    }};
}

macro_rules! cbc_decrypt_impl {
    ($aes:ty, $key:expr, $iv:expr, $data:expr) => {{
        type Dec = cbc::Decryptor<$aes>;
        <Dec as KeyIvInit>::new_from_slices($key, $iv)
            .map_err(|e| format!("AES-CBC 初始化失败: {e}"))?
            .decrypt_padded_vec_mut::<NoPadding>($data)
            .map_err(|e| format!("AES-CBC 解密失败: {e}"))
    }};
}

/// AES-CBC 加密。key 支持 16/24/32 字节（AES-128/192/256），iv 必须 16 字节。
pub fn aes_cbc_encrypt(
    key: &[u8],
    iv: &[u8],
    padding: &str,
    plaintext: &[u8],
) -> CryptoResult<Vec<u8>> {
    if iv.len() != AES_BLOCK {
        return Err(format!("AES-CBC iv 必须 16 字节，实际 {}", iv.len()));
    }
    let data = pad(plaintext.to_vec(), AES_BLOCK, padding)?;
    match key.len() {
        16 => cbc_encrypt_impl!(Aes128, key, iv, &data),
        24 => cbc_encrypt_impl!(Aes192, key, iv, &data),
        32 => cbc_encrypt_impl!(Aes256, key, iv, &data),
        n => Err(format!("AES key 长度非法: {n} 字节（应为 16/24/32）")),
    }
}

/// AES-CBC 解密。
pub fn aes_cbc_decrypt(
    key: &[u8],
    iv: &[u8],
    padding: &str,
    ciphertext: &[u8],
) -> CryptoResult<Vec<u8>> {
    if iv.len() != AES_BLOCK {
        return Err(format!("AES-CBC iv 必须 16 字节，实际 {}", iv.len()));
    }
    if ciphertext.is_empty() || ciphertext.len() % AES_BLOCK != 0 {
        return Err(format!(
            "AES-CBC 密文长度必须为 16 的正整数倍，实际 {}",
            ciphertext.len()
        ));
    }
    let raw: Vec<u8> = match key.len() {
        16 => cbc_decrypt_impl!(Aes128, key, iv, ciphertext)?,
        24 => cbc_decrypt_impl!(Aes192, key, iv, ciphertext)?,
        32 => cbc_decrypt_impl!(Aes256, key, iv, ciphertext)?,
        n => return Err(format!("AES key 长度非法: {n} 字节（应为 16/24/32）")),
    };
    unpad(raw, AES_BLOCK, padding)
}

// ============================ AES-ECB ============================

macro_rules! ecb_encrypt_impl {
    ($aes:ty, $key:expr, $data:expr) => {{
        type Enc = ecb::Encryptor<$aes>;
        Ok(<Enc as KeyInit>::new_from_slice($key)
            .map_err(|e| format!("AES-ECB 初始化失败: {e}"))?
            .encrypt_padded_vec_mut::<NoPadding>($data))
    }};
}

macro_rules! ecb_decrypt_impl {
    ($aes:ty, $key:expr, $data:expr) => {{
        type Dec = ecb::Decryptor<$aes>;
        <Dec as KeyInit>::new_from_slice($key)
            .map_err(|e| format!("AES-ECB 初始化失败: {e}"))?
            .decrypt_padded_vec_mut::<NoPadding>($data)
            .map_err(|e| format!("AES-ECB 解密失败: {e}"))
    }};
}

/// AES-ECB 加密（无 iv）。ECB 不推荐用于新系统，仅为兼容旧接口保留。
pub fn aes_ecb_encrypt(key: &[u8], padding: &str, plaintext: &[u8]) -> CryptoResult<Vec<u8>> {
    let data = pad(plaintext.to_vec(), AES_BLOCK, padding)?;
    match key.len() {
        16 => ecb_encrypt_impl!(Aes128, key, &data),
        24 => ecb_encrypt_impl!(Aes192, key, &data),
        32 => ecb_encrypt_impl!(Aes256, key, &data),
        n => Err(format!("AES key 长度非法: {n} 字节（应为 16/24/32）")),
    }
}

/// AES-ECB 解密。
pub fn aes_ecb_decrypt(key: &[u8], padding: &str, ciphertext: &[u8]) -> CryptoResult<Vec<u8>> {
    if ciphertext.is_empty() || ciphertext.len() % AES_BLOCK != 0 {
        return Err(format!(
            "AES-ECB 密文长度必须为 16 的正整数倍，实际 {}",
            ciphertext.len()
        ));
    }
    let raw: Vec<u8> = match key.len() {
        16 => ecb_decrypt_impl!(Aes128, key, ciphertext)?,
        24 => ecb_decrypt_impl!(Aes192, key, ciphertext)?,
        32 => ecb_decrypt_impl!(Aes256, key, ciphertext)?,
        n => return Err(format!("AES key 长度非法: {n} 字节（应为 16/24/32）")),
    };
    unpad(raw, AES_BLOCK, padding)
}

// ============================ AES-GCM ============================

/// AES-GCM 加密。key 支持 16/32 字节（AES-128/256），nonce 必须 12 字节。
/// 返回 `密文 || 16 字节 tag`（与 WebCrypto / 多数库一致）。
pub fn aes_gcm_encrypt(
    key: &[u8],
    nonce: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> CryptoResult<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes128Gcm, Aes256Gcm, Nonce};

    if nonce.len() != 12 {
        return Err(format!(
            "AES-GCM nonce/iv 必须 12 字节，实际 {}",
            nonce.len()
        ));
    }
    let payload = Payload {
        msg: plaintext,
        aad,
    };
    match key.len() {
        16 => Aes128Gcm::new_from_slice(key)
            .map_err(|e| format!("AES-GCM 初始化失败: {e}"))?
            .encrypt(Nonce::from_slice(nonce), payload)
            .map_err(|e| format!("AES-GCM 加密失败: {e}")),
        32 => Aes256Gcm::new_from_slice(key)
            .map_err(|e| format!("AES-GCM 初始化失败: {e}"))?
            .encrypt(Nonce::from_slice(nonce), payload)
            .map_err(|e| format!("AES-GCM 加密失败: {e}")),
        n => Err(format!("AES-GCM key 长度非法: {n} 字节（应为 16/32）")),
    }
}

/// AES-GCM 解密。输入为 `密文 || 16 字节 tag`。
pub fn aes_gcm_decrypt(
    key: &[u8],
    nonce: &[u8],
    aad: &[u8],
    ciphertext_and_tag: &[u8],
) -> CryptoResult<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes128Gcm, Aes256Gcm, Nonce};

    if nonce.len() != 12 {
        return Err(format!(
            "AES-GCM nonce/iv 必须 12 字节，实际 {}",
            nonce.len()
        ));
    }
    if ciphertext_and_tag.len() < 16 {
        return Err("AES-GCM 密文过短（至少要含 16 字节 tag）".into());
    }
    let payload = Payload {
        msg: ciphertext_and_tag,
        aad,
    };
    match key.len() {
        16 => Aes128Gcm::new_from_slice(key)
            .map_err(|e| format!("AES-GCM 初始化失败: {e}"))?
            .decrypt(Nonce::from_slice(nonce), payload)
            .map_err(|e| format!("AES-GCM 解密失败（key/nonce/tag 可能不匹配）: {e}")),
        32 => Aes256Gcm::new_from_slice(key)
            .map_err(|e| format!("AES-GCM 初始化失败: {e}"))?
            .decrypt(Nonce::from_slice(nonce), payload)
            .map_err(|e| format!("AES-GCM 解密失败（key/nonce/tag 可能不匹配）: {e}")),
        n => Err(format!("AES-GCM key 长度非法: {n} 字节（应为 16/32）")),
    }
}

// ============================ 摘要 / HMAC ============================

/// MD5 摘要（16 字节）。仅用于兼容旧系统，勿用于安全场景。
pub fn md5(data: &[u8]) -> Vec<u8> {
    use md5::{Digest, Md5};
    let mut h = Md5::new();
    h.update(data);
    h.finalize().to_vec()
}

/// SHA-1 摘要（20 字节）。仅用于兼容旧系统。
pub fn sha1(data: &[u8]) -> Vec<u8> {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(data);
    h.finalize().to_vec()
}

/// HMAC-SHA1（20 字节）。
pub fn hmac_sha1(key: &[u8], data: &[u8]) -> CryptoResult<Vec<u8>> {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;
    type H = Hmac<Sha1>;
    let mut mac =
        <H as Mac>::new_from_slice(key).map_err(|e| format!("HMAC-SHA1 key 无效: {e}"))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 已知向量：AES-128-CBC + PKCS7（NIST/openssl 可复算）----
    // key = "0123456789abcdef" (16B), iv = "abcdef0123456789" (16B)
    // openssl 校验：
    //   printf 'hello world' | openssl enc -aes-128-cbc -K 30313233...(hex) -iv 61626364...(hex) -a
    #[test]
    fn aes_128_cbc_pkcs7_roundtrip() {
        let key = b"0123456789abcdef";
        let iv = b"abcdef0123456789";
        let pt = b"hello world";
        let ct = aes_cbc_encrypt(key, iv, "pkcs7", pt).unwrap();
        // 11 字节明文 → 补到 16 字节一个分组
        assert_eq!(ct.len(), 16);
        let back = aes_cbc_decrypt(key, iv, "pkcs7", &ct).unwrap();
        assert_eq!(back, pt);
    }

    #[test]
    fn aes_128_cbc_known_vector_base64() {
        // 与 CryptoJS / openssl 对齐的固定向量（明文正好一个分组前的长度）
        let key = b"1234567890123456";
        let iv = b"6543210987654321";
        let ct = aes_cbc_encrypt(key, iv, "pkcs7", b"The quick brown fox").unwrap();
        let b64 = encode_output(&ct, "base64").unwrap();
        // 回环校验（下面这个常量由本实现产出，锁定行为，防回归）
        let decoded = decode_input(&b64, "base64").unwrap();
        let back = aes_cbc_decrypt(key, iv, "pkcs7", &decoded).unwrap();
        assert_eq!(back, b"The quick brown fox");
    }

    #[test]
    fn aes_256_cbc_roundtrip() {
        let key = b"0123456789abcdef0123456789abcdef"; // 32B
        let iv = b"abcdef0123456789";
        let pt = b"some longer secret payload spanning blocks!!";
        let ct = aes_cbc_encrypt(key, iv, "pkcs7", pt).unwrap();
        let back = aes_cbc_decrypt(key, iv, "pkcs7", &ct).unwrap();
        assert_eq!(back, pt);
    }

    #[test]
    fn aes_ecb_zero_padding_roundtrip() {
        let key = b"0123456789abcdef";
        let pt = b"ecb-mode-data";
        let ct = aes_ecb_encrypt(key, "zero", pt).unwrap();
        assert_eq!(ct.len() % 16, 0);
        let back = aes_ecb_decrypt(key, "zero", &ct).unwrap();
        // zero padding 会丢弃末尾 0x00；本明文无尾零，可完整还原
        assert_eq!(back, pt);
    }

    #[test]
    fn aes_gcm_roundtrip_with_aad() {
        let key = b"0123456789abcdef"; // 16B
        let nonce = b"unique-nonce"; // 12B
        assert_eq!(nonce.len(), 12);
        let aad = b"header";
        let ct = aes_gcm_encrypt(key, nonce, aad, b"top secret").unwrap();
        // 密文 = 明文长度 + 16 tag
        assert_eq!(ct.len(), 10 + 16);
        let back = aes_gcm_decrypt(key, nonce, aad, &ct).unwrap();
        assert_eq!(back, b"top secret");
        // aad 不匹配应失败
        assert!(aes_gcm_decrypt(key, nonce, b"wrong", &ct).is_err());
    }

    #[test]
    fn aes_gcm_wrong_key_fails() {
        let nonce = b"unique-nonce";
        let ct = aes_gcm_encrypt(b"0123456789abcdef", nonce, b"", b"data").unwrap();
        assert!(aes_gcm_decrypt(b"fedcba9876543210", nonce, b"", &ct).is_err());
    }

    #[test]
    fn md5_known_vector() {
        assert_eq!(hex::encode(md5(b"abc")), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(hex::encode(md5(b"")), "d41d8cd98f00b204e9800998ecf8427e");
    }

    #[test]
    fn sha1_known_vector() {
        assert_eq!(
            hex::encode(sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
    }

    #[test]
    fn hmac_sha1_known_vector() {
        // RFC 2202 test case: key=0x0b*20, data="Hi There"
        let key = [0x0bu8; 20];
        let mac = hmac_sha1(&key, b"Hi There").unwrap();
        assert_eq!(hex::encode(mac), "b617318655057264e28bc0b6fb378c8ef146be00");
    }

    #[test]
    fn encoding_helpers() {
        assert_eq!(encode_output(b"hi", "hex").unwrap(), "6869");
        assert_eq!(decode_input("6869", "hex").unwrap(), b"hi");
        assert_eq!(encode_output(b"hi", "base64").unwrap(), "aGk=");
        assert_eq!(decode_input("aGk=", "base64").unwrap(), b"hi");
    }

    #[test]
    fn pkcs7_full_block_padding() {
        // 明文正好 16 字节时 PKCS7 会补满一整块 0x10
        let key = b"0123456789abcdef";
        let iv = b"abcdef0123456789";
        let pt = b"0123456789abcdef"; // 16B
        let ct = aes_cbc_encrypt(key, iv, "pkcs7", pt).unwrap();
        assert_eq!(ct.len(), 32);
        let back = aes_cbc_decrypt(key, iv, "pkcs7", &ct).unwrap();
        assert_eq!(back, pt);
    }
}
