# Docker 镜像构建加速（Jenkins + K8s）

日期：2026-07-30  
状态：已实现并修正（Dockerfile）

> 修正（2026-07-31）：不要把 `/build/target` 只放在 BuildKit cache mount。
> Jenkins 上该 cache 易丢失，而 stub 层仍显示 CACHED 时会在空 target 上全量冷编译，
> 反而比「依赖进镜像层」更慢。已改回层缓存 deps；仅 registry/git/npm 使用 cache mount。
> 去掉 mold（曾导致链接失败，并让 apt 层失效）。

## 背景

项目通过 Jenkins + K8s 部署。流水线最慢阶段是 Docker 镜像构建：

- 无代码变更重复构建：较快（约 8–9 分钟量级，依赖层缓存命中）
- 有代码变更：明显变慢（可达 30+ 分钟）
- 主要痛点：Rust 后端 release 编译；前后端都会改，有时也会动 `Cargo.toml` / `package.json`

`Jenkinsfile` 调用共享库 `golangDefaultPipeline()`；应用镜像由仓库根目录 `Dockerfile` 多阶段构建（Rust + Next.js + runtime）。本地 Docker 层缓存会跨构建保留。

## 问题根因

1. 改 `src/`（或 `migrations/`）会使 `cargo build` 所在层失效；层内 `target/` 为空，等于冷编译。
2. 现有 `cargo clean -p onebase --release` 每次清掉本包产物，阻止增量编译。
3. release 链接大二进制（含 `rdkafka` cmake-build 等）本身耗时长。
4. 依赖层缓存已有效；本次不优先做拆镜像或预热 base（可后续叠加）。

## 目标与非目标

### 目标

- 保持单镜像（`Dockerfile`）与现有 Jenkins/K8s 部署形态。
- 在「业务代码变更、lockfile 大致不变」时，显著缩短 Rust 构建时间。
- 无代码变更重跑仍保持现有「快」的体验。
- 运行时产物与行为不变。

### 非目标（本次不做）

- 拆前后端为两个镜像 / 改 K8s Deployment。
- 修改 `mind-pipeline-library` 业务逻辑（除非仅文档要求开启 BuildKit）。
- 以 `Dockerfile.aio` 为主路径（可选同期套用同一手法，不阻塞）。
- 引入 cargo-chef / 预热 builder 基镜像（可后续叠加）。

## 成功标准

- 只改 `src/`、`Cargo.lock` 不变：Rust 阶段相对现状明显缩短（常见场景争取约一半或更好；非硬 SLA）。
- 零文件变更重构建：仍接近当前最快路径。
- 冒烟：容器 `/health/live` 正常，API + 前端基本可访问。

## 方案概要

采用 **BuildKit cache mount + 更快链接器**，继续单镜像。

### Rust 阶段

1. **BuildKit cache mount**（核心）  
   在依赖预热与正式 `cargo build` 上挂载：
   - `type=cache,target=/usr/local/cargo/registry`
   - `type=cache,target=/usr/local/cargo/git`
   - `type=cache,target=/build/target`  
   层因代码变更重跑时，对象文件仍留在 agent 的 BuildKit cache 中，从而增量编译。

2. **二进制拷出 cache**  
   cache mount 不进入镜像层。构建结束后将产物复制到固定路径（例如 `/build/onebase`），runtime 使用 `COPY --from=rust-builder` 该路径。

3. **去掉每次必跑的 `cargo clean -p onebase`**  
   保留 stub `main`/`bin` 依赖预热技巧；正式构建直接 `cargo build --release --bin onebase`。若出现 stub 指纹粘连，再加更窄的清理，而不是每次 `clean -p`。

4. **更快链接器**  
   在 builder 安装 `mold`（或 fallback `lld`），构建时设置  
   `RUSTFLAGS="-C link-arg=-fuse-ld=mold"`（或仅用于 Docker 的 `.cargo/config.toml`）。只影响链接速度，不改变运行时行为。若 mold 与原生依赖不兼容，回退默认链接器或改用 lld。

5. **`migrations/` 仍在编译前 COPY**  
   `src/migrate.rs` 等通过 `include_str!` 内联 SQL，迁移变更触发重编是正确行为。

### 前端阶段（次要）

- 为 `npm ci` / `npm run build` 增加 npm cache mount（如 `~/.npm`）。
- 不改变 standalone 产物形态与 runtime 布局。
- 主收益仍在 Rust；前端 cache 降低 npm 层偶发失效与「前后端同改」时的附带成本。

### Jenkins / 构建前提

- 必须启用 BuildKit：`DOCKER_BUILDKIT=1` 或等价 buildx。
- agent 上 BuildKit cache 需可持久（与当前「重复部署很快」的环境一致）。
- 若流水线未开 BuildKit，cache mount 语法可能导致构建失败——合入前在 Jenkins 日志确认；未开启则先开再合入。

## 验证计划

1. 冷构建一次，填满 BuildKit cache。
2. 只改一个无害的 `src/` 文件再构建，对比 Rust 阶段耗时。
3. 零改动再构建，确认仍很快。
4. 冒烟：`/health/live`、前后端基本可访问。

## 回滚

- 变更集中在 `Dockerfile`（及简短构建注释/说明）。Git 回退即可恢复旧行为。
- 不引入新的集群组件。可疑「脏编译」时可用 `docker builder prune` 或 `--no-cache` 验证。

## 风险

| 风险 | 缓解 |
|------|------|
| cache 导致偶发脏编译 | prune / no-cache 对照构建 |
| mold 与某些原生依赖不兼容 | fallback 默认链接器或 lld |
| 流水线未开 BuildKit | 合入前确认；文档写明前置条件 |

## 文档落点

- 本设计文档。
- `Dockerfile` 头部注释补充：需要 BuildKit、适用场景（代码变更后的增量加速）。

## 后续修正（2026-08-11）

1. **去掉正式构建的 `cargo clean -p onebase --release`**  
   每次 clean 会毁掉本包增量；改为直接 `cargo build --release --bin onebase`，依赖仍由 stub 层缓存。若偶发 stub 指纹粘连，再临时加回窄清理。

2. **对象存储不用 aws-sdk-s3**  
   改用 `rusty-s3` + 现有 `reqwest`，避免 `aws-config` / `aws-lc-sys` 拉高冷依赖编译成本（本地与 Jenkins 在 `Cargo.toml` 变更时均受益）。
