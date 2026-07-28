# 社区产品：用户数据隔离与扩展性指南

面向把 Onebase 用作社区 / SaaS 业务后端、需要确保"每个用户只能访问自己数据"的场景。
本文档给出**核心机制 → 典型场景配置 → 角色梯度 → 双重保险 → 性能扩展（20 万 DAU 量级）→ 监控告警 → 端到端验证**的完整落地方案。所有 SQL / 配置都可以直接复制使用。

---

## 一、核心机制：行级条件 `$current_user_id`

每次 `/api/v1/{db}/{schema}/{table}` 请求的处理顺序：

1. JWT 校验 → 拿到 `claims.sub`（用户 ID）
2. RBAC 中间件查 `management.permissions` 表，把 `conditions` 里的 `"$current_user_id"` 替换为该用户 ID
3. 注入 `PermissionResult` 到请求扩展
4. handler 把行条件**参数化绑定**到 SQL 的 WHERE 里

只要在 `management.permissions` 配置一条规则，**所有 CRUD 都会自动加上 `WHERE owner_id = $当前用户`**——业务代码不需要写一行权限判断。

底层实现见：
- `src/rbac_models.rs::resolve_value_template` —— 占位符替换
- `src/auto_api_handlers.rs::append_rbac_where` —— SQL WHERE 拼接
- `src/auto_api_handlers.rs::check_insert_satisfies_row_condition` —— INSERT 时校验请求体

---

## 二、社区典型场景配置

假设社区数据库在 `tenant_databases` 里 `id=10`、`tenant_id=1`，并且建了如下表：

```sql
-- 个人资料：每人一行，user_id 就是用户主键
CREATE TABLE public.profiles (
    user_id      INT PRIMARY KEY,
    nickname     VARCHAR(64),
    bio          TEXT,
    avatar_url   TEXT,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 帖子：作者 + 公开
CREATE TABLE public.posts (
    id           BIGSERIAL PRIMARY KEY,
    author_id    INT NOT NULL,
    title        TEXT,
    content      TEXT,
    visibility   VARCHAR(16) DEFAULT 'public', -- public/friends/private
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_posts_author ON public.posts(author_id);

-- 私信：仅 sender / receiver 可见
CREATE TABLE public.messages (
    id           BIGSERIAL PRIMARY KEY,
    sender_id    INT NOT NULL,
    receiver_id  INT NOT NULL,
    body         TEXT,
    read_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_msg_sender ON public.messages(sender_id);
CREATE INDEX idx_msg_receiver ON public.messages(receiver_id);

-- 点赞：仅本人可写
CREATE TABLE public.likes (
    id           BIGSERIAL PRIMARY KEY,
    user_id      INT NOT NULL,
    post_id      BIGINT NOT NULL,
    UNIQUE(user_id, post_id)
);
```

### 1. 个人资料：仅自己可读 / 改

```sql
INSERT INTO management.permissions
    (tenant_id, resource, action, conditions, allowed_columns, description)
VALUES
(1, 'public.profiles', 'SELECT',
 '[{"field":"user_id","op":"eq","value":"$current_user_id"}]'::jsonb,
 NULL, '只能看自己的 profile'),
(1, 'public.profiles', 'UPDATE',
 '[{"field":"user_id","op":"eq","value":"$current_user_id"}]'::jsonb,
 ARRAY['nickname','bio','avatar_url'], '只能改自己 + 仅这些列');
```

效果：`GET /api/v1/10/public/profiles` 不论传什么 filter 都只能拿到自己那一行；`PATCH` 别人 `user_id` 直接 403。

### 2. 帖子：所有人可读，仅作者可改 / 删

```sql
INSERT INTO management.permissions
    (tenant_id, resource, action, conditions, description)
VALUES
(1, 'public.posts', 'SELECT', '[]'::jsonb, '所有人可读所有帖子'),
(1, 'public.posts', 'INSERT',
 '[{"field":"author_id","op":"eq","value":"$current_user_id"}]'::jsonb,
 '只能以自己身份发帖（防伪造 author_id）'),
(1, 'public.posts', 'UPDATE',
 '[{"field":"author_id","op":"eq","value":"$current_user_id"}]'::jsonb,
 '仅作者可改'),
(1, 'public.posts', 'DELETE',
 '[{"field":"author_id","op":"eq","value":"$current_user_id"}]'::jsonb,
 '仅作者可删');
```

`INSERT` 这一条会校验请求体里的 `author_id` 必须等于当前用户 ID，**用户没法把别人当作者来发帖**（实现见 `check_insert_satisfies_row_condition`）。

### 3. 私信：sender 或 receiver 可读，仅 sender 可发

私信"自己参与"是 OR 条件，单条 row_conditions 是 AND 拼接的，需要拆成两条独立 permission，handler 会**取并集**（`PermissionResult::merge`）：

```sql
INSERT INTO management.permissions
    (tenant_id, resource, action, conditions, description)
VALUES
-- 看自己发的
(1, 'public.messages', 'SELECT',
 '[{"field":"sender_id","op":"eq","value":"$current_user_id"}]'::jsonb,
 '看自己发出的'),
-- 看别人发给自己的
(1, 'public.messages', 'SELECT',
 '[{"field":"receiver_id","op":"eq","value":"$current_user_id"}]'::jsonb,
 '看发给自己的'),
-- 发私信必须以自己身份
(1, 'public.messages', 'INSERT',
 '[{"field":"sender_id","op":"eq","value":"$current_user_id"}]'::jsonb,
 '只能以自己身份发');
```

### 4. 点赞：仅本人可建 / 删

```sql
INSERT INTO management.permissions
    (tenant_id, resource, action, conditions, description)
VALUES
(1, 'public.likes', 'SELECT', '[]'::jsonb, '点赞列表公开'),
(1, 'public.likes', 'INSERT',
 '[{"field":"user_id","op":"eq","value":"$current_user_id"}]'::jsonb,
 '只能给自己加 like'),
(1, 'public.likes', 'DELETE',
 '[{"field":"user_id","op":"eq","value":"$current_user_id"}]'::jsonb,
 '只能取消自己的 like');
```

### 5. 把这些权限绑到 `member` 角色

```sql
WITH r AS (
  INSERT INTO management.roles (tenant_id, name, description, is_system)
  VALUES (1, 'member', '社区注册用户', false)
  ON CONFLICT (tenant_id, name) DO UPDATE SET description = EXCLUDED.description
  RETURNING id
)
INSERT INTO management.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM r,
  management.permissions p
WHERE p.tenant_id = 1
  AND p.resource IN ('public.profiles','public.posts','public.messages','public.likes');
```

新用户注册成功后赋 `member` 角色：

```sql
INSERT INTO management.user_roles (user_id, role_id, tenant_id)
SELECT $1, r.id, 1
FROM management.roles r
WHERE r.tenant_id = 1 AND r.name = 'member';
```

---

## 三、社区角色梯度建议

| 角色 | 谁 | 怎么配 |
| --- | --- | --- |
| `visitor` | 未登录 | 不给 token，或给一个只读 API Key（`allowed_actions=["SELECT"]`、`allowed_resources=["public.posts","public.users"]`） |
| `member` | 注册用户 | 上面那一组规则 |
| `moderator` | 版主 | 在 `member` 基础上，对 `public.posts`、`public.comments` 加一条 `DELETE` 权限**不带** `conditions`（即可删任何人的） |
| `community_admin` | 社区创建者 | `management.user_tenants.role = 'admin'` —— 自动可以管 API Key、Webhook、审计日志 |
| `superadmin` | 平台运营 | `users.is_superadmin = true` —— 可跨社区操作 |

---

## 四、双重保险：PostgreSQL Row-Level Security（强烈建议）

应用层 RBAC 已经够，但**多一道防线**能挡住"有人直连 PG / 拿到 superuser API Key"的越权。在业务库里建：

```sql
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- 应用层每次请求执行 SET LOCAL app.current_user_id = ...
-- （需要在 handler 里加一个 set_local 调用，或自定义 PG 角色登录）
CREATE POLICY profile_self ON public.profiles
  USING (user_id = current_setting('app.current_user_id', true)::int);

CREATE POLICY message_participant ON public.messages
  USING (sender_id   = current_setting('app.current_user_id', true)::int
      OR receiver_id = current_setting('app.current_user_id', true)::int);
```

可以放第二阶段加固，先用 RBAC 跑起来。

---

## 五、20 万 DAU 性能要点

按经验估算：20 万 DAU × 100 次请求/天 ≈ 2000 万次/天 ≈ 平均 230 QPS，晚高峰 600~1000 QPS。
Onebase 当前架构能扛，把以下几点调好即可：

### 1. 权限缓存（已实现，确认开启）

`src/permission_cache.rs` 把 `(tenant_id, user_id, resource, action) → permissions[]` 缓存到 Redis，TTL 5 分钟。**Redis 必须连上**，否则每个请求都打数据库。

部署时 `REDIS_URL` 必须可达；监控缓存命中率应 > 95%。

### 2. user_sessions 表

每次请求都查一次。生产建议：

```sql
-- 已有索引（来自 migrations/012_jwt_sessions.sql），确认存在：
CREATE INDEX IF NOT EXISTS idx_user_sessions_active
    ON user_sessions(user_id, revoked, expires_at)
    WHERE revoked = false;

-- 定期清理过期 session（每小时跑一次 cron 或写到 watchdog）
DELETE FROM user_sessions WHERE expires_at < NOW() - INTERVAL '1 day';
```

### 3. 业务表必加索引

```sql
CREATE INDEX idx_posts_author ON public.posts(author_id);
CREATE INDEX idx_msg_sender   ON public.messages(sender_id);
CREATE INDEX idx_msg_receiver ON public.messages(receiver_id);
CREATE INDEX idx_likes_user   ON public.likes(user_id);
```

RBAC 加的 WHERE 条件全是 `xxx_id = $current_user`，**没索引就是全表扫描**，到百万级数据立刻雪崩。

### 4. 连接池调大

```bash
# .env 或 docker-compose
DATABASE_MAX_CONNECTIONS=50    # 主库
PER_TENANT_DB_MAX_CONNECTIONS=30
```

### 5. 读写分离

`management.tenant_databases` 已支持 `db_role='replica'` + `primary_id`，SELECT 类自动路由到 replica。社区场景读写比 10:1 以上，1 主 2 从能把主库压力降到 1/3。

### 6. PG 表分区（数据涨到亿级再做）

`messages`、`posts` 一年后破亿很常见。预案：

```sql
-- 按 created_at 月分区
CREATE TABLE public.messages_y2026m04 PARTITION OF public.messages
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
```

或者按 `user_id` hash 分区（私信类）。

### 7. Redis 高可用

20 万 DAU 单节点 Redis 可以，但建议 Sentinel 或 Cluster。
`docker-compose.override.yml` 改成连接外部托管 Redis（阿里云 / AWS ElastiCache）即可。

---

## 六、必备监控告警

接入 Prometheus 看四个指标：

| 指标 | 告警阈值 |
| --- | --- |
| RBAC 403 比例 | 突增 5x → 可能爆破或前端 bug |
| 权限缓存命中率 | < 90% 持续 5 分钟 |
| 慢查询（已有 `slow_query_logs`） | duration_ms > 1000 |
| `user_sessions` 行数 | > 100 万（说明清理任务挂了） |

---

## 七、3 分钟跑通验证

```bash
# 1. 用超管创建社区库 + 表（SQL 见上面）

# 2. 注册一个普通用户 alice
curl -X POST http://your-host:3010/auth/register \
  -d '{"username":"alice","email":"alice@x.com","password":"Pa55word!"}'

# 3. 把 alice 加到 tenant 1 + 赋 member 角色（用上面的 SQL）

# 4. alice 登录拿 token
TOKEN=$(curl -s -X POST .../auth/login \
  -d '{"email":"alice@x.com","password":"Pa55word!"}' | jq -r .token)

# 5. alice 试图改别人的 profile —— 期望 404 / 0 行影响
curl -X PATCH http://.../api/v1/10/public/profiles \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":999,"nickname":"hacker"}'   # 行级条件会拦掉

# 6. alice 改自己的 -> 200
curl -X PATCH "http://.../api/v1/10/public/profiles?user_id=eq.<alice_id>" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"nickname":"Alice"}'
```

---

## 总结

- **每张敏感表配 1~4 条 permission**（SELECT/INSERT/UPDATE/DELETE），用 `$current_user_id` 做行匹配，剩下完全交给 Onebase。
- INSERT 会**校验请求体的字段**（防伪造 `author_id` 之类）。
- 业务表的 `owner_id`/`author_id`/`user_id` 列**必须建索引**。
- 启用 Redis 缓存 + 读写分离 + 定期清 `user_sessions`，20 万 DAU 不需要做架构改动。
- 想做强保险，再叠一层 PostgreSQL RLS。
