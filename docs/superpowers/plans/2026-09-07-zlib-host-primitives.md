# Workflow Host `zlib` Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Lua and JS workflow code nodes `zlib.compress` / `zlib.decompress` (RFC 1950) so authors can self-sign Tencent IM UserSig and reuse compression elsewhere.

**Architecture:** A stateless Rust module (`zlib_primitives`) implements RFC 1950 via `flate2` and is bound into the Lua sandbox as a global `zlib` table. JS does not go through the host IPC bridge: `onebase-runtime` injects the same API names on top of Node `deflateSync` / `inflateSync`. Both sides cap input and decompressed output at 8 MiB.

**Tech Stack:** Rust `flate2` (default rust backend), mlua 0.11, Node built-in `zlib`, existing `crypto.hmac_sha256` / `crypto.base64_encode` (unchanged).

**Spec:** `docs/superpowers/specs/2026-09-07-zlib-host-primitives-design.md`

## Global Constraints

- Format is RFC 1950 zlib wrapper only (2-byte header + deflate + Adler-32). Do not add raw deflate (RFC 1951) or gzip (RFC 1952)
- Compression level is 6 (`flate2::Compression::default()` / Node default). Do not add a level argument
- `MAX_BYTES = 8 * 1024 * 1024`. Compress plaintext, decompress ciphertext, and decompressed output all reject above this. Over-limit fails; never return truncated data
- Global module name is `zlib`, not `crypto.zlib_*`
- Do not add `tencent_im.*` or generate/verify UserSig in the engine
- Do not change `crypto.hmac_sha256` (still returns hex)
- Do not modify `src/js_host_bridge.rs`, `src/py_runner.rs`, or `src/crypto_primitives.rs`
- JS `zlib` must work with `ONEBASE_HOST_SOCK` unset
- JS input is `string | Buffer`; JS output is `Buffer`
- Lua input/output are binary strings (`mlua::String`)
- Do not commit unless the user asked; skip `git commit` steps if this session did not request commits, but still finish the code and verification
- Empty input is valid: compress empty → valid zlib header; decompress that → empty

## File map

| Path | Responsibility |
|------|----------------|
| `src/zlib_primitives.rs` | `compress` / `decompress`, `MAX_BYTES`, Rust + Node-interop tests |
| `src/lib.rs` | `pub mod zlib_primitives` |
| `src/main.rs` | `mod zlib_primitives` (bin crate also compiles `lua_builtins.rs`) |
| `Cargo.toml` / `Cargo.lock` | `flate2 = "1"` |
| `src/lua_builtins.rs` | `register_zlib_module`, Lua tests |
| `js-runtime/onebase-runtime/index.js` | global `zlib` via Node `zlib` |
| `src/mcp_tools.rs` | `node_spec` docs + UserSig recipe |

---

### Task 1: Rust `zlib_primitives`

**Files:**
- Create: `src/zlib_primitives.rs`
- Modify: `Cargo.toml` (add `flate2 = "1"` after the `sha1 = "0.10"` line in the crypto block)
- Modify: `src/lib.rs` (add `pub mod zlib_primitives;` immediately after `pub mod crypto_primitives;`)

**Interfaces:**
- Consumes: `flate2::{write::ZlibEncoder, read::ZlibDecoder, Compression}`, `std::io::{Read, Write}`
- Produces:
  - `pub const MAX_BYTES: usize = 8 * 1024 * 1024;`
  - `pub fn compress(input: &[u8]) -> Result<Vec<u8>, String>`
  - `pub fn decompress(input: &[u8]) -> Result<Vec<u8>, String>`
  - Error strings must contain `zlib.compress` or `zlib.decompress`, and over-limit errors must also contain `8 MiB`

- [ ] **Step 1: Add `flate2` and write failing stubs + tests**

In `Cargo.toml`, after `sha1 = "0.10"`, add:

```toml
# RFC 1950 zlib（Lua zlib.* builtins）。默认 rust backend / miniz_oxide，不链系统 zlib。
flate2 = "1"
```

Create `src/zlib_primitives.rs`:

```rust
//! RFC 1950 zlib 压缩 / 解压，供 Lua `zlib.*` builtins 使用。
//!
//! JS 工作流不走本模块：`onebase-runtime` 直接调 Node `zlib.deflateSync`。

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::{Read, Write};

pub const MAX_BYTES: usize = 8 * 1024 * 1024;

pub fn compress(_input: &[u8]) -> Result<Vec<u8>, String> {
    todo!("zlib.compress")
}

pub fn decompress(_input: &[u8]) -> Result<Vec<u8>, String> {
    todo!("zlib.decompress")
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(!out.is_empty(), "empty plaintext still yields a zlib header");
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
}
```

In `src/lib.rs`, immediately after `pub mod crypto_primitives;`, add:

```rust
pub mod zlib_primitives;
```

Do not add the module to `main.rs` yet (Lua binding is Task 2).

- [ ] **Step 2: Run tests and confirm they fail**

Run: `cargo test --lib zlib_primitives -- --test-threads=1`

Expected: compile succeeds (stubs + `flate2` present); tests panic with `not yet implemented: zlib.compress` (or `zlib.decompress` for the garbage/oversize-input cases that hit `decompress` first).

If `flate2` is missing from the graph, `cargo test` fails at compile with `unresolved import flate2` — run `cargo add flate2@1` and retry. After `cargo add`, `Cargo.lock` will change; keep that change.

- [ ] **Step 3: Implement `compress` / `decompress`**

Replace the two `todo!()` functions with:

```rust
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
    encoder
        .finish()
        .map_err(|e| format!("zlib.compress: {e}"))
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
```

Do not change the tests.

- [ ] **Step 4: Run tests and confirm they pass**

Run: `cargo test --lib zlib_primitives -- --test-threads=1`

Expected: all 8 tests PASS. `rust_compress_node_inflate_interop` may skip (return early) if `node` is missing — that is OK. If `node` is present, it must PASS.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/zlib_primitives.rs src/lib.rs
git commit -m "$(cat <<'EOF'
feat: add RFC 1950 zlib primitives for workflow Lua builtins.

EOF
)"
```

---

### Task 2: Lua `zlib` builtin

**Files:**
- Modify: `src/main.rs` (add `mod zlib_primitives;` immediately after `mod crypto_primitives;`)
- Modify: `src/lua_builtins.rs`

**Interfaces:**
- Consumes: `crate::zlib_primitives::{compress, decompress}` from Task 1
- Produces:
  - `fn register_zlib_module(lua: &Lua) -> LuaResult<()>`
  - Global `zlib.compress(bytes) -> string` (binary)
  - Global `zlib.decompress(bytes) -> string` (binary)
  - `register_builtins` calls `register_zlib_module` after `register_crypto_module`

- [ ] **Step 1: Write the failing Lua tests**

In `src/lua_builtins.rs`, inside `#[cfg(test)] mod tests`, immediately after `test_crypto_base64_roundtrip` (the function that ends around the `hello world` base64 asserts), add:

```rust
    #[test]
    fn test_zlib_roundtrip_and_base64() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();
        lua.load(
            r#"
            local c = zlib.compress("hello")
            assert(type(c) == "string" and #c > 0, "compress should return non-empty binary")
            assert(c ~= "hello", "compressed bytes must differ from plaintext")
            assert(zlib.decompress(c) == "hello", "zlib roundtrip mismatch")

            local empty = zlib.compress("")
            assert(zlib.decompress(empty) == "", "empty roundtrip")

            local bin = string.char(0, 255, 0, 127)
            assert(zlib.decompress(zlib.compress(bin)) == bin, "binary roundtrip")

            local b64 = crypto.base64_encode(c)
            assert(type(b64) == "string" and #b64 > 0, "compressed output must be base64-encodable")
        "#,
        )
        .exec()
        .unwrap();
    }

    #[test]
    fn test_zlib_decompress_garbage() {
        let lua = Lua::new();
        register_builtins(&lua, HashMap::new()).unwrap();
        let err = lua
            .load(r#"zlib.decompress("not-zlib")"#)
            .exec()
            .expect_err("garbage must error");
        let msg = err.to_string();
        assert!(msg.contains("zlib.decompress"), "{msg}");
    }
```

Do not register the module yet. `register_builtins` still has no `zlib`.

- [ ] **Step 2: Run tests and confirm they fail**

Run: `cargo test --lib test_zlib -- --nocapture`

Expected: FAIL. Typical message is a Lua error that `zlib` is nil / not a table (`attempt to index a nil value` or similar), because `register_builtins` never set the global.

Also add `mod zlib_primitives;` to `src/main.rs` now (next to `mod crypto_primitives;`) so a later `cargo build --bin onebase` can compile `lua_builtins` against `crate::zlib_primitives`. If you skip this, Task 2 implementation will fail to compile the bin crate.

- [ ] **Step 3: Register the Lua module**

In `register_builtins`, after `register_crypto_module(lua)?;`, add:

```rust
    register_zlib_module(lua)?;
```

Immediately after `register_crypto_module` (the function that ends with `lua.globals().set("crypto", crypto_mod)?;`), add:

```rust
fn register_zlib_module(lua: &Lua) -> LuaResult<()> {
    let zlib_mod = lua.create_table()?;

    zlib_mod.set(
        "compress",
        lua.create_function(|lua, input: mlua::String| {
            let out = crate::zlib_primitives::compress(&input.as_bytes())
                .map_err(mlua::Error::RuntimeError)?;
            lua.create_string(&out)
        })?,
    )?;

    zlib_mod.set(
        "decompress",
        lua.create_function(|lua, input: mlua::String| {
            let out = crate::zlib_primitives::decompress(&input.as_bytes())
                .map_err(mlua::Error::RuntimeError)?;
            lua.create_string(&out)
        })?,
    )?;

    lua.globals().set("zlib", zlib_mod)?;
    Ok(())
}
```

If `input.as_bytes()` already yields `&[u8]` and the compiler warns about an extra `&`, drop it and call `compress(input.as_bytes())`. Do not change the public Lua names.

- [ ] **Step 4: Run tests and confirm they pass**

Run: `cargo test --lib test_zlib -- --nocapture`

Expected: `test_zlib_roundtrip_and_base64` and `test_zlib_decompress_garbage` PASS.

Also run: `cargo test --lib zlib_primitives -- --test-threads=1`

Expected: Task 1 tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.rs src/lua_builtins.rs
git commit -m "$(cat <<'EOF'
feat(lua): expose zlib.compress/decompress builtins.

EOF
)"
```

---

### Task 3: JS runtime `zlib` (no IPC)

**Files:**
- Modify: `js-runtime/onebase-runtime/index.js`
- Modify: `src/zlib_primitives.rs` (add one more `#[test]` that `--require`s the runtime with `ONEBASE_HOST_SOCK` unset)

**Interfaces:**
- Consumes: Node built-in `require('zlib')` (`deflateSync` / `inflateSync`)
- Produces:
  - Global `zlib.compress(bytes)` → `Buffer`
  - Global `zlib.decompress(bytes)` → `Buffer`
  - Wrong type → `TypeError` whose message contains `zlib.compress` or `zlib.decompress`
  - Oversize input / inflate over `maxOutputLength` → `Error` whose message contains the function name and `8 MiB` when it is an input/output cap

- [ ] **Step 1: Write the failing runtime test**

In `src/zlib_primitives.rs` `mod tests`, add (keep the existing `use std::process::Command;`; add `use std::path::PathBuf;` next to it):

```rust
    #[test]
    fn js_runtime_zlib_roundtrip_without_host_sock() {
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("js-runtime/onebase-runtime/index.js");
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
```

Do not edit `index.js` yet.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cargo test --lib js_runtime_zlib_roundtrip_without_host_sock -- --nocapture`

Expected: if `node` is missing, the test returns early and PASSes — install/use Node before treating this task done. If `node` is present, FAIL with `zlib global missing` on stderr.

- [ ] **Step 3: Inject `zlib` in `onebase-runtime`**

At the top of `js-runtime/onebase-runtime/index.js`, after `'use strict';` and the file comment, add:

```javascript
const nodeZlib = require('zlib');
const ZLIB_MAX_BYTES = 8 * 1024 * 1024;

function zlibInput(bytes, name) {
  if (typeof bytes !== 'string' && !Buffer.isBuffer(bytes)) {
    throw new TypeError(`${name}: 需要 string 或 Buffer`);
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length > ZLIB_MAX_BYTES) {
    throw new Error(`${name}: 输入超过 8 MiB（${buf.length} bytes）`);
  }
  return buf;
}
```

Immediately after the `installGlobal('google', { ... });` block at the end of the file, add:

```javascript
installGlobal('zlib', {
  compress: (bytes) => nodeZlib.deflateSync(zlibInput(bytes, 'zlib.compress')),
  decompress: (bytes) => {
    try {
      return nodeZlib.inflateSync(zlibInput(bytes, 'zlib.decompress'), {
        maxOutputLength: ZLIB_MAX_BYTES,
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (/too large|maxOutputLength|ERR_BUFFER_TOO_LARGE/i.test(String(error))) {
        throw new Error('zlib.decompress: 输出超过 8 MiB');
      }
      throw new Error(`zlib.decompress: ${message}`);
    }
  },
});
```

Do not add a `zlib.*` op to `js_host_bridge.rs`. Do not call `call()` from these functions.

- [ ] **Step 4: Run tests and confirm they pass**

Run:

```
cargo test --lib js_runtime_zlib_roundtrip_without_host_sock -- --nocapture
cargo test --lib zlib_primitives -- --test-threads=1
cargo test --lib test_zlib -- --nocapture
```

Expected: all PASS (Node-dependent tests skip only when `node` is absent).

- [ ] **Step 5: Commit**

```bash
git add js-runtime/onebase-runtime/index.js src/zlib_primitives.rs
git commit -m "$(cat <<'EOF'
feat(js): expose local zlib.compress/decompress in workflow runtime.

EOF
)"
```

---

### Task 4: `node_spec` documentation

**Files:**
- Modify: `src/mcp_tools.rs` (the `NODE_SPEC` markdown string)

**Interfaces:**
- Consumes: APIs from Tasks 2–3
- Produces: Lua and JS `node_spec` sections document `zlib`; both include the UserSig recipe. Python section unchanged.

- [ ] **Step 1: Update the JS capability list**

In `src/mcp_tools.rs`, in the JavaScript host-API section, immediately after the line that lists `crypto`（部分实现）, insert:

```
- `zlib`（runtime 本地 Node zlib，不走 IPC）：`compress(bytes)` / `decompress(bytes)`，RFC 1950（与 Python `zlib.compress` / Node `deflateSync` 同格式）。入参 `string` 或 `Buffer`，出参 `Buffer`。明文与解压输出上限 8 MiB。不要把 `Buffer` 传给 host `crypto.base64_encode`（IPC 不能传裸字节），用 `buf.toString('base64')`
- 腾讯 IM UserSig（TLS-Sig v2）配方：`hmac_sha256` 返回 hex → 每两字符 `parseInt(h,16)` 拼成 Buffer → JSON（`TLS.ver/identifier/sdkappid/expire/time/sig`，`sig` 为 HMAC 的标准 base64）→ `zlib.compress` → `toString('base64')` 后把 `+/=` 换成 `*-_`
```

- [ ] **Step 2: Update the Lua capability list**

In the same file, in the Lua section, after the crypto bullet list (after the `aes_encrypt` / `aes_decrypt` paragraph) and before the `google.sa_assertion` bullet, insert:

```
- `zlib.compress(bytes)` / `zlib.decompress(bytes)`：RFC 1950 zlib wrapper，入参/出参为二进制字符串；明文与解压输出上限 8 MiB。压缩结果可直接交给 `crypto.base64_encode`
- 腾讯 IM UserSig（TLS-Sig v2）配方（引擎不提供 `tencent_im.*`）：
```

Then this fenced Lua block (keep it inside the `NODE_SPEC` string; escape backticks if the surrounding Rust raw string requires it — `NODE_SPEC` is already a raw / regular string, match the file's existing fence style):

```lua
local content = table.concat({
  "TLS.identifier:" .. userId,
  "TLS.sdkappid:" .. sdkAppId,
  "TLS.time:" .. time.now(),
  "TLS.expire:" .. expire,
  "",
}, "\n")
local hex = crypto.hmac_sha256(secret, content)
local raw = hex:gsub("..", function(c) return string.char(tonumber(c, 16)) end)
local doc = json.encode({
  ["TLS.ver"] = "2.0",
  ["TLS.identifier"] = tostring(userId),
  ["TLS.sdkappid"] = tonumber(sdkAppId),
  ["TLS.expire"] = tonumber(expire),
  ["TLS.time"] = time.now(),
  ["TLS.sig"] = crypto.base64_encode(raw),
})
local usersig = crypto.base64_encode(zlib.compress(doc))
  :gsub("%+", "*"):gsub("/", "-"):gsub("=", "_")
```

`NODE_SPEC` is `const NODE_SPEC: &str = r#"..."#;` (starts at `src/mcp_tools.rs:25`). Raw-string quoting is fine; do not turn `+` into a Lua pattern — `%+` is required. Match neighboring bullet indentation. Do not add a Python host binding.

- [ ] **Step 3: Confirm `NODE_SPEC` still compiles**

Run: `cargo test --lib test_zlib -- --nocapture`

Expected: PASS. This is a compile + existing-test smoke check.

- [ ] **Step 4: Commit**

```bash
git add src/mcp_tools.rs
git commit -m "$(cat <<'EOF'
docs: document workflow zlib builtins and Tencent UserSig recipe.

EOF
)"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| RFC 1950 only, level 6 | Task 1 (`ZlibEncoder` / `Compression::default()`), Task 3 (`deflateSync`) |
| Lua `zlib.compress` / `decompress` binary strings | Task 2 |
| JS same names, local Node zlib, no IPC | Task 3 |
| 8 MiB caps, no truncated output | Task 1 + Task 3 `maxOutputLength` |
| Empty input valid | Task 1 + Task 2 tests |
| No `tencent_im.*`, HMAC stays hex | Task 4 recipe only |
| No `js_host_bridge` / Python / `crypto_primitives` edits | File map + constraints |
| Rust ↔ Node interop (not byte-identical compress) | Task 1 `rust_compress_node_inflate_interop` |
| JS works without host socket | Task 3 test `env_remove("ONEBASE_HOST_SOCK")` |
| `node_spec` + UserSig recipe | Task 4 |
| JS `Buffer` must not go through host `base64_encode` | Task 4 warning |
