# OneBase 交付前验证清单

> 本清单覆盖「商用授权 + 代码隔离」这批改动的交付前自检。逐项打勾后再出包。
> 说明：本机 Windows 因缺 `libsasl2` 无法编译 Rust（`sasl2-sys` 原生依赖），
> 后端编译/测试必须在 Linux 或 Docker（镜像自带 libsasl2）上执行。

## 一、本次交付包含的改动

1. **商用离线 License 授权层**
   - `src/license.rs`：RSA 签名的离线 License（签发 / 验签 / 到期判定 / 部署指纹绑定）
   - `src/bin/license_tool.rs`：原厂 CLI（`keygen` / `fingerprint` / `issue` / `verify`）
   - `src/license_public.pem`：编译期内嵌验签公钥（占位；原厂换成自己的公钥后重编）
   - `src/main.rs`：启动加载 + 后台周期重载 + `GET /api/license` + 全局强制中间件
2. **License 模块闸门**（对齐报价单加购项）
   - `pipeline`（数据管道）：ES、Kafka、Redis、对象存储（管理面 + 数据面）
   - `ai`（智能体）：MCP
3. **代码隔离清理**（已沉进 `brandify.ps1`，每次同步自动生效）
   - VISION 命名释义去掉 `Crest`/`Rail` 拉丁血缘
   - 第三方名 `ShireHub` / `shirehub` → `Acme` / `acme`
   - Token 前缀去血缘：`cr* → ob*`（见下表）

| 旧前缀 | 新前缀 | 用途 |
| --- | --- | --- |
| `cr_` | `ob_` | Auto API Key |
| `crp_` | `obp_` | 平台服务令牌 |
| `crm_` | `obm_` | 个人访问令牌 PAT（MCP） |
| `cres_es_` | `obes_es_` | Elasticsearch token |
| `cres_kafka_` | `obes_kafka_` | Kafka token |
| `cres_os_` | `obes_os_` | 对象存储 token |
| `cr_live_` | `ob_live_` | OAuth client id |
| `crs_live_` | `obs_live_` | OAuth client secret |

## 二、验证步骤（逐项打勾）

### 1. 后端编译（必做）
```bash
# 方式 A：Docker（推荐，镜像自带 libsasl2）
docker build -t onebase:verify .

# 方式 B：Linux 本机
sudo apt-get install -y libsasl2-dev   # 或 RHEL: cyrus-sasl-devel
cargo build --release
```
- [ ] 编译通过（含 `onebase` 与 `license_tool` 两个 bin）

### 2. License 单元测试
```bash
cargo test license
```
- [ ] `sign_and_verify_roundtrip` / `tampered_payload_fails_verify` / `evaluate_active_grace_expired` 全绿

### 3. 前端构建
```bash
cd frontend-nextjs && npm run build
```
- [ ] `next build` 通过
- 注：裸 `tsc --noEmit` 会报 `.next` 过期缓存与 target 设置类错误，以 `next build` 为准。

### 4. 品牌 / 血缘残留检查（应全部为 0）
```bash
rg -i crestrail                       # 期望：0
rg -i shirehub                        # 期望：0
rg -n '\bcr_|crp_|crm_|cres_|crs_live_'   # 期望：0（旧 token 前缀清零）
rg -n 'inob_|deob_'                   # 期望：0（确认 incr_/decr_ 等未被误伤）
```
- [ ] 四项均为 0

### 5. License 工具冒烟（原厂侧）
```bash
# 生成密钥对（私钥自留，切勿入库）
./target/release/license_tool keygen --name license
# 把 license_public.pem 覆盖到 src/license_public.pem 后重编，即完成公钥硬内嵌

# 签发一份授权
./target/release/license_tool issue --priv license_private.pem \
  --customer "样例客户" --edition enterprise --modules pipeline,ai --days 365 --out license.lic

# 校验
./target/release/license_tool verify --pub license_public.pem --file license.lic
```
- [ ] keygen / issue / verify 均成功，verify 打印状态为 `active`

### 6. 运行时行为
- [ ] 默认（不设 `ONEBASE_LICENSE_ENFORCE`）：`warn` 模式，不拦截任何请求；`GET /api/license` 可查状态
- [ ] `enforce` + 授权过期/无效：写操作返回 `402`，读操作放行（只读降级）
- [ ] `enforce` + 未购模块：该模块路由（如 Kafka/ES）返回 `402 license_module_required`

## 三、License 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `ONEBASE_LICENSE_ENFORCE` | `off` / `warn` / `enforce` | `warn`（只校验+告警，不拦截） |
| `ONEBASE_LICENSE_PATH` | License 文件路径 | 探测 `./license.lic`、`/etc/onebase/license.lic` |
| `ONEBASE_LICENSE_PUBLIC_KEY` | 验签公钥（PEM 内联） | 优先用内嵌公钥 |
| `ONEBASE_LICENSE_PUBLIC_KEY_PATH` | 验签公钥文件路径 | 同上，二选一 |
| `ONEBASE_DEPLOY_FINGERPRINT` | 覆盖部署指纹 | 由主机名派生 |
| `ONEBASE_LICENSE_REFRESH_SECS` | 后台重载间隔（秒） | `300` |

> 私钥只留原厂；`.gitignore` 已忽略 `*_private.pem` 与 `*.lic`。续保 = 原厂重新签发到期日更晚的 License 文件替换进去，后台任务自动生效、无需重启。

## 四、OneBase-only 覆盖文件（同步时必须保留）

以下文件上游没有，`sync-from-crestrail.ps1` 的 `robocopy /MIR` 镜像会**删除**它们；每次同步后需从上一次提交恢复，并在新 `main.rs` 上重挂 License 接线：

- `src/license.rs`
- `src/bin/license_tool.rs`
- `src/license_public.pem`
- `docs/delivery-checklist.md`（本文件）
- `Cargo.toml` 的 `[[bin]] license_tool`、`src/lib.rs` 的 `pub mod license;`、`.gitignore` 的授权忽略段、`main.rs` 的 License 接线（启动加载 / `/api/license` / 全局强制中间件 / 各路由组 `require_module` 闸门）

同步流程：提交现状 → 拉上游 → 镜像+brandify → `git checkout <上一提交> -- <上列新文件>` → 在新 `main.rs` 上重挂接线 → 校验残留 → 提交推送。
