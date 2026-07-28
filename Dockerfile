# 应用镜像：仅编译并运行 Rust API + Next.js。
# 不包含 PostgreSQL / Redis；通过环境变量连接外部服务。
#
# 构建：docker build -t onebase:app .
#
# 配置加载（与本地开发一致，后端在启动时调用 dotenv::dotenv() 按 cwd 读取 `.env`）：
#   • Rust 进程的 cwd 由 supervisor 设置为 /app（见 docker/supervisord.app.conf），
#     因此把 `.env` 放到容器内 /app/.env 即可被自动读取。
#   • docker run：`-v $(pwd)/.env:/app/.env:ro` 或 `--env-file .env`
#   • K8s：把 ConfigMap / Secret 以 `mountPath: /app/.env`（配 subPath: .env）挂成文件，
#     或直接用 envFrom 注入容器环境变量——两种方式都行，进程已存在的变量优先。
# 生产必填：`DATABASE_URL`、`JWT_SECRET`（≥16 字符且非占位）、`ENCRYPTION_KEY`（openssl rand -base64 32）
# 镜像默认 `RUST_ENV=production`，缺少上述项会直接 panic（进程退出码多为 101）。

# ============================================
# Stage 1: Rust backend
# ============================================
FROM rust:1.88-bookworm AS rust-builder

WORKDIR /build

COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && \
    mkdir -p src/bin && \
    echo "fn main() {}" > src/bin/migrate.rs && \
    echo "fn main() {}" > src/bin/migrate_examples.rs && \
    echo "fn main() {}" > src/bin/migrate_management.rs && \
    echo "fn main() {}" > src/bin/migrate_api_keys.rs && \
    echo "fn main() {}" > src/bin/migrate_rbac.rs && \
    echo "fn main() {}" > src/bin/migrate_sso.rs && \
    echo "fn main() {}" > src/bin/migrate_all.rs && \
    echo "fn main() {}" > src/bin/migrate_passwords.rs && \
    echo "fn main() {}" > src/bin/create_admin.rs && \
    echo "fn main() {}" > src/bin/fix_users.rs && \
    echo "fn main() {}" > src/bin/setup_multi_tenant.rs && \
    cargo build --release 2>/dev/null || true && \
    rm -rf src

COPY src/ src/
COPY migrations/ migrations/
RUN cargo clean -p onebase --release || true
RUN cargo build --release --bin onebase

# ============================================
# Stage 2: Next.js（standalone 产物，减小镜像）
# ============================================
FROM node:20-bookworm-slim AS frontend-builder

WORKDIR /build/frontend

COPY frontend-nextjs/package.json frontend-nextjs/package-lock.json* ./
RUN npm ci 2>/dev/null || npm install

COPY frontend-nextjs/ ./

# standalone 镜像 COPY 需要目录存在（仓库可无 public/）
RUN mkdir -p public

# 不注入 NEXT_PUBLIC_API_URL：
#   - 前端 axios baseURL 留空（lib/api.ts 已写好），浏览器走同源相对路径；
#   - 容器内的 Next.js 通过 rewrites 反代到 127.0.0.1:3000 上的 Rust API；
#   - 这样无论部署到什么域名 / IP，前端都不需要重新构建。
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ============================================
# Stage 3: Runtime（supervisor 同时拉起 API 与前端）
# ============================================
FROM debian:bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    curl \
    ca-certificates \
    gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/bin /app/frontend/.next/static /app/frontend/public /var/log/onebase

COPY --from=rust-builder /build/target/release/onebase /app/bin/

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
ENV HOST=0.0.0.0 \
    RUST_ENV=production

EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/health/ready || exit 1

ENTRYPOINT ["/app/docker/entrypoint-app.sh"]
