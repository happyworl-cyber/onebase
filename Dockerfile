# syntax=docker.m.daocloud.io/docker/dockerfile:1
# 应用镜像：仅编译并运行 Rust API + Next.js。
# 不包含 PostgreSQL / Redis；通过环境变量连接外部服务。
#
# 构建（需要 BuildKit；Jenkins 请设 DOCKER_BUILDKIT=1 或使用 buildx）：
#   DOCKER_BUILDKIT=1 docker build -t onebase:app .
#
# 缓存策略：
#   • Rust 依赖编译进镜像层（stub 阶段）。改 src/ 时复用该层，只重编 onebase，避免
#     把 target 只放在 BuildKit cache mount 里——Jenkins cache 一旦丢失会变成全量冷编译。
#   • cargo registry/git 与 npm 使用 cache mount，加速 lockfile 变更时的下载。
#   • syntax 镜像走 DaoCloud，避免每次从 docker.io 拉 dockerfile frontend。
#
# 配置加载（与本地开发一致，后端在启动时调用 dotenv::dotenv() 按 cwd 读取 `.env`）：
#   • Rust 进程的 cwd 由 supervisor 设置为 /app（见 docker/supervisord.app.conf），
#     因此把 `.env` 放到容器内 /app/.env 即可被自动读取。
#   • docker run：`-v $(pwd)/.env:/app/.env:ro` 或 `--env-file .env`
#   • K8s：把 ConfigMap / Secret 以 `mountPath: /app/.env`（配 subPath: .env）挂成文件，
#     或直接用 envFrom 注入容器环境变量——两种方式都行，进程已存在的变量优先。
# 生产必填：`DATABASE_URL`、`JWT_SECRET`（≥16 字符且非占位）、`ENCRYPTION_KEY`（openssl rand -base64 32）
# 镜像默认 `RUST_ENV=production`，缺少上述项会直接 panic（进程退出码多为 101）。

# 基础镜像源（registry）。默认走 DaoCloud 的 Docker Hub 镜像加速，绕开经常 403/超时的源。
# 如该源也不可用，构建时可覆盖，例如：
#   docker build --build-arg REGISTRY=docker.1ms.run/library -t onebase:app .
#   docker build --build-arg REGISTRY=docker.io/library  -t onebase:app .   # 直连官方
# 备选可用源（任选其一作为 REGISTRY 值）：
#   docker.m.daocloud.io/library | docker.1ms.run/library | docker.xuanyuan.me/library | hub.rat.dev/library
ARG REGISTRY=docker.m.daocloud.io/library

# ============================================
# Stage 1: Rust backend
# ============================================
FROM ${REGISTRY}/rust:1.88-bookworm AS rust-builder

WORKDIR /build

# rdkafka（cmake-build + ssl + sasl）需要本机头文件与链接库。
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    g++ \
    pkg-config \
    libssl-dev \
    libsasl2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock* ./
# 依赖预热：stub 必须覆盖 Cargo.toml 全部 [[bin]]（缺文件会导致 cargo 直接失败）；
# 产物写入镜像层。失败必须暴露，禁止 || true 假成功，否则正式编译会变成冷编。
# 只编 --bin onebase：拉齐主服务依赖即可，不必链接其余 migrate bin。
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    mkdir src && echo "fn main() {}" > src/main.rs && \
    mkdir -p src/bin && \
    echo "fn main() {}" > src/bin/migrate.rs && \
    echo "fn main() {}" > src/bin/migrate_examples.rs && \
    echo "fn main() {}" > src/bin/migrate_management.rs && \
    echo "fn main() {}" > src/bin/migrate_api_keys.rs && \
    echo "fn main() {}" > src/bin/migrate_rbac.rs && \
    echo "fn main() {}" > src/bin/migrate_sso.rs && \
    echo "fn main() {}" > src/bin/migrate_all.rs && \
    echo "fn main() {}" > src/bin/migrate_passwords.rs && \
    echo "fn main() {}" > src/bin/migrate_scheduled_tasks.rs && \
    echo "fn main() {}" > src/bin/migrate_workflow.rs && \
    cargo build --release --bin onebase && \
    rm -rf src

COPY src/ src/
COPY migrations/ migrations/
# 清掉 stub 同名 crate，保留 deps；只重编 onebase。
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo clean -p onebase --release || true && \
    cargo build --release --bin onebase

# 工作流 code 节点运行时 shim（JS / Python），随镜像分发；运行阶段拷到 /app 并用
# WORKFLOW_JS_RUNTIME / WORKFLOW_PY_RUNTIME 指向，避免依赖编译期 CARGO_MANIFEST_DIR。
COPY js-runtime/ js-runtime/
COPY py-runtime/ py-runtime/

# ============================================
# Stage 2: Next.js（standalone 产物，减小镜像）
# ============================================
FROM ${REGISTRY}/node:20-bookworm-slim AS frontend-builder

WORKDIR /build/frontend

COPY frontend-nextjs/package.json frontend-nextjs/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci 2>/dev/null || npm install

COPY frontend-nextjs/ ./

# standalone 镜像 COPY 需要目录存在（仓库可无 public/）
RUN mkdir -p public

# 不注入 NEXT_PUBLIC_API_URL：
#   - 前端 axios baseURL 留空（lib/api.ts 已写好），浏览器走同源相对路径；
#   - 容器内的 Next.js 通过 rewrites 反代到 127.0.0.1:3000 上的 Rust API；
#   - 这样无论部署到什么域名 / IP，前端都不需要重新构建。
ENV NEXT_TELEMETRY_DISABLED=1

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm run build

# ============================================
# Stage 3: Runtime（supervisor 同时拉起 API 与前端）
# ============================================
FROM ${REGISTRY}/debian:bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    curl \
    ca-certificates \
    gnupg \
    libssl3 \
    libsasl2-2 \
    python3 \
    python3-pip \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/bin /app/frontend/.next/static /app/frontend/public /var/log/onebase

COPY --from=rust-builder /build/target/release/onebase /app/bin/

# 工作流 JS / Python code 节点的运行时 shim（供子进程加载）。
COPY --from=rust-builder /build/js-runtime /app/js-runtime
COPY --from=rust-builder /build/py-runtime /app/py-runtime

# Next.js standalone：server.js + 精简依赖（next.config.js 已启用 output: 'standalone'）
COPY --from=frontend-builder /build/frontend/.next/standalone/ /app/frontend/
COPY --from=frontend-builder /build/frontend/.next/static /app/frontend/.next/static
COPY --from=frontend-builder /build/frontend/public/ /app/frontend/public/

COPY docker/supervisord.app.conf /etc/supervisor/conf.d/onebase-app.conf
COPY docker/entrypoint-app.sh /app/docker/entrypoint-app.sh
RUN chmod +x /app/docker/entrypoint-app.sh

# 仅保留"容器必须"的环境变量；其余配置（DATABASE_URL / REDIS_URL / JWT_SECRET /
# ENCRYPTION_KEY / CORS_ORIGINS / PORT / 各种超时 / 限流等）一律由挂入 /app/.env
# 的文件或编排层注入。
#
# 注意：dotenv 不会覆盖进程里已存在的环境变量，所以这里写进 ENV 的值会"压住" .env
# 里的同名键，反而违反 .env-as-source-of-truth 的约定。除非该值在容器里必须固定。
#
#  - HOST=0.0.0.0：监听地址必须是全网卡，否则 docker -p 端口映射拿不到流量；
#    src/config.rs 的代码兜底是 127.0.0.1，不适合容器，所以这一行保留。
#  - RUST_ENV=production：强制后端进入生产模式（JWT_SECRET / ENCRYPTION_KEY 缺失会 fail-fast）。
#  - WORKFLOW_JS_RUNTIME / WORKFLOW_PY_RUNTIME：code 节点运行时 shim 在镜像内的固定位置
#    （编译期 CARGO_MANIFEST_DIR 在运行镜像里不存在，必须显式指向）。
ENV HOST=0.0.0.0 \
    RUST_ENV=production \
    WORKFLOW_JS_RUNTIME=/app/js-runtime/onebase-runtime/index.js \
    WORKFLOW_PY_RUNTIME=/app/py-runtime/onebase_runtime

EXPOSE 3000 3001

# 容器自愈探针只看**进程存活**（/health/live，不碰 DB）。
# 关键：绝不能用 /health/ready（会做 DB 探活）——管理库连接池被业务/调度短时打满时，
# ready 会失败，进而触发容器/编排层重启，重启带来冷连接池 + 迁移 advisory lock，
# 反而加剧耗尽，形成"打满→重启→再打满"的循环。摘流（readiness）应由外部
# 负载均衡 / k8s readinessProbe 打 /health/ready 完成，不应让进程自杀。
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/health/live || exit 1

ENTRYPOINT ["/app/docker/entrypoint-app.sh"]
