# 🚀 OneBase 启动和测试指南

## 📋 快速开始（3分钟）

> 第一次启动前必须先准备 `.env` 和数据库表，详见 [SETUP.md](./SETUP.md) §3-§4。
> 简化版命令：
>
> ```bash
> cp .env.example .env  # 然后编辑 DATABASE_URL / JWT_SECRET / ENCRYPTION_KEY
> cargo run --bin migrate_all   # 一键创建 users / management.* / user_sessions 等表
> cargo run --bin create_admin  # 创建超管 admin@example.com / Admin123
> ```

### 第 1 步：启动服务器

在项目根目录打开终端：

```bash
cargo run
```

等待编译完成，你应该看到：

```
🚀 服务器启动在 http://127.0.0.1:3000
📡 API 端点: http://127.0.0.1:3000/api/:schema/:table
```

> 启动期看到 `WARN onebase: Redis 连接失败（将以无缓存模式运行）` 不影响登录——`REDIS_URL` 不可达时服务会在 3 秒超时后继续启动，但权限缓存 / 限流 / 多实例事件会失效。

### 第 2 步：访问管理后台

打开浏览器，访问：

```
http://localhost:3000/admin/
```

### 第 3 步：登录

迁移脚本会预置两个种子账号：

```
超管: admin@example.com / Admin123     (is_superadmin = true)
普通: test@example.com  / User1234     (role = user)
```

点击"登录"，你应该看到管理后台主界面！

---

## ✅ 功能测试清单

### 1. 数据表管理

**测试步骤**：
1. 点击左侧"数据表"菜单
2. 应该看到 `users` 表（以及其他表）
3. 点击 `users` 表
4. 应该看到数据列表
5. 在搜索框输入"admin"测试搜索
6. 点击"新增"按钮测试添加功能

**预期结果**：
- ✅ 能看到所有表
- ✅ 能查看表数据
- ✅ 搜索功能正常
- ✅ 分页正常

### 2. 事务管理

**测试步骤**：
1. 点击左侧"事务管理"菜单
2. 点击"添加操作"
3. 配置一个 POST 操作：
   ```
   方法: POST
   Schema: public
   Table: users
   数据: {"username":"testuser","email":"test@test.com","password_hash":"$2b$12$test","role":"user"}
   ```
4. 点击"执行事务"

**预期结果**：
- ✅ 事务执行成功
- ✅ 显示结果和耗时
- ✅ 数据已插入

**清理测试数据**：
在浏览器控制台执行：
```javascript
await axios.delete('http://localhost:3000/api/public/users?email=test@test.com')
```

### 3. 用户管理

**测试步骤**：
1. 点击左侧"用户管理"菜单
2. 查看用户列表

**预期结果**：
- ✅ 显示所有用户
- ✅ 角色标签有颜色区分
- ✅ 时间格式正确

### 4. 健康检查

**测试步骤**：
1. 点击顶部"健康检查"按钮

**预期结果**：
- ✅ 显示绿色通知
- ✅ 显示系统状态信息

---

## 🧪 API 测试（可选）

### 使用 curl 测试

```bash
# 1. 健康检查
curl http://localhost:3000/health

# 2. 登录
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"Admin123"}'

# 3. 获取用户列表
curl http://localhost:3000/api/public/users

# 4. 测试事务
curl -X POST http://localhost:3000/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "method": "POST",
        "schema": "public",
        "table": "users",
        "data": {
          "username": "apitest",
          "email": "apitest@test.com",
          "password_hash": "$2b$12$test",
          "role": "user"
        }
      }
    ]
  }'
```

### 使用测试脚本

```bash
# Linux/Mac
bash QUICK_TEST.sh

# Windows (Git Bash)
bash QUICK_TEST.sh

# 或者手动测试
curl http://localhost:3000/health
```

---

## 🐛 故障排除

### 问题 1: 编译错误

**症状**：`cargo run` 失败

**解决**：
```bash
# 清理并重新编译
cargo clean
cargo build
```

### 问题 2: 数据库连接失败

**症状**：启动时报错 "数据库连接失败"

**解决**：
1. 检查 `.env` 文件中的 `DATABASE_URL`
2. 确保 PostgreSQL 正在运行
3. 运行迁移脚本：
   ```bash
   psql -U your_username -d your_database -f migrations/001_create_users_table.sql
   ```

### 问题 3: 管理后台 404

**症状**：访问 `/admin/` 返回 404

**解决**：
1. 检查 `admin/` 目录是否存在
2. 确认三个文件都存在：
   - `admin/index.html`
   - `admin/components.js`
   - `admin/app.js`
3. 重新启动服务器

### 问题 4: 登录失败

**症状**：提示"邮箱或密码错误"或者后端报 500 `relation "user_sessions" does not exist`

**解决**：
1. 确认已经跑过 `cargo run --bin migrate_all`（它会建出 `users` / `management.*` / `user_sessions`，并种入两个测试账号）。
2. 如果是从老代码升级上来，可能缺 011/012 迁移，重跑 `migrate_all` 即可幂等补齐；或单独执行：
   ```bash
   psql -U your_username -d onebase_db -f migrations/011_seed_default_permissions.sql
   psql -U your_username -d onebase_db -f migrations/012_jwt_sessions.sql
   ```
3. 想直接重置超管密码：`cargo run --bin create_admin`。
4. 手动测试 API：
   ```bash
   curl -X POST http://localhost:3000/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@example.com","password":"Admin123"}'
   ```

### 问题 5: CORS 错误

**症状**：浏览器控制台显示 CORS 错误

**解决**：
- 确保 API 服务器正在运行
- 检查 `admin/app.js` 中的 `apiUrl` 配置
- 确认使用的是 `http://localhost:3000` 而不是其他地址

---

## 📊 测试结果模板

完成测试后，请记录结果：

```
测试日期: ___________
测试人员: ___________

✅ 服务器启动
✅ 访问管理后台
✅ 用户登录
✅ 数据表管理
✅ 事务管理
✅ 用户管理
✅ 健康检查

发现的问题:
1. _________________
2. _________________

总体评价: _________________
```

---

## 🎯 测试通过后

如果所有测试都通过，可以继续开发剩余功能：

1. **细粒度权限控制** (RBAC + RLS)
2. **多表 JOIN 查询** (PostgREST 风格)
3. **Redis 缓存层** (查询缓存)

---

## 📸 界面截图参考

**登录页面**：
- 蓝紫渐变背景
- 白色卡片
- OneBase logo

**主界面**：
- 深色侧边栏（左）
- 白色主内容区（右）
- 顶部状态栏

**数据表视图**：
- 表格显示数据
- 搜索框
- 分页控件
- 操作按钮

---

## 🆘 需要帮助？

**文档**：
- [README.md](./README.md) - 项目说明
- [ADMIN_GUIDE.md](./ADMIN_GUIDE.md) - 管理后台详细文档
- [AUTH_GUIDE.md](./AUTH_GUIDE.md) - 认证系统文档
- [QUICK_START.md](./QUICK_START.md) - 快速开始

**示例**：
- `examples/auth_examples.sh` - 认证 API 测试
- `examples/transaction_examples.sh` - 事务 API 测试

---

**准备好了吗？开始测试吧！** 🚀

测试完成后，告诉我结果，我们将继续实现剩余功能！

