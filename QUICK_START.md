# OneBase 快速开始指南

## 🎉 欢迎使用 OneBase v0.2

这是一个 5 分钟快速开始指南，帮助你立即运行 OneBase。

## ⚡ 快速开始（5 分钟）

### 1. 安装依赖

确保已安装：
- Rust 1.70+
- PostgreSQL 12+

### 2. 创建数据库

```bash
# 创建数据库
createdb onebase_db

# 或使用 psql
psql -U postgres
CREATE DATABASE onebase_db;
\q
```

### 3. 配置环境变量

迁移工具会读 `.env` 里的 `DATABASE_URL`，因此**必须先配 `.env`，再去建表**。

创建 `.env` 文件：

```bash
cat > .env << EOF
# ── 必填：未设置或使用默认值时服务会直接 panic ──
JWT_SECRET=$(openssl rand -base64 48)
ENCRYPTION_KEY=$(openssl rand -base64 32)

# ── 必填：管理库连接串 ──
DATABASE_URL=postgresql://your_username:your_password@localhost:5432/onebase_db

# ── 可选：JWT 过期时间（秒），默认 86400（24 小时）──
JWT_EXPIRATION=86400

# ── 可选：监听地址 / 端口 / 日志 / 缓存 ──
HOST=127.0.0.1
PORT=3000
RUST_LOG=info,onebase=debug
REDIS_URL=redis://127.0.0.1:6379

# ── 可选：CORS 白名单，生产环境务必改为实际域名 ──
CORS_ORIGINS=*
EOF
```

⚠️ **重要**:
- 修改上面的数据库用户名和密码（`your_username` / `your_password`）。
- `JWT_SECRET` / `ENCRYPTION_KEY` 用 `openssl rand` 现场生成；shell 不支持命令替换时请手动执行 `openssl rand -base64 48` 和 `openssl rand -base64 32` 后填入。
- `ENCRYPTION_KEY` 用来加密租户数据库密码、SSO Token 等敏感数据，**一旦投入使用切勿更换**，否则历史数据无法解密。
- `REDIS_URL` 不可达时服务会以"无缓存模式"继续启动（启动期 3 秒超时即放行），不会阻塞登录；但权限缓存、限流、多实例事件会失效。

### 4. 初始化数据库表与超级管理员

不要手写建表 SQL——所有表结构由 `migrations/` 下的 SQL 文件统一定义，
请用一键迁移脚本：

```bash
# 一键执行 migrations/ 下全部迁移（幂等，重复跑不会出错）
# 创建 users / management.* / user_sessions 等所有管理库表
cargo run --bin migrate_all

# 创建 / 重置超级管理员账户
#   邮箱: admin@example.com
#   密码: Admin123
cargo run --bin create_admin
```

> 迁移成功后还会种入一个测试账号 `test@example.com / User1234`（普通 user 角色），方便区分超管和普通用户的权限差异。

### 5. 运行服务器

```bash
# 开发模式（自动重新编译）
cargo run

# 或者先编译再运行
cargo build
./target/debug/onebase
```

你应该看到：

```
🚀 服务器启动在 http://127.0.0.1:3000
📡 API 端点: http://127.0.0.1:3000/api/:schema/:table
```

### 6. 测试 API

#### 方法一：使用测试脚本（推荐）

```bash
chmod +x examples/auth_examples.sh
./examples/auth_examples.sh
```

#### 方法二：手动测试

**健康检查**:

```bash
curl http://localhost:3000/health
```

**用户注册**:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "myuser",
    "email": "my@example.com",
    "password": "MyPass123"
  }'
```

你会收到：

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": 1,
    "username": "myuser",
    "email": "my@example.com",
    "role": "user",
    "created_at": "2024-01-01 12:00:00"
  }
}
```

**用户登录**:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "my@example.com",
    "password": "MyPass123"
  }'
```

**获取用户信息** （需要 Token）:

```bash
# 替换 <TOKEN> 为上面返回的 token
curl -H "Authorization: Bearer <TOKEN>" \
  http://localhost:3000/auth/me
```

## 🎯 核心功能速览

### 1. 认证系统 ✅

- 用户注册和登录
- JWT Token 认证
- 密码安全存储
- Token 刷新

### 2. 数据库 CRUD ✅

```bash
# 查询数据
GET /api/public/users?status=active&limit=10

# 插入数据
POST /api/public/users
{
  "name": "张三",
  "email": "zhangsan@example.com"
}

# 更新数据
PATCH /api/public/users?id=1
{
  "name": "张三（已更新）"
}

# 删除数据
DELETE /api/public/users?id=1
```

### 3. 高级查询 ✅

```bash
# 过滤
GET /api/public/users?age.gte=18&status=active

# 排序
GET /api/public/users?order=created_at.desc

# 分页
GET /api/public/users?limit=20&offset=0

# 模糊查询
GET /api/public/users?name.like=%张%

# IN 查询
GET /api/public/users?status.in=active,pending
```

## 📚 下一步

### 详细文档

- [认证系统指南](./AUTH_GUIDE.md) - 完整的认证功能说明
- [API 示例大全](./API_EXAMPLES.md) - 所有 API 的使用示例
- [架构设计](./ARCHITECTURE.md) - 系统架构详解
- [迭代路线图](./ROADMAP.md) - 未来功能规划

### 示例和测试

- `examples/auth_examples.sh` - 认证 API 测试脚本
- `examples/schema.sql` - 示例数据库结构
- `examples/test-api.sh` - CRUD API 测试脚本
- `examples/frontend-demo.html` - 前端集成示例

### 配置优化

查看 `.env` 文件中的高级配置选项：

```env
# 数据库连接池（可选）
DB_MAX_CONNECTIONS=20
DB_MIN_CONNECTIONS=2
DB_ACQUIRE_TIMEOUT=30
DB_IDLE_TIMEOUT=600
DB_MAX_LIFETIME=1800

# JWT 配置（可选）
JWT_EXPIRATION=86400  # 24 小时
```

## ❓ 常见问题

### 1. 编译错误

```bash
# 清理并重新编译
cargo clean
cargo build
```

### 2. 数据库连接失败

检查 `.env` 中的 `DATABASE_URL` 是否正确：

```bash
# 测试数据库连接
psql "postgresql://username:password@localhost:5432/onebase_db"
```

### 3. Token 验证失败

确保在 Header 中正确传递 Token：

```bash
Authorization: Bearer <your_token_here>
```

### 4. 密码验证失败

密码必须满足：
- 至少 8 个字符
- 包含大写字母
- 包含小写字母
- 包含数字

例如：`MyPass123` ✅

## 🐛 遇到问题？

1. 查看日志：`RUST_LOG=debug cargo run`
2. 检查健康状态：`curl http://localhost:3000/health`
3. 查看详细文档：[AUTH_GUIDE.md](./AUTH_GUIDE.md)

## 🎊 成功启动！

现在你已经成功运行 OneBase！

**可以做什么？**

- ✅ 注册和登录用户
- ✅ 对任何 PostgreSQL 表进行 CRUD 操作
- ✅ 使用高级查询（过滤、排序、分页）
- ✅ 通过 JWT 保护你的 API

**下一步建议**：

1. 创建你自己的数据表
2. 使用 API 进行 CRUD 操作
3. 集成到你的前端应用
4. 查看路线图规划未来功能

---

**祝开发愉快！** 🚀

如有问题，请查看详细文档或提交 Issue。

