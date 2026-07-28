# OneBase

一个轻量级、高性能的 PostgreSQL RESTful API 服务器，使用 Rust 实现，参考 PostgREST 设计理念。

## 🚦 生产部署前必读（Secrets / 加密 / RBAC）

在公司或多租户环境部署前，请务必把下面四件事做完，否则会有"任意用户提权 / 数据库密码可被解密 / SQL 注入"等高危风险：

### 1. 准备 `.env`（不要提交 git）

```bash
cp .env.example .env
# 填入：
#   JWT_SECRET=$(openssl rand -base64 48)
#   ENCRYPTION_KEY=$(openssl rand -base64 32)
#   CORS_ORIGINS=https://your-app.example.com
```

- `JWT_SECRET`：JWT 签名密钥（最少 16 字符，强烈建议 ≥ 32）。启动时会拒绝默认值并 panic。
- `ENCRYPTION_KEY`：AES-256-GCM 主密钥（base64 解码后必须正好 32 字节）。
  租户数据库连接密码、SSO Token 等都用它加密；丢失意味着无法解密历史数据。
- `CORS_ORIGINS`：白名单逗号分隔；生产**不要**用 `*`。

### 2. 升级历史 base64 密码到 v2 加密格式

如果你之前已经用过老版本（密码以裸 base64 存的），重启容器后会自动跑：

```bash
/app/bin/migrate_passwords
```

把所有非 `v2:` 的 `tenant_databases.db_password_encrypted` 重新加密为
`v2:<base64(nonce || aes-256-gcm)>`。该工具是幂等的，可重复执行；同时不会打印明文密码。

### 3. RBAC：角色 / 权限分层

- **超级管理员（`is_superadmin = true`）**：唯一可访问 `/query`、`/transaction`、
  老的 `/api/:schema/:table`、跨租户审计、SSO Provider 管理等"平台级"接口。
- **租户 owner / admin**：可管理本租户的 API Key、Webhook、查看本租户审计日志。
- **业务用户（viewer / editor / 自定义角色）**：通过 `/api/v1/{db_id}/{schema}/{table}` 走 RBAC 中间件，
  权限以 `permissions(resource, action, conditions, allowed_columns)` 表配置；行级条件只接受结构化 DSL，不允许写 SQL 字符串。

新建租户时会自动 seed 一组默认权限（`viewer/editor/admin/superadmin`），可在 `/api/rbac/permissions` 进一步定制。

> 把 Onebase 当社区 / SaaS 后端使用、需要"每个用户只能看到自己数据"的场景，
> 见 [docs/community-data-isolation.md](docs/community-data-isolation.md)（业务级 RBAC）
> 与 [docs/postgres-rls-guide.md](docs/postgres-rls-guide.md)（数据级 PostgreSQL RLS）。
> 两者叠加构成"双层防线"，覆盖个人资料 / 帖子 / 私信 / 点赞等典型场景，
> 并给出 20 万 DAU 量级的扩展性建议。

### 4. JWT 服务端可吊销

- 每次签发都会写入 `user_sessions(jti, user_id, expires_at, ...)`。
- 中间件每次请求都校验 jti 仍然存在且 `revoked = false`。
- `/auth/logout` 立即吊销当前 jti；`/auth/change-password` 默认会吊销该用户**其它**所有活跃会话；
  `/auth/refresh` 会旋转 jti（旧 token 立即失效）。

详见下文 **🔐 安全机制** 一节。

---

## ✨ 特性

- 🚀 **高性能**: 基于 Axum 和 Tokio 的异步 Rust 实现
- 🔒 **安全**: 参数化查询，防止 SQL 注入
- 🎯 **简单**: 自动生成 RESTful API，无需编写路由代码
- 🔍 **强大查询**: 支持过滤、排序、分页、模糊查询、范围查询、IN 查询等
- 🌐 **CORS 支持**: 开箱即用的跨域支持
- 📦 **零依赖**: 只需 PostgreSQL 数据库

## 🏗️ 架构

```
/api/:schema/:table
```

- `schema`: PostgreSQL schema 名称（如 `public`）
- `table`: 表名

支持的 HTTP 方法：
- `GET`: 查询数据
- `POST`: 插入数据
- `PATCH`: 更新数据
- `DELETE`: 删除数据

## 🚀 快速开始

### 1. 环境准备

确保已安装：
- Rust 1.70+ (`rustup install stable`)
- PostgreSQL 数据库

### 2. 配置环境变量

创建 `.env` 文件：

```env
DATABASE_URL=postgresql://username:password@localhost:5432/database_name
HOST=127.0.0.1
PORT=3000
RUST_LOG=info
REDIS_URL=redis://127.0.0.1:6379
```

完整的环境变量参考（含 `JWT_SECRET` / `ENCRYPTION_KEY` 等必填项）见 `.env.example`。

> `REDIS_URL` 不可达时服务会在启动期 3 秒超时后以"无缓存模式"继续启动；权限缓存、限流、多实例事件会失效，但登录等核心功能不受影响。

### 3. 初始化数据库

`migrations/` 目录下的 SQL 由 Rust 迁移工具统一执行（幂等）：

```bash
# 一键建出 users / management.* / user_sessions / 默认权限种子等
cargo run --bin migrate_all

# 创建超级管理员（默认 admin@example.com / Admin123）
cargo run --bin create_admin
```

迁移成功后会预置两个种子账号：

| 账号 | 密码 | 角色 |
|------|------|------|
| `admin@example.com` | `Admin123` | `is_superadmin=true` |
| `test@example.com` | `User1234` | `role=user` |

> 想随时重置 admin 密码，再跑一次 `cargo run --bin create_admin` 即可。
> 详细安装步骤见 [SETUP.md](./SETUP.md)。

### 4. 运行服务器

```bash
# 开发模式
cargo run

# 生产模式
cargo build --release
./target/release/onebase
```

服务器将在 `http://127.0.0.1:3000` 启动。

## 🎨 Web 管理后台

OneBase 提供了一个现代化的 Web 管理界面！

### 快速访问

```
http://localhost:3000/admin/
```

**默认登录账号**:
- 邮箱: `admin@example.com`
- 密码: `Admin123`

### 功能特性

- 📊 **数据表管理** - 浏览、搜索、编辑、删除数据
- 💻 **SQL 查询器** - 执行自定义 SQL 查询
- ⚡ **事务管理** - 可视化构建和执行事务
- 👥 **用户管理** - 查看和管理用户账号
- 🎯 **健康监控** - 实时查看系统状态

**详细文档**: 查看 [ADMIN_GUIDE.md](./ADMIN_GUIDE.md)

---

## 📖 API 使用文档

### 查询数据 (GET)

#### 基本查询

```bash
# 获取所有记录
GET /api/public/users

# 选择特定字段
GET /api/public/users?select=id,name,email
```

#### 过滤条件

```bash
# 等于
GET /api/public/users?id=1
GET /api/public/users?id.eq=1

# 不等于
GET /api/public/users?status.neq=inactive

# 大于/大于等于
GET /api/public/users?age.gt=18
GET /api/public/users?age.gte=18

# 小于/小于等于
GET /api/public/users?age.lt=65
GET /api/public/users?age.lte=65

# 模糊查询
GET /api/public/users?name.like=%张%
GET /api/public/users?name.ilike=%zhang%  # 不区分大小写

# IN 查询
GET /api/public/users?status.in=active,pending,verified

# NULL 查询
GET /api/public/users?deleted_at.is=null
GET /api/public/users?deleted_at.is=notnull

# 组合条件 (AND)
GET /api/public/users?age.gte=18&status=active
```

#### 排序

```bash
# 升序 (默认)
GET /api/public/users?order=created_at
GET /api/public/users?order=created_at.asc

# 降序
GET /api/public/users?order=created_at.desc

# 多字段排序
GET /api/public/users?order=status.asc,created_at.desc
```

#### 分页

```bash
# 限制返回数量
GET /api/public/users?limit=10

# 偏移量
GET /api/public/users?limit=10&offset=20

# 组合使用 (第 3 页，每页 10 条)
GET /api/public/users?limit=10&offset=20
```

#### 综合示例

```bash
GET /api/public/users?select=id,name,email&status=active&age.gte=18&order=created_at.desc&limit=20&offset=0
```

### 插入数据 (POST)

#### 单条插入

```bash
POST /api/public/users
Content-Type: application/json

{
  "name": "张三",
  "email": "zhangsan@example.com",
  "age": 25
}
```

#### 批量插入

```bash
POST /api/public/users
Content-Type: application/json

[
  {
    "name": "张三",
    "email": "zhangsan@example.com",
    "age": 25
  },
  {
    "name": "李四",
    "email": "lisi@example.com",
    "age": 30
  }
]
```

### 更新数据 (PATCH)

```bash
# 必须提供过滤条件
PATCH /api/public/users?id=1
Content-Type: application/json

{
  "name": "张三（已更新）",
  "age": 26
}

# 批量更新
PATCH /api/public/users?status=pending
Content-Type: application/json

{
  "status": "active"
}
```

### 删除数据 (DELETE)

```bash
# 必须提供过滤条件
DELETE /api/public/users?id=1

# 批量删除
DELETE /api/public/users?status=inactive
```

## 🌐 前端调用示例

### JavaScript/TypeScript (Fetch)

```javascript
// 查询
async function getUsers() {
  const response = await fetch('http://localhost:3000/api/public/users?limit=10&order=created_at.desc');
  const users = await response.json();
  console.log(users);
}

// 插入
async function createUser(user) {
  const response = await fetch('http://localhost:3000/api/public/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(user),
  });
  const newUser = await response.json();
  console.log(newUser);
}

// 更新
async function updateUser(id, updates) {
  const response = await fetch(`http://localhost:3000/api/public/users?id=${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });
  const updatedUser = await response.json();
  console.log(updatedUser);
}

// 删除
async function deleteUser(id) {
  const response = await fetch(`http://localhost:3000/api/public/users?id=${id}`, {
    method: 'DELETE',
  });
  const deletedUser = await response.json();
  console.log(deletedUser);
}
```

### React Hooks 示例

```jsx
import { useState, useEffect } from 'react';

function UserList() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const response = await fetch('http://localhost:3000/api/public/users?order=created_at.desc');
      const data = await response.json();
      setUsers(data);
    } catch (error) {
      console.error('获取用户失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const createUser = async (userData) => {
    try {
      const response = await fetch('http://localhost:3000/api/public/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userData),
      });
      const newUser = await response.json();
      setUsers([newUser, ...users]);
    } catch (error) {
      console.error('创建用户失败:', error);
    }
  };

  const updateUser = async (id, updates) => {
    try {
      const response = await fetch(`http://localhost:3000/api/public/users?id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const updatedUser = await response.json();
      setUsers(users.map(u => u.id === id ? updatedUser[0] : u));
    } catch (error) {
      console.error('更新用户失败:', error);
    }
  };

  const deleteUser = async (id) => {
    try {
      await fetch(`http://localhost:3000/api/public/users?id=${id}`, {
        method: 'DELETE',
      });
      setUsers(users.filter(u => u.id !== id));
    } catch (error) {
      console.error('删除用户失败:', error);
    }
  };

  if (loading) return <div>加载中...</div>;

  return (
    <div>
      <h1>用户列表</h1>
      {users.map(user => (
        <div key={user.id}>
          <span>{user.name}</span>
          <button onClick={() => updateUser(user.id, { name: '新名字' })}>
            更新
          </button>
          <button onClick={() => deleteUser(user.id)}>删除</button>
        </div>
      ))}
    </div>
  );
}
```

### Axios 示例

```javascript
import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3000/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// 查询
const getUsers = async (params = {}) => {
  const { data } = await api.get('/public/users', { params });
  return data;
};

// 插入
const createUser = async (user) => {
  const { data } = await api.post('/public/users', user);
  return data;
};

// 更新
const updateUser = async (id, updates) => {
  const { data } = await api.patch('/public/users', updates, {
    params: { id },
  });
  return data;
};

// 删除
const deleteUser = async (id) => {
  const { data } = await api.delete('/public/users', {
    params: { id },
  });
  return data;
};

// 使用示例
async function example() {
  // 获取活跃用户，按创建时间降序，前 20 条
  const users = await getUsers({
    status: 'active',
    'order': 'created_at.desc',
    limit: 20,
  });

  // 创建用户
  const newUser = await createUser({
    name: '张三',
    email: 'zhangsan@example.com',
  });

  // 更新用户
  await updateUser(newUser.id, { status: 'verified' });

  // 删除用户
  await deleteUser(newUser.id);
}
```

## 🔐 安全性

### SQL 注入防护

- 所有表名、字段名都经过严格验证（只允许字母、数字、下划线）
- 所有值都使用参数化查询，不进行字符串拼接
- 自动使用双引号包裹标识符，防止关键字冲突

### 建议

1. **数据库权限**: 为 API 创建专用数据库用户，只授予必要的权限
2. **网络隔离**: 在生产环境中，API 服务器应部署在私有网络
3. **反向代理**: 使用 Nginx/Caddy 添加额外的安全层（rate limiting、WAF 等）
4. **认证授权**: 考虑在前端添加认证层，或使用数据库的行级安全策略（RLS）

## 📁 项目结构

```
onebase/
├── Cargo.toml              # 依赖配置
├── .env                    # 环境变量（不提交到版本控制）
├── src/
│   ├── main.rs            # 主入口，启动服务器
│   ├── config.rs          # 配置管理
│   ├── db.rs              # 数据库连接池
│   ├── error.rs           # 错误处理
│   ├── handlers.rs        # HTTP 请求处理器
│   └── query_builder.rs   # SQL 查询构建器（核心）
└── README.md              # 项目文档
```

## 🎯 核心设计

### 查询参数解析

`query_builder.rs` 是核心模块，负责将 URL 查询参数安全地转换为 SQL 查询：

1. **参数验证**: 所有标识符（表名、字段名）都经过严格验证
2. **操作符映射**: 支持 `.eq`、`.gt`、`.like` 等丰富的操作符
3. **参数化查询**: 使用 `sqlx` 的参数绑定，完全避免 SQL 注入
4. **灵活组合**: 支持多条件组合、排序、分页等

### 示例 SQL 生成

输入：
```
GET /api/public/users?age.gte=18&status=active&order=created_at.desc&limit=10
```

生成的 SQL：
```sql
SELECT * FROM "public"."users" 
WHERE "age" >= $1 AND "status" = $2 
ORDER BY "created_at" DESC 
LIMIT $3
```

参数：`[18, "active", 10]`

## 🚧 迭代路线图

> **目标**: 打造完整的商业级产品，对标 PostgREST 和 Supabase  
> **当前版本**: v0.1.0 (MVP) - 完成度 20%  
> **开发模式**: 🤖 全程 AI 辅助编码  
> **详细路线图**: 查看 [ROADMAP.md](./ROADMAP.md)

### 快速概览（AI 辅助加速版）

| 阶段 | 时间（AI辅助） | 累计时间 | 核心功能 | 完成度 |
|------|---------------|----------|----------|--------|
| ✅ MVP | 已完成 | - | 基础 CRUD、过滤、排序、分页 | 20% |
| 🚀 第一阶段 | 2-3 天 | 第 1 周 | JWT认证、数据验证、API 文档 | 40% |
| 🔥 第二阶段 | 5-7 天 | 第 2-3 周 | 权限控制、事务、JOIN 查询、缓存 | 60% |
| 💼 第三阶段 | 2-3 周 | 第 4-6 周 | 业务逻辑引擎、监控告警 | 80% |
| ☁️ 第四阶段 | 1-2 月 | 2.5-4 月 | 云原生、分布式、插件系统 | 100% |

**🚀 总耗时预估**: 约 **2.5-4 个月**达到完整商业产品（vs 传统开发 6-12 个月）

#### 🤖 AI 辅助优势

| 任务类型 | 传统开发 | AI 辅助 | 加速比 |
|---------|---------|---------|--------|
| 样板代码 | 2 小时 | 10 分钟 | **12x** |
| CRUD 逻辑 | 1 天 | 2 小时 | **4x** |
| 复杂算法 | 3 天 | 1 天 | **3x** |
| 测试代码 | 1 天 | 2 小时 | **4x** |
| 文档编写 | 半天 | 30 分钟 | **8x** |

**平均加速比**: **5-6x** 🔥

---

## 🚧 后续扩展建议（迭代路线图）

### 第一阶段：基础完善（2-3 天，AI 辅助）

1. **认证系统**: 集成 JWT 或 OAuth2
   - 用户登录/注册
   - Token 验证中间件
   - 会话管理

2. **数据验证**: JSON Schema 验证
   - 请求体验证
   - 字段类型检查
   - 自定义验证规则

3. **API 文档**: OpenAPI/Swagger 自动生成
   - 自动生成 API 文档
   - 交互式测试界面
   - 类型定义导出

4. **连接池优化**: 根据负载调整连接数
   - 动态连接池配置
   - 连接健康检查
   - 性能监控

### 第二阶段：功能增强（5-7 天，AI 辅助）

5. **细粒度权限控制**: 基于角色和资源的访问控制
   - 行级安全策略 (RLS)
   - 列级权限控制
   - 动态权限规则
   - 多租户隔离

6. **事务支持**: 跨表、跨操作的事务处理
   - 批量操作原子性
   - 事务 API 端点
   - 回滚机制
   - 嵌套事务支持

7. **多表 JOIN 查询**: 关联查询能力
   - 一对多关系查询
   - 多对多关系查询
   - 嵌套对象返回
   - 聚合查询 (COUNT, SUM, AVG)
   - 示例: `/api/users?select=*,orders(*),profiles(*)`

8. **缓存层**: Redis 缓存热点数据
   - 查询结果缓存
   - 缓存失效策略
   - 缓存预热
   - 分布式缓存

### 第三阶段：企业级特性（2-3 周，AI 辅助）

9. **复杂业务逻辑**: 自定义业务规则引擎
   - Webhook 触发器
   - 数据库函数/存储过程调用
   - 自定义端点注册
   - 业务流程编排
   - 规则引擎 (条件判断、计算、转换)
   - 示例: `/api/rpc/calculate_order_total`

10. **监控和告警**: 完整的可观测性
    - Prometheus + Grafana
    - 慢查询日志
    - 错误追踪
    - 性能指标
    - 告警规则

11. **高级查询**: 更丰富的查询能力
    - 全文搜索 (PostgreSQL FTS)
    - 地理位置查询 (PostGIS)
    - JSON/JSONB 字段查询
    - 数组字段操作
    - 窗口函数支持

12. **实时数据**: WebSocket 推送
    - 数据变更订阅
    - 实时通知
    - 增量更新

### 第四阶段：云原生和扩展（1-2 月，AI 辅助）

13. **分布式架构**
    - 读写分离
    - 主从复制
    - 数据库分片
    - 负载均衡

14. **多数据源支持**
    - MySQL 支持
    - MongoDB 支持
    - 多数据库统一接口

15. **插件系统**
    - 中间件扩展
    - 自定义查询操作符
    - 数据转换器
    - 第三方集成

16. **GraphQL 支持**
    - GraphQL 端点
    - 自动 Schema 生成
    - 订阅 (Subscriptions)

17. **AI 能力集成**
    - 自然语言查询
    - 智能推荐
    - 数据分析助手

---

### 📋 完整实现细节

每个阶段的详细技术方案、代码示例和交付物，请查看：

📖 **[完整迭代路线图 (ROADMAP.md)](./ROADMAP.md)**

包含：
- 详细的实现方案和代码示例
- 技术选型和架构设计
- 测试用例和交付标准
- 技术债务管理计划
- 贡献指南

## 📝 示例数据库 Schema

```sql
-- 创建示例表
CREATE SCHEMA IF NOT EXISTS public;

CREATE TABLE public.users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    age INTEGER,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 插入示例数据
INSERT INTO public.users (name, email, age, status) VALUES
('张三', 'zhangsan@example.com', 25, 'active'),
('李四', 'lisi@example.com', 30, 'active'),
('王五', 'wangwu@example.com', 22, 'pending');
```

## ⚡ 性能

- **异步 I/O**: 基于 Tokio 的异步运行时，支持高并发
- **连接池**: 复用数据库连接，减少连接开销
- **零拷贝**: 最小化数据复制
- **编译优化**: Release 模式启用 LTO 和最高优化级别

## 🔐 安全机制

### 1. 认证 / 会话

- 登录、注册、SSO 登录都会签发一个携带 `jti`（uuid）的 JWT，并把 jti 写入 `user_sessions(user_id, expires_at, revoked, ...)`。
- `auth_middleware` 每次请求除了校验 JWT 签名 + 过期，还会查 `user_sessions`：jti 不存在 / `revoked = true` / `expires_at < now()` 都返回 401。
- `/auth/logout` 立即吊销当前 jti。
- `/auth/refresh` 旋转 jti（旧 token 立即失效），同时从 DB 重新读取 `is_superadmin`，避免被降级的超管在旧 token 过期前继续保留权限。
- `/auth/change-password` 默认会吊销该用户**其它**所有活跃会话（保留当前会话），返回 `other_sessions_revoked` 字段。

### 2. 路由权限分层

| 路由前缀 | 谁能访问 | 中间件 |
| --- | --- | --- |
| `/auth/*`（公开） | 全员 | – |
| `/auth/me` `/auth/refresh` `/auth/logout` `/auth/change-password` | 已登录 | `auth_middleware` |
| `/query` `/transaction` ⚠️ **高危原始 SQL 通道** | **仅超管** | `auth + require_superadmin + dynamic_db` |
| `/api/:schema/:table`（旧 PostgREST 风格） | **仅超管** | `auth + require_superadmin` |
| `/api/schemas` `/api/schemas/:schema` `/api/schema/:schema/...` | **仅超管** | `auth + require_superadmin` |
| `/api/export/*` `/api/monitor/*` | **仅超管** | `auth + require_superadmin` |
| `/api/admin/all-tenants` `/api/admin/tenants/*` `/api/admin/users` `...` | **仅超管** | `auth + require_superadmin` |
| `/api/sso/providers/*` | **仅超管** | `auth + require_superadmin` |
| `/api/admin/rate-limit-rules/*` `/api/admin/circuit-breakers` `/api/admin/gateway-info` | **仅超管** | `auth + require_superadmin` |
| `/api/admin/api-keys/:database_id` | 超管 + 该 DB 所属租户 owner/admin | `auth`（handler 内校验） |
| `/api/admin/webhooks*` | 超管 + 租户 owner/admin（自动按 tenant 隔离） | `auth`（handler 内校验） |
| `/api/admin/audit-logs` `/api/admin/slow-queries` | 超管 + 租户 owner/admin（按 tenant 过滤） | `auth`（handler 内校验） |
| `/api/rbac/*` | 仅租户 owner/admin / 超管可写；读对成员开放 | `auth + handler 内 require_tenant_admin` |
| `/api/v1/{db_id}/{schema}/{table}` | 业务用户，按 RBAC | `optional_auth + rbac_middleware` |

#### 2.1 `/query` / `/transaction` 的访问控制细节（高危通道）

这两条路由能直接对任意租户库执行 SQL，是平台权限最高的接口，单独列说明清楚：

| 维度 | 实现 |
|---|---|
| 谁能调 | **仅平台超级管理员**。中间件链 `auth_middleware → require_superadmin_middleware → dynamic_db_middleware` 自洽守门，**不依赖任何全局兜底**。普通用户 / API Key / 租户 admin 调用都会 403。 |
| 是否做 SQL 注入过滤 | **/query 不做**——它的本质就是"执行调用方提交的任意 SQL"，做语法级过滤等于自废武功。<br>**/transaction 不接收原始 SQL**——所有 op 通过 `query_builder::SqlBuilder` 生成，**走 `$N` 参数化绑定**，操作符走白名单（Eq/Neq/Gt/Gte/Lt/Lte/In/IsNull/IsNotNull），与 Auto API RBAC 用同一套。 |
| 静态护栏 | `read_only=true` 模式拒绝非 SELECT；`is_dangerous_operation()` 黑名单拦截 `DROP DATABASE / DROP SCHEMA / TRUNCATE`；`/transaction` 单事务上限 100 个 op。 |
| 数据隔离 | 强制走 `dynamic_db_middleware`：按请求头 `X-Database-Id` 切目标租户库连接池。**漏带头会回落到管理库（onebase），跨租户读到平台元数据**——所以前端在调用前必须带正确的 db id（dashboard 已自动注入）。 |
| 审计 | **双轨**：(a) `tracing::warn` 结构化日志 target=`raw_sql_audit`，字段包含 `user_id` / `database_id` / `sql_type` / `sql_len` / `read_only`（`/transaction` 记 `op_count`）；(b) handler 通过 `AuditDetailSink` 把同一份结构化元数据塞回 `audit_middleware`，落到 `management.audit_logs.request_body`（JSONB），并把 `action` 列从 `POST` 升级为 `RAW_SQL_QUERY` / `RAW_SQL_BLOCKED` / `RAW_SQL_TXN`，便于按 `WHERE action LIKE 'RAW_SQL%'` 直接拉取所有高危调用链。`tenant_id` 列由 `dynamic_db_middleware` 反查 `tenant_databases.tenant_id` 后通过 `CurrentTenantId` 扩展自动回填，按租户拉日志可直接 `WHERE tenant_id = ?`。**原始 SQL 不入库**（敏感）。 |
| 限流 | 经过全局 `rate_limit_middleware`；可以在 `management.rate_limit_rules` 里按 endpoint=`/query` 配置专属阈值（30s 热加载，CRUD 立即生效）。 |
| 已知缺口 | 无独立残留项。`/query` 真正落库的 SQL 原文不入审计——这是 by design（敏感）。如确需"原文留底"，应单独引入加密字段 + 显式知情同意流程。 |

#### 2.2 定时任务的访问控制（`/api/admin/scheduled-tasks/*`）

| 维度 | 实现 |
|---|---|
| 谁能创建 | 平台级（tenant_id=NULL）仅超管；租户级超管 + 该租户 owner/admin |
| 谁能编辑 / 删除 | 创建者权限维度对齐 |
| 执行身份 | `created_by` 用户身份，每次重读 `is_superadmin`，避免快照过期 |
| RPC 鉴权 | 走 `execute_rpc_inner`，与 axum 路径相同的 permission / condition 求值 |
| HTTP 鉴权 | 默认 https-only；可选 HMAC-SHA256 签名（task 设置 `http_secret` 时启用，加密存储；签名头与 webhook 同款） |
| 失败处理 | 业务失败 / 超时按 `max_retries` 指数退避；超过 cron 间距则回到正常节奏 |
| 多实例 | PostgreSQL `FOR UPDATE SKIP LOCKED` 保证去重；不依赖 Redis |
| 审计 | CRUD 走 `audit_middleware`；每次执行写 `scheduled_task_runs` |

详细设计：`docs/superpowers/specs/2026-05-14-scheduled-tasks-design.md`

### 3. 行 / 列级 RBAC（auto API）

- `permissions.conditions` 是结构化 DSL：`[{"field":"owner_id","op":"eq","value":"$user_id"}]`，仅支持白名单操作符（Eq/Neq/Gt/Gte/Lt/Lte/In/IsNull/IsNotNull），所有值通过 `$N` 占位符参数化绑定，**杜绝 SQL 注入**。
- `permissions.allowed_columns`：白名单，应用于 SELECT、UPDATE、INSERT。
- INSERT：除了列白名单外，还会校验请求体满足 `row_conditions`，防止低权用户把记录写到他人/他租户。
- UPDATE：必须带 WHERE，`query_builder::build_update` 会拒绝空 filters 的全表更新。
- DELETE / GET 单条：同样会用 RBAC 行条件包一层 WHERE。
- API Key 会再做一次 `(resource, action)` scope 校验（`permissions.allowed_resources`、`permissions.allowed_actions`），即使 token 合法也只能在授权范围内调用。

### 4. 加密 / Secrets

- 数据库连接密码、SSO Token 等通过 `src/crypto.rs` 的 `encrypt_secret` 写入，前缀 `v2:`，AES-256-GCM。
- 解密兼容旧格式（`ENCRYPTED:` 前缀、裸 base64），同时打 warn log 提示尽快升级。
- `/app/bin/migrate_passwords` 一次性把历史密码全部升级到 v2，entrypoint 启动时会自动跑一次（前提 `ENCRYPTION_KEY` 已设置）。
- `JWT_SECRET` / `ENCRYPTION_KEY` 缺失或使用默认值时直接 panic（生产模式）。

### 5. 集成测试

仓库自带一组安全 / RBAC 集成测试脚本：

```bash
# 服务必须先运行（默认 http://127.0.0.1:3010）
./tests/integration_test.sh

# 跑特定 base URL：
API_BASE=http://server.example.com:3010 ./tests/integration_test.sh
```

脚本覆盖：超管能做 / 普通用户被 403 / RBAC 默认权限 / token 吊销 / API Key 隔离等关键路径，全部通过为 `=== ALL PASSED ===`。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License

## 🙏 致谢

灵感来源于 [PostgREST](https://postgrest.org/)
