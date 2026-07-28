# OneBase 认证系统使用指南

## 🔐 概述

OneBase v0.2 引入了完整的 JWT 认证系统，支持用户注册、登录、令牌验证和密码管理。

## 📋 功能特性

- ✅ 用户注册（带邮箱和用户名唯一性验证）
- ✅ 用户登录（JWT Token 生成）
- ✅ 密码强度验证（大写、小写、数字）
- ✅ 密码安全存储（bcrypt 哈希）
- ✅ JWT 令牌验证中间件
- ✅ 令牌刷新
- ✅ 修改密码
- ✅ 获取当前用户信息
- ✅ 角色based访问控制（RBAC）

## 🚀 快速开始

### 1. 数据库设置

运行迁移脚本创建 users 表：

```bash
psql -U your_username -d your_database -f migrations/001_create_users_table.sql
```

或者手动创建 users 表（见迁移文件）。

### 2. 环境变量配置

复制 `.env.example` 到 `.env` 并配置：

```env
DATABASE_URL=postgresql://username:password@localhost:5432/onebase_db
JWT_SECRET=your-secret-key-here-make-it-long-and-random
JWT_EXPIRATION=86400  # 24 小时
```

⚠️ **重要**: 在生产环境中，务必使用强随机字符串作为 `JWT_SECRET`！

### 3. 启动服务器

```bash
cargo run
```

## 📖 API 端点

### 公开端点（无需认证）

#### 1. 用户注册

```http
POST /auth/register
Content-Type: application/json

{
  "username": "johndoe",
  "email": "john@example.com",
  "password": "MyPassword123"
}
```

**响应**:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "johndoe",
    "email": "john@example.com",
    "role": "user",
    "created_at": "2024-01-01 12:00:00"
  }
}
```

**密码要求**:
- 至少 8 个字符
- 包含大写字母
- 包含小写字母
- 包含数字

#### 2. 用户登录

```http
POST /auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "MyPassword123"
}
```

**响应**: 同注册响应

### 受保护端点（需要认证）

所有受保护端点都需要在 Header 中携带 JWT Token：

```http
Authorization: Bearer <your_jwt_token>
```

#### 3. 获取当前用户信息

```http
GET /auth/me
Authorization: Bearer <token>
```

**响应**:

```json
{
  "id": 1,
  "username": "johndoe",
  "email": "john@example.com",
  "role": "user",
  "created_at": "2024-01-01 12:00:00"
}
```

#### 4. 刷新 Token

```http
POST /auth/refresh
Authorization: Bearer <token>
```

**响应**:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

#### 5. 修改密码

```http
POST /auth/change-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "old_password": "MyPassword123",
  "new_password": "NewPassword456"
}
```

**响应**:

```json
{
  "message": "密码修改成功"
}
```

## 🔒 中间件

### 认证中间件

自动验证 JWT Token，用于保护需要认证的路由。

```rust
use crate::middleware::auth_middleware;

let protected_routes = Router::new()
    .route("/protected", get(handler))
    .layer(axum_middleware::from_fn(auth_middleware));
```

### 可选认证中间件

尝试验证 Token，但不会在 Token 无效时返回错误。用于可选登录的场景。

```rust
use crate::middleware::optional_auth_middleware;

let api_routes = Router::new()
    .route("/api/data", get(handler))
    .layer(axum_middleware::from_fn(optional_auth_middleware));
```

### 角色检查

在 handler 中检查用户角色：

```rust
use crate::middleware::has_role;
use crate::auth::Claims;

async fn admin_only_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    if !has_role(&claims, "admin") {
        return Err(AppError::Forbidden("需要管理员权限".to_string()));
    }
    
    // 管理员逻辑
    Ok(Json(json!({"message": "Welcome, admin!"})))
}
```

## 👤 用户角色

### 默认角色

- `user`: 普通用户（注册时默认）
- `admin`: 管理员

### 角色权限

- `admin` 角色拥有所有权限
- 可以在数据库中手动修改用户角色

```sql
UPDATE users SET role = 'admin' WHERE email = 'admin@example.com';
```

## 🌐 前端集成示例

### JavaScript/Fetch

```javascript
// 注册
async function register(username, email, password) {
  const response = await fetch('http://localhost:3000/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password })
  });
  const data = await response.json();
  
  if (response.ok) {
    // 保存 token
    localStorage.setItem('token', data.token);
    return data;
  } else {
    throw new Error(data.error);
  }
}

// 登录
async function login(email, password) {
  const response = await fetch('http://localhost:3000/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await response.json();
  
  if (response.ok) {
    localStorage.setItem('token', data.token);
    return data;
  } else {
    throw new Error(data.error);
  }
}

// 获取当前用户
async function getCurrentUser() {
  const token = localStorage.getItem('token');
  if (!token) throw new Error('未登录');
  
  const response = await fetch('http://localhost:3000/auth/me', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (response.ok) {
    return await response.json();
  } else if (response.status === 401) {
    // Token 无效或过期
    localStorage.removeItem('token');
    throw new Error('Token 已过期，请重新登录');
  } else {
    throw new Error('获取用户信息失败');
  }
}

// 退出登录
function logout() {
  localStorage.removeItem('token');
}

// API 请求封装（自动添加 token）
async function apiRequest(url, options = {}) {
  const token = localStorage.getItem('token');
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const response = await fetch(url, {
    ...options,
    headers
  });
  
  if (response.status === 401) {
    // 自动退出登录
    logout();
    window.location.href = '/login';
  }
  
  return response;
}
```

### React Hooks 示例

```jsx
import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 启动时检查 token
    const token = localStorage.getItem('token');
    if (token) {
      fetchCurrentUser();
    } else {
      setLoading(false);
    }
  }, []);

  const fetchCurrentUser = async () => {
    try {
      const response = await fetch('http://localhost:3000/auth/me', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      
      if (response.ok) {
        const data = await response.json();
        setUser(data);
      } else {
        localStorage.removeItem('token');
      }
    } catch (error) {
      console.error('获取用户信息失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const register = async (username, email, password) => {
    const response = await fetch('http://localhost:3000/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      localStorage.setItem('token', data.token);
      setUser(data.user);
      return { success: true, data };
    } else {
      return { success: false, error: data.error };
    }
  };

  const login = async (email, password) => {
    const response = await fetch('http://localhost:3000/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      localStorage.setItem('token', data.token);
      setUser(data.user);
      return { success: true, data };
    } else {
      return { success: false, error: data.error };
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, register, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

// 使用示例
function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    const result = await login(email, password);
    
    if (result.success) {
      alert('登录成功！');
    } else {
      alert(`登录失败: ${result.error}`);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="邮箱"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="密码"
      />
      <button type="submit">登录</button>
    </form>
  );
}
```

## 🔧 测试

运行测试脚本：

```bash
# 赋予执行权限
chmod +x examples/auth_examples.sh

# 运行测试
./examples/auth_examples.sh
```

或手动测试（使用 curl）：

```bash
# 注册
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","email":"test@example.com","password":"Test1234"}'

# 登录
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234"}'

# 获取用户信息（替换 <TOKEN>）
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/auth/me
```

## 🐛 错误处理

### 常见错误

| 状态码 | 错误信息 | 原因 |
|--------|---------|------|
| 400 | 验证失败 | 请求数据不符合要求 |
| 401 | Token 已过期 | JWT token 超过有效期 |
| 401 | 无效的 token | Token 格式错误或签名无效 |
| 401 | 邮箱或密码错误 | 登录凭证不正确 |
| 401 | 缺少 Authorization header | 未提供认证 token |
| 403 | 需要 X 角色权限 | 用户角色不足 |
| 400 | 邮箱已被注册 | 邮箱重复 |
| 400 | 用户名已被使用 | 用户名重复 |

### 错误响应格式

```json
{
  "error": "错误描述信息"
}
```

## 🔐 安全建议

1. **JWT_SECRET**: 使用至少 32 位的随机字符串
2. **HTTPS**: 生产环境务必使用 HTTPS
3. **Token 存储**: 前端避免存储敏感信息在 localStorage
4. **密码策略**: 可根据需求调整密码强度验证
5. **Token 过期**: 根据安全需求调整 `JWT_EXPIRATION`
6. **速率限制**: 生产环境建议添加登录速率限制
7. **CORS**: 生产环境限制允许的源

## 📝 下一步

- [ ] 添加邮箱验证
- [ ] 添加密码重置功能
- [ ] 添加双因素认证（2FA）
- [ ] 添加 OAuth2 支持
- [ ] 添加会话管理
- [ ] 添加登录历史记录

---

**完成时间**: 第一阶段 ✅  
**下一步**: 实现请求验证框架和 OpenAPI 文档

