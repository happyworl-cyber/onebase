# 工作流宿主 `zlib` 原语 — 设计文档

- 日期：2026-09-07
- 状态：待评审
- 范围：Lua / JS 工作流代码节点增加 `zlib.compress` / `zlib.decompress`（RFC 1950）
- 相关代码：
  - `src/lua_builtins.rs`（Lua 沙箱全局模块）
  - `src/crypto_primitives.rs`（无状态原语拆分先例）
  - `js-runtime/onebase-runtime/index.js`（JS 全局注入）
  - `src/js_host_bridge.rs`（本期不改）
  - `src/mcp_tools.rs`（`node_spec` 文档）

## 1. 背景与目标

腾讯 IM 管理端接口要带 UserSig（TLS-Sig v2）：拼固定格式字符串 → HMAC-SHA256 → JSON → **zlib 压缩** → 自定义 base64（`+/=` 换成 `*-_`）。

引擎已有 HMAC-SHA256 与标准 base64。缺的是 zlib。Lua 沙箱没有压缩库；JS 跑在 Node 上，自带 `zlib.deflateSync`（RFC 1950），但宿主桥是 JSON IPC，二进制过不去，且现有 `crypto.base64_decode` 要求 UTF-8。

**目标**：给 Lua / JS 同一套 `zlib.compress(bytes)` / `zlib.decompress(bytes)`。有了它，UserSig 用脚本二十行就能自签；压缩本身也可复用到别的对接。

### 已确认需求

1. 通用 zlib，不做 `tencent_im.gen_usersig(...)`。
2. 格式是 **RFC 1950**（zlib wrapper = 2 字节头 + deflate + Adler-32），不是 raw deflate（RFC 1951）也不是 gzip（RFC 1952）。与 Python `zlib.compress`、Node `zlib.deflateSync`、腾讯官方 SDK 一致。
3. JS 在 `onebase-runtime` 里直接调 Node `zlib`，**不走** `js_host_bridge` IPC。
4. API 名对齐：两边都是全局 `zlib.compress` / `zlib.decompress`。

### 非目标

- 不新增 `tencent_im.*` 原语。
- 不改 Python 宿主（CPython 已有标准库 `zlib`）。
- 不改 `js_host_bridge.rs`，不补 JS IPC 二进制通道。
- 不改 `crypto.hmac_sha256` 的 hex 返回值；UserSig 需要的 raw HMAC 由脚本 hex→字节 两行完成。
- 不提供 raw deflate / gzip / 可调压缩级别。
- 不在引擎内生成或校验 UserSig。

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 模块名 | 全局 `zlib`，不挂 `crypto` | 压缩不是密码学；与同事需求原文一致 |
| JS 实现 | runtime 本地 Node `zlib` | 避免 JSON IPC 传二进制；Node 已有 RFC 1950 |
| Rust crate | `flate2`（默认 rust backend / miniz_oxide） | 纯 Rust，`ZlibEncoder` / `ZlibDecoder` 即 RFC 1950 |
| 压缩级别 | 6（`flate2::Compression::default()` / Node 默认） | 与 Python/Node `zlib.compress` 默认一致；不保证压缩字节与它们逐字节相同，只保证可互解 |
| 解压上限 | **8 MiB**（`8 * 1024 * 1024`） | 防 zip bomb；超限失败，不返回截断 |
| 压缩入参上限 | 同样 8 MiB | 对称，避免工作流用巨大明文烧 CPU |
| Lua 字节 | `mlua::String` 二进制，与 `crypto.base64_encode` 相同 | 沙箱字符串本就可含任意字节 |
| JS 字节 | 入参 `string` 或 `Buffer`；出参 **`Buffer`** | Node 习惯；UserSig 用 `buf.toString('base64')` 即可，不要把 Buffer 丢给 host `crypto.base64_encode` |
| HMAC | 保持 hex | 范围外；文档给转换配方 |

## 3. 架构

```
Lua code 节点                         JS code 节点
────────────                         ────────────
zlib.compress(bytes)                 zlib.compress(bytes)   // onebase-runtime
        │                                    │
        ▼                                    ▼
src/zlib_primitives.rs               Node zlib.deflateSync
  flate2 ZlibEncoder                   （RFC 1950，本地，无 IPC）
        │
        ▼
二进制字符串 ──► crypto.base64_encode ──► 替换 +/= 为 *-_
```

`js_host_bridge.rs` 不增加 `zlib.*` op。未实现的 `crypto.*` 占位行为不变。

## 4. API

### 4.1 签名

**Lua**

```lua
zlib.compress(bytes)    -- string → string（二进制）
zlib.decompress(bytes)  -- string → string（二进制）
```

**JS**

```javascript
zlib.compress(bytes)    // string | Buffer → Buffer
zlib.decompress(bytes)  // string | Buffer → Buffer
```

两端都没有 encoding 选项、没有 level 参数。明文是 UTF-8 时直接传入字符串即可（Lua 按字节、JS `Buffer.from(string)` 默认 UTF-8）。

### 4.2 错误

| 情况 | Lua | JS |
|---|---|---|
| 缺参 / 非字符串（JS 亦非 Buffer） | `RuntimeError` | `TypeError` |
| 入参 > 8 MiB（compress 明文或 decompress 密文） | `RuntimeError`，消息含 `zlib.compress` / `zlib.decompress` 与 `8 MiB` | 同文案的 `Error` |
| 非法 zlib 数据 | `RuntimeError`，消息含 `zlib.decompress` | `Error`，消息含 `zlib.decompress` |
| 解压输出 > 8 MiB | `RuntimeError`，不返回部分数据 | Node `maxOutputLength` 触发的 `Error`，不返回部分数据 |
| 空输入 | 合法：压缩空串得到合法 zlib 头，解压回空 | 同左 |

### 4.3 UserSig 配方（文档用，不进引擎）

TLS-Sig v2 的 HMAC 是 **raw 32 字节再标准 base64**，不是 hex。现有 `crypto.hmac_sha256` 返回 hex，Lua 侧：

```lua
local hex = crypto.hmac_sha256(secret, content)
local raw = hex:gsub("..", function(c) return string.char(tonumber(c, 16)) end)
local sig = crypto.base64_encode(raw)
-- JSON → zlib.compress → crypto.base64_encode → +/= 换成 *-_
```

JS 侧 HMAC 仍走 host（hex），压缩用本地 `zlib`，自定义 base64 用 `Buffer.toString('base64')` 再替换字符。`node_spec` 两份语言说明都写这段，避免同事再问「缺不缺 usersig 原语」。

## 5. 组件与落点

| 文件 | 改动 |
|---|---|
| `src/zlib_primitives.rs` | **新建**。`compress(&[u8]) -> Result<Vec<u8>, String>`、`decompress(&[u8]) -> Result<Vec<u8>, String>`。常量 `MAX_BYTES: usize = 8 * 1024 * 1024`。入参超限、解压读满 `MAX_BYTES + 1` 即失败。 |
| `src/lib.rs` / `src/main.rs` | `mod zlib_primitives;` |
| `src/lua_builtins.rs` | `register_zlib_module`，`register_builtins` 里调用；单测往返 + 喂给 `crypto.base64_encode` |
| `js-runtime/onebase-runtime/index.js` | `installGlobal('zlib', { compress, decompress })`，内部 `zlib.deflateSync` / `inflateSync`，`maxOutputLength: 8 * 1024 * 1024`；compress 前检查明文长度 |
| `src/mcp_tools.rs` | Lua / JS 能力列表补 `zlib`；附 UserSig 配方 |
| `Cargo.toml` | `flate2`（默认 features） |

不改：`js_host_bridge.rs`、`py_runner.rs`、`crypto_primitives.rs`。

## 6. 测试

| 层 | 断言 |
|---|---|
| Rust `zlib_primitives` | 往返 `"hello"`；空串往返；含 `0x00 0xff` 的非 UTF-8；损坏输入报错；9 MiB 明文 compress 被拒；「压缩后的 9 MiB 零块」decompress 被拒且无截断输出 |
| Lua builtins | `register_builtins` 后往返；压缩结果可 `crypto.base64_encode`；非法输入报错 |
| JS runtime | `node --require onebase-runtime` 往返（**不**设 `ONEBASE_HOST_SOCK`，证明不走 IPC）；出参是 `Buffer` |
| 互操作 | 同一明文：Rust `compress` 的字节，Node `inflateSync` 能解开还原。不要求 Rust 与 Node 的 compress 输出逐字节相同 |

不测完整腾讯 UserSig（依赖 secret 与墙上时钟）。配方正确性由同事用腾讯控制台验签。

## 7. 成功标准

- Lua / JS 工作流能对任意字节做 RFC 1950 压缩与解压，两边可互解。
- 同事按 `node_spec` 配方用 Lua 自签 UserSig，无需新原语。
- 超限与损坏输入失败且不返回部分明文。
- JS `zlib` 在无 host socket 时仍可用。

## 8. 风险

- **压缩字节不保证与腾讯 SDK 逐字节相同**（level 6 下实现差异）。TLS-Sig 只要求解压后 JSON 一致；腾讯服务端 inflate 后再验 HMAC。互解测试覆盖这一点。
- **JS 把 `Buffer` 传给 host `crypto.base64_encode` 会坏**（IPC JSON 不能传裸字节）。文档写明用 `Buffer.toString('base64')`。
- **8 MiB 对合法大 payload 偏紧**。UserSig JSON 约几百字节；真有更大需求再调常量。本期不做成参数。
