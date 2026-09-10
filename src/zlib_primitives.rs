//! RFC 1950 zlib 压缩 / 解压，供 Lua `zlib.*` builtins 使用。
//!
//! JS 工作流不走本模块：`onebase-runtime` 直接调 Node `zlib.deflateSync`。

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::{Read, Write};

pub const MAX_BYTES: usize = 8 * 1024 * 1024;

pub fn compress(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() > MAX_BYTES {
        return Err(format!(
            "zlib.compress: 输入超过 8 MiB（{} bytes）",
            input.len()
        ));
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(input)
        .map_err(|e| format!("zlib.compress: {e}"))?;
    encoder.finish().map_err(|e| format!("zlib.compress: {e}"))
}

pub fn decompress(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() > MAX_BYTES {
        return Err(format!(
            "zlib.decompress: 输入超过 8 MiB（{} bytes）",
            input.len()
        ));
    }
    let decoder = ZlibDecoder::new(input);
    let mut limited = decoder.take(MAX_BYTES as u64 + 1);
    let mut out = Vec::new();
    limited
        .read_to_end(&mut out)
        .map_err(|e| format!("zlib.decompress: {e}"))?;
    if out.len() > MAX_BYTES {
        return Err("zlib.decompress: 输出超过 8 MiB".to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    #[test]
    fn roundtrip_hello() {
        let out = compress(b"hello").expect("compress");
        assert_ne!(out, b"hello");
        assert_eq!(decompress(&out).expect("decompress"), b"hello");
    }

    #[test]
    fn roundtrip_empty() {
        let out = compress(b"").expect("compress empty");
        assert!(
            !out.is_empty(),
            "empty plaintext still yields a zlib header"
        );
        assert_eq!(decompress(&out).expect("decompress empty"), b"");
    }

    #[test]
    fn roundtrip_binary() {
        let input = [0x00, 0xff, 0x00, 0x7f];
        let out = compress(&input).expect("compress binary");
        assert_eq!(decompress(&out).expect("decompress binary"), input);
    }

    #[test]
    fn decompress_rejects_garbage() {
        let err = decompress(b"not-zlib").expect_err("garbage must fail");
        assert!(err.contains("zlib.decompress"), "{err}");
    }

    #[test]
    fn compress_rejects_oversize_input() {
        let big = vec![0u8; MAX_BYTES + 1];
        let err = compress(&big).expect_err("oversize plaintext must fail");
        assert!(err.contains("zlib.compress"), "{err}");
        assert!(err.contains("8 MiB"), "{err}");
    }

    #[test]
    fn decompress_rejects_oversize_input() {
        let big = vec![0u8; MAX_BYTES + 1];
        let err = decompress(&big).expect_err("oversize ciphertext must fail");
        assert!(err.contains("zlib.decompress"), "{err}");
        assert!(err.contains("8 MiB"), "{err}");
    }

    #[test]
    fn decompress_rejects_oversize_output() {
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&vec![0u8; MAX_BYTES + 1]).unwrap();
        let blob = enc.finish().unwrap();
        assert!(
            blob.len() <= MAX_BYTES,
            "compressed zeros must be under the input cap, got {}",
            blob.len()
        );
        let err = decompress(&blob).expect_err("oversize output must fail");
        assert!(err.contains("zlib.decompress"), "{err}");
        assert!(err.contains("8 MiB"), "{err}");
    }

    #[test]
    fn rust_compress_node_inflate_interop() {
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let compressed = compress(b"hello rust").expect("compress");
        let hex = hex::encode(&compressed);
        let output = Command::new("node")
            .arg("-e")
            .arg(
                "const z=require('zlib'); process.stdout.write(z.inflateSync(Buffer.from(process.argv[1],'hex')).toString())",
            )
            .arg(&hex)
            .output()
            .expect("node starts");
        assert!(
            output.status.success(),
            "node inflate failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"hello rust");
    }

    #[test]
    fn js_runtime_zlib_roundtrip_without_host_sock() {
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let runtime =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("js-runtime/onebase-runtime/index.js");
        let output = Command::new("node")
            .arg("--require")
            .arg(&runtime)
            .arg("-e")
            .arg(
                r#"
                if (typeof zlib === 'undefined' || typeof zlib.compress !== 'function') {
                  process.stderr.write('zlib global missing');
                  process.exit(1);
                }
                const out = zlib.compress('hello');
                if (!Buffer.isBuffer(out)) { process.stderr.write('not buffer'); process.exit(1); }
                const back = zlib.decompress(out);
                if (back.toString() !== 'hello') { process.stderr.write('mismatch'); process.exit(1); }
                const bin = Buffer.from([0x00, 0xff]);
                if (!zlib.decompress(zlib.compress(bin)).equals(bin)) {
                  process.stderr.write('binary mismatch');
                  process.exit(1);
                }
                if (process.env.ONEBASE_HOST_SOCK) {
                  process.stderr.write('host sock should be unset');
                  process.exit(1);
                }
                "#,
            )
            .env_remove("ONEBASE_HOST_SOCK")
            .output()
            .expect("node starts");
        assert!(
            output.status.success(),
            "js runtime zlib failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
