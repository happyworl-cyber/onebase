# OneBase 快速部署指南

## 📋 前置要求

1. **Rust** (1.70+)
   ```bash
   # 安装 Rust
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   
   # 验证安装
   rustc --version
   cargo --version
   ```

2. **PostgreSQL** (12+)
   ```bash
   # Ubuntu/Debian
   sudo apt update
   sudo apt install postgresql postgresql-contrib
   
   # macOS
   brew install postgresql@14
   
   # Windows
   # 从 https://www.postgresql.org/download/windows/ 下载安装
   ```

## 🚀 快速开始

### 1. 克隆项目（如果适用）

```bash
git clone <your-repo-url>
cd onebase
```

### 2. 配置数据库

```bash
# 启动 PostgreSQL
sudo systemctl start postgresql  # Linux
brew services start postgresql   # macOS

# 登录 PostgreSQL
sudo -u postgres psql

# 创建用户和数据库（让用户成为数据库 owner，
# 这样在 PostgreSQL 15+ 上才能直接在 public schema 建表，迁移工具也能建 management schema）
CREATE USER onebase_user WITH ENCRYPTED PASSWORD 'your_password';
CREATE DATABASE onebase_db OWNER onebase_user;
GRANT ALL PRIVILEGES ON DATABASE onebase_db TO onebase_user;

# 退出 psql
\q

# 验证可登录
psql -U onebase_user -h 127.0.0.1 -d onebase_db -c "SELECT current_user, current_database();"
```

### 3. 配置环境变量

迁移工具会读 `.env` 里的 `DATABASE_URL`，因此**必须先配 `.env`，再去建表**。

```bash
# 复制示例配置
cat > .env << EOF
# ── 必填：未设置或使用默认值时服务会直接 panic ──
JWT_SECRET=$(openssl rand -base64 48)
ENCRYPTION_KEY=$(openssl rand -base64 32)

# ── 必填：管理库连接串 ──
DATABASE_URL=postgresql://onebase_user:your_password@localhost:5432/onebase_db

# ── 可选：监听地址 / 端口 / 日志 / 缓存 ──
HOST=127.0.0.1
PORT=3000
RUST_LOG=info,onebase=debug
REDIS_URL=redis://127.0.0.1:6379

# ── 可选：CORS 白名单，生产环境务必改为实际域名 ──
CORS_ORIGINS=*
EOF
```

**重要**:
- 将 `your_password` 替换为你在第 2 步实际设置的数据库密码。
- `JWT_SECRET` / `ENCRYPTION_KEY` 这里用 `openssl rand` 现场生成；如果你的 shell 不支持命令替换，请手动执行 `openssl rand -base64 48` 和 `openssl rand -base64 32` 后粘贴回去。
- `ENCRYPTION_KEY` 一旦投入使用就不要再换——它用来加密租户数据库密码、SSO Token 等历史数据，丢失/更改会导致历史数据无法解密。
- `REDIS_URL` 不可达时服务会以"无缓存模式"继续启动（启动期 3 秒超时即放行），不会阻塞登录；但权限缓存、限流、多实例事件会失效。

### 4. 初始化数据库表与超级管理员

**不要手写建表 SQL**——所有表结构由 `migrations/` 下的 SQL 文件统一定义，
对应有专门的 Rust 迁移工具。最便捷的方式是一键 `migrate_all`：

```bash
# 一键执行 migrations/ 下全部迁移（幂等，重复跑不会出错）
# 涵盖 users / management.* / user_sessions / 默认 RBAC 权限种子等
cargo run --bin migrate_all

# 创建 / 重置超级管理员账号
#   邮箱: admin@example.com
#   密码: Admin123
cargo run --bin create_admin
```

成功后会建出：

- `users`：`id / username / email / password_hash / role / is_superadmin / created_at / updated_at`
- `user_sessions`：JWT jti 登记表（登录写入、登出 / 改密码时吊销）
- `management.*`：租户、数据库连接、角色、权限、SSO、Webhook、审计日志、API Key、网关规则等

并预置两个种子账号供登录验证：

| 账号 | 密码 | 角色 |
|------|------|------|
| `admin@example.com` | `Admin123` | `is_superadmin=true` |
| `test@example.com` | `User1234` | `role=user`（普通用户） |

> 想随时重置 admin 密码：`cargo run --bin create_admin` 会重新写入正确的 bcrypt 哈希。

如果只想跑某个子集，也可以单独执行：

| 命令 | 作用 |
|---|---|
| `cargo run --bin migrate` | 只建 `users` 表 |
| `cargo run --bin migrate_management` | 多租户管理表（`management.tenants` 等） |
| `cargo run --bin migrate_rbac` | RBAC 角色 / 权限表 |
| `cargo run --bin migrate_sso` | SSO Provider 表 |
| `cargo run --bin migrate_examples` | 示例业务表（categories/products/orders，演示 ER 图用） |

> 验证迁移成功：`psql -U onebase_user -d onebase_db -c "\dt management.*"`，应能看到一组 `tenants / tenant_databases / roles / permissions / sso_providers / webhooks / audit_logs / api_keys / ...`。

### 5. 运行项目

```bash
# 开发模式（自动重新编译）
cargo run

# 或者先编译再运行
cargo build
./target/debug/onebase

# 生产模式（优化编译）
cargo build --release
./target/release/onebase
```

你应该看到：

```
🚀 服务器启动在 http://127.0.0.1:3000
📡 API 端点: http://127.0.0.1:3000/api/:schema/:table
```

### 6. 测试 API

OneBase 的所有数据接口都需要先**登录**拿到 JWT，再带 `Authorization: Bearer <token>` 头访问。
打开新终端按下面的顺序验证：

```bash
# 1. 健康探针——确认服务在跑（无需登录）
curl http://localhost:3000/health

# 2. 用第 4 步创建的超级管理员登录，把返回的 token 存到 shell 变量
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"Admin123"}' \
  | grep -o '"token":"[^"]*"' | cut -d '"' -f 4)
echo "TOKEN=${TOKEN:0:20}..."

# 3. 查看自己的身份信息（验证 token 有效）
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/auth/me

# 4. 列出当前数据库的所有 schema（仅超管）
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/schemas

# 5. 列出 public schema 下的表
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/schema/public/tables

# 6. 查看 users 表结构
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/schema/public/table/users/structure
```

#### 业务侧 CRUD（推荐路径）

老的 `/api/:schema/:table` 接口现在仅超管可访问，且**完全旁路 RBAC**，仅用于平台运维；
业务方应该走 Auto API：`/api/v1/{database_id}/{schema}/{table}`，它会经过：

- 鉴权（JWT 或 API Key）
- RBAC 行/列级权限校验
- PostgreSQL Row-Level Security（如配置）

具体用法见 `README.md` 的 **🔌 Auto API** 一节，或 `examples/auth_examples.sh`。

> 如果只是想本地随便插点测试数据 ER 图，跑一下 `cargo run --bin migrate_examples`，
> 它会建出 `categories / products / orders / order_items` 等带外键关系的示例表。

### 7. 测试前端示例

```bash
# 在浏览器中打开
# 方式 1: 直接用浏览器打开文件
open examples/frontend-demo.html  # macOS
xdg-open examples/frontend-demo.html  # Linux
start examples/frontend-demo.html  # Windows

# 方式 2: 使用简单 HTTP 服务器
cd examples
python3 -m http.server 8080
# 然后访问 http://localhost:8080/frontend-demo.html
```

## 🔧 常见问题

### 问题 1: 数据库连接失败

```
Error: database connection failed
```

**解决方案**:
1. 检查 PostgreSQL 是否运行：`sudo systemctl status postgresql`
2. 验证 `.env` 中的数据库 URL 是否正确
3. 测试数据库连接：`psql -U onebase_user -d onebase_db`

### 问题 1.5: 登录返回 500 / "邮箱或密码错误"

**症状**：用 `admin@example.com / Admin123` 登录失败，前端报 500，后端日志里能看到
`relation "user_sessions" does not exist` 或 `登记会话失败`。

**根因**：缺少 `012_jwt_sessions.sql` 这条迁移建出来的会话登记表（旧版本 `migrate_all`
漏掉了 011/012）。

**解决方案**：
```bash
# 重跑一遍即可幂等补齐
cargo run --bin migrate_all

# 或单独执行
psql -U onebase_user -d onebase_db -f migrations/011_seed_default_permissions.sql
psql -U onebase_user -d onebase_db -f migrations/012_jwt_sessions.sql

# 想顺手重置超管密码
cargo run --bin create_admin
```

### 问题 2: 编译错误

```
error: could not compile `onebase`
```

**解决方案**:
1. 更新 Rust：`rustup update`
2. 清理缓存：`cargo clean`
3. 重新编译：`cargo build`

### 问题 3: CORS 错误

```
CORS policy blocked
```

**解决方案**:
已配置 CORS 允许所有来源。如果仍有问题，检查浏览器控制台的具体错误信息。

### 问题 4: 端口被占用

```
Address already in use
```

**解决方案**:
1. 更改 `.env` 中的 `PORT` 值
2. 或者终止占用端口的进程：
   ```bash
   # Linux/macOS
   lsof -ti:3000 | xargs kill -9
   
   # Windows
   netstat -ano | findstr :3000
   taskkill /PID <PID> /F
   ```

## 📦 生产部署

### 使用 Docker（推荐）

创建 `Dockerfile`:

```dockerfile
FROM rust:1.75 as builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y libssl3 ca-certificates
COPY --from=builder /app/target/release/onebase /usr/local/bin/
EXPOSE 3000
CMD ["onebase"]
```

创建 `docker-compose.yml`:

```yaml
version: '3.8'

services:
  db:
    image: postgres:14
    environment:
      POSTGRES_DB: onebase_db
      POSTGRES_USER: onebase_user
      POSTGRES_PASSWORD: your_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://onebase_user:your_password@db:5432/onebase_db
      HOST: 0.0.0.0
      PORT: 3000
    depends_on:
      - db

volumes:
  postgres_data:
```

运行：

```bash
docker-compose up -d
```

### 使用 Systemd（Linux）

创建服务文件 `/etc/systemd/system/onebase.service`:

```ini
[Unit]
Description=OneBase API Server
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/onebase
Environment="DATABASE_URL=postgresql://onebase_user:password@localhost/onebase_db"
Environment="HOST=0.0.0.0"
Environment="PORT=3000"
ExecStart=/opt/onebase/target/release/onebase
Restart=always

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable onebase
sudo systemctl start onebase
sudo systemctl status onebase
```

### 使用 Nginx 反向代理

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 🔒 安全建议

1. **生产环境**：
   - 使用强密码
   - 启用 SSL/TLS
   - 限制数据库用户权限
   - 使用防火墙限制访问

2. **数据库权限**：
   ```sql
   -- 只授予必要的权限
   REVOKE ALL ON DATABASE onebase_db FROM onebase_user;
   GRANT CONNECT ON DATABASE onebase_db TO onebase_user;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onebase_user;
   ```

3. **环境变量**：
   - 永远不要提交 `.env` 文件到版本控制
   - 使用密钥管理服务（如 AWS Secrets Manager）

## 📊 性能优化

1. **数据库索引**：
   ```sql
   CREATE INDEX idx_users_status ON users(status);
   CREATE INDEX idx_users_created_at ON users(created_at);
   ```

2. **连接池大小**（在 `src/db.rs` 中调整）：
   ```rust
   PgPoolOptions::new()
       .max_connections(20)  // 根据负载调整
       .connect(database_url)
       .await?
   ```

3. **日志级别**：
   ```env
   # 生产环境使用 info 或 warn
   RUST_LOG=warn,onebase=info
   ```

## 🆘 获取帮助

- 查看日志：`RUST_LOG=debug cargo run`
- 测试数据库连接：`psql -U onebase_user -d onebase_db`
- 检查端口：`netstat -tuln | grep 3000`

祝你使用愉快！🎉

