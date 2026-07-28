# PostgreSQL Row-Level Security 配置指南（数据级防线）

本文档讲清"业务级 RBAC（应用层）+ 数据级 RLS（数据库层）"双层防线的工作方式，
并给出社区场景下 profiles / posts / messages / likes 的完整 POLICY 模板。

> 配套的 RBAC 入门见 [community-data-isolation.md](./community-data-isolation.md)。
> 本文聚焦"在已有 RBAC 之上再叠 RLS"。

---

## 一、双层防线工作机制

```
浏览器/App                         Onebase 后端                    PostgreSQL 业务库
─────────────                      ───────────────                    ─────────────
GET /api/v1/.../messages
  + Bearer JWT
                ── 转发到后端 ──▶
                                   1) 校验 JWT，拿到 user_id
                                   2) RBAC 中间件查 permissions，
                                      拼出 row_conditions（业务级）
                                   3) BEGIN
                                      SELECT set_config(
                                        'app.current_user_id', '42', true)
                                   4) 执行业务 SQL
                                                          ── 触发 RLS ──▶
                                                                              POLICY 用
                                                                              app.current_user_id()
                                                                              过滤一遍（数据级）
                                   5) COMMIT （SET LOCAL 自动清）
```

- **业务级（RBAC）** 在 Onebase 进程里完成：拿到结构化 `permissions.conditions`，
  拼到 SQL WHERE 子句、再做列白名单 / API Key scope 等。
- **数据级（RLS）** 在 PostgreSQL 里完成：业务 SQL 跑过来时，每张启用了 RLS 的表都会
  自动叠加 POLICY 里的 USING / WITH CHECK 子句。
- 两层是 **AND** 的关系：业务级允许 + 数据级允许 → 才看得到 / 写得动。
- 任一层独立工作即可拦下越权请求；同时启用是为了在某层被绕过时仍有兜底
  （比如有人拿到 superuser 凭据直连 psql）。

---

## 二、Onebase 怎么把 user_id 传进 PG

`src/auto_api_handlers.rs` 的 5 个 CRUD handler 已经统一改造为：

```rust
let mut tx = pool.begin().await?;
sqlx::query("SELECT set_config('app.current_user_id', $1, true)")
    .bind(user_id.to_string())
    .execute(&mut *tx).await?;
// ...所有业务 SQL 用 &mut *tx...
tx.commit().await?;
```

要点：

- `set_config(name, value, true)` 第三参数 `true` = 事务局部 GUC，
  等价 `SET LOCAL`，COMMIT/ROLLBACK 后自动清，不污染连接池里这条连接的下次复用。
- 未登录调用（仅 API Key 路径会出现）写入 `'0'`；本仓库提供的辅助函数
  `app.current_user_id()` 会把 `'0'` 转 NULL，POLICY 自然拒绝匿名。

**`/transaction` 接口不注入** —— 该接口仅超管可调，是给 DBA 跑维护脚本用的，
应当用 `BYPASSRLS` 角色或在 POLICY 里给超管留豁免（见第六节）。

---

## 三、装上辅助函数

在**业务库**里跑：

```bash
psql -h <host> -U <app_user> -d <business_db> -f migrations/013_rls_helpers.sql
```

得到一个 `app.current_user_id() RETURNS INT` 函数。

---

## 四、社区场景完整 POLICY 模板

下面所有 SQL 都在**业务库**执行。

### 表结构（与 community-data-isolation.md 一致）

```sql
CREATE TABLE public.profiles (
    user_id    INT PRIMARY KEY,
    nickname   VARCHAR(64),
    bio        TEXT,
    avatar_url TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.posts (
    id         BIGSERIAL PRIMARY KEY,
    author_id  INT NOT NULL,
    title      TEXT,
    content    TEXT,
    visibility VARCHAR(16) DEFAULT 'public',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_posts_author ON public.posts(author_id);

CREATE TABLE public.messages (
    id          BIGSERIAL PRIMARY KEY,
    sender_id   INT NOT NULL,
    receiver_id INT NOT NULL,
    body        TEXT,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_msg_sender ON public.messages(sender_id);
CREATE INDEX idx_msg_receiver ON public.messages(receiver_id);

CREATE TABLE public.likes (
    id      BIGSERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    post_id BIGINT NOT NULL,
    UNIQUE(user_id, post_id)
);
```

### 1. profiles：仅自己可读 / 改

```sql
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;  -- 表 owner 也强制走 POLICY

CREATE POLICY profile_self_read ON public.profiles
    FOR SELECT
    USING (user_id = app.current_user_id());

CREATE POLICY profile_self_update ON public.profiles
    FOR UPDATE
    USING (user_id = app.current_user_id())
    WITH CHECK (user_id = app.current_user_id());

-- 注：profiles 通常由触发器或注册流程插入，普通用户不需要 INSERT 权限
-- 如要允许，可加：
-- CREATE POLICY profile_self_insert ON public.profiles
--     FOR INSERT
--     WITH CHECK (user_id = app.current_user_id());
```

### 2. posts：所有人可读、仅作者可改 / 删

```sql
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts FORCE ROW LEVEL SECURITY;

-- 全员可读
CREATE POLICY post_public_read ON public.posts
    FOR SELECT
    USING (true);

-- 只能以自己身份发帖（防伪造 author_id）
CREATE POLICY post_own_insert ON public.posts
    FOR INSERT
    WITH CHECK (author_id = app.current_user_id());

CREATE POLICY post_own_update ON public.posts
    FOR UPDATE
    USING (author_id = app.current_user_id())
    WITH CHECK (author_id = app.current_user_id());

CREATE POLICY post_own_delete ON public.posts
    FOR DELETE
    USING (author_id = app.current_user_id());
```

### 3. messages：sender 或 receiver 可读，仅 sender 可发

> 这就是上一轮聊到的 OR 条件 —— 写两条 POLICY，PostgreSQL 自动取并集。

```sql
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;

CREATE POLICY msg_sender_read ON public.messages
    FOR SELECT
    USING (sender_id = app.current_user_id());

CREATE POLICY msg_receiver_read ON public.messages
    FOR SELECT
    USING (receiver_id = app.current_user_id());

CREATE POLICY msg_send ON public.messages
    FOR INSERT
    WITH CHECK (sender_id = app.current_user_id());

-- 收信人可以标记 read_at（仅这一列），sender 可以撤回（DELETE）
CREATE POLICY msg_receiver_mark_read ON public.messages
    FOR UPDATE
    USING (receiver_id = app.current_user_id())
    WITH CHECK (receiver_id = app.current_user_id());

CREATE POLICY msg_sender_delete ON public.messages
    FOR DELETE
    USING (sender_id = app.current_user_id());
```

### 4. likes：仅本人可建 / 删

```sql
ALTER TABLE public.likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.likes FORCE ROW LEVEL SECURITY;

-- 点赞列表对所有人公开（社区计数器场景）
CREATE POLICY like_public_read ON public.likes
    FOR SELECT
    USING (true);

CREATE POLICY like_own_insert ON public.likes
    FOR INSERT
    WITH CHECK (user_id = app.current_user_id());

CREATE POLICY like_own_delete ON public.likes
    FOR DELETE
    USING (user_id = app.current_user_id());
```

---

## 五、PERMISSIVE vs RESTRICTIVE

PostgreSQL POLICY 默认是 PERMISSIVE 类型，多个 PERMISSIVE 是 OR 关系：

```sql
-- 私信场景天然 OR
CREATE POLICY msg_sender_read   ON public.messages FOR SELECT USING (sender_id = ...);
CREATE POLICY msg_receiver_read ON public.messages FOR SELECT USING (receiver_id = ...);
-- 等价于 USING (sender_id = ... OR receiver_id = ...)
```

如果需要"两个条件**都**满足才能"，用 RESTRICTIVE：

```sql
-- 例：必须是自己发的 AND 帖子未删除
CREATE POLICY post_must_be_active ON public.posts AS RESTRICTIVE
    FOR ALL
    USING (deleted_at IS NULL);

CREATE POLICY post_self_modify ON public.posts
    FOR UPDATE
    USING (author_id = app.current_user_id());
```

RESTRICTIVE 与所有同动作的 POLICY 是 AND。

---

## 六、给运维 / 后台留豁免

`/transaction`、`/query` 等接口仅超管可调，他们应该能跨用户操作。
两种做法：

### 方案 A：给应用角色赋 `BYPASSRLS`（最干脆）

```sql
ALTER ROLE onebase_app BYPASSRLS;
```

这样应用使用 `onebase_app` 连接时所有 POLICY 失效。**不推荐**——粒度太粗。

### 方案 B：在 POLICY 里给后台角色开口（推荐）

```sql
-- 给一个专用 role
CREATE ROLE onebase_backoffice NOINHERIT;

-- 让该角色读 / 写所有 messages
CREATE POLICY msg_backoffice ON public.messages
    AS PERMISSIVE
    FOR ALL
    TO onebase_backoffice
    USING (true)
    WITH CHECK (true);
```

后台维护脚本用 `SET LOCAL ROLE onebase_backoffice` 临时切角色再跑。

### 方案 C：用 setting 做"上帝模式"（最灵活，慎用）

在 POLICY 里加一行：

```sql
USING (
    coalesce(current_setting('app.bypass_rls', true), 'off') = 'on'
    OR sender_id = app.current_user_id()
)
```

需要时执行 `SELECT set_config('app.bypass_rls', 'on', true)`。这要求**绝对**确保
该 setting 不会被普通请求误开。

---

## 七、一致性自查清单

把 RLS 加上后，过一遍这张表确保没遗漏：

| 检查项 | 怎么验证 |
| --- | --- |
| 每张敏感表都 `ENABLE ROW LEVEL SECURITY` 了 | `SELECT relname FROM pg_class WHERE relrowsecurity = false AND relkind='r' AND relnamespace = 'public'::regnamespace;` |
| 每张表都 `FORCE ROW LEVEL SECURITY` 了（防 owner 绕过） | 同上，加 `relforcerowsecurity = false` |
| INSERT 类 POLICY 都加了 `WITH CHECK` | `\d+ public.messages` 看每条 POLICY |
| `app.current_user_id()` 在业务库里存在 | `SELECT app.current_user_id();` |
| 每个用户 ID 列上都有索引 | RLS 加在 WHERE 里，相当于自动加了 `xxx_id = N`，没索引就是全表扫 |
| Onebase 注入的 `app.current_user_id` 能被读到 | 在事务里 `SELECT current_setting('app.current_user_id')` 应当返回非空 |

---

## 八、调试技巧

RLS 拒绝访问时返回的是"看不到 / 无此行"，不会报错，**比 RBAC 难调**。常用手法：

1. **临时关 POLICY**

   ```sql
   ALTER TABLE public.messages DISABLE ROW LEVEL SECURITY;
   -- 验证 SQL 本身没问题
   ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
   ```

2. **看当前 GUC 值**

   ```sql
   -- 在 onebase 后端日志里加：
   tracing::debug!(user_id = %user_id, "set RLS context");
   -- 在 PG 端：
   SELECT current_setting('app.current_user_id', true);
   ```

3. **用 `pg_class.relhassubclass` + `pg_policies` 反查**

   ```sql
   SELECT * FROM pg_policies WHERE tablename = 'messages';
   ```

4. **EXPLAIN 看 PG 拼出的最终查询**

   ```sql
   SET LOCAL row_security = on;
   SELECT set_config('app.current_user_id', '42', true);
   EXPLAIN SELECT * FROM public.messages;
   -- 输出会包含 Filter: ((sender_id = ...) OR (receiver_id = ...))
   ```

---

## 九、性能注意

- POLICY 表达式会被推到执行计划的 `Filter` 阶段，**完全等价于手写 WHERE**。
- 因此 `xxx_id` 列上**必须**有索引，否则等同于全表扫。
- POLICY 里调用的函数应当声明 `STABLE` / `IMMUTABLE` + `PARALLEL SAFE`，
  本仓库 `app.current_user_id()` 已声明，不会成为 query plan 的瓶颈。
- 一张表上多条 PERMISSIVE POLICY 在执行时会被 OR 拼接，PG 会评估每条；
  超过 5~10 条时建议合并 (写一条 POLICY 用 OR 表达式)。
- `SET LOCAL` 本身在 PG 里 < 0.05ms，事务包裹的额外开销 < 1ms，对 20 万 DAU
  量级的吞吐没有可观测影响。

---

## 十、上线步骤建议

1. 先**只配 RBAC**（不开 RLS），观察一周业务无误；
2. 在**预发**业务库执行 `migrations/013_rls_helpers.sql` + 本文第四节的 POLICY；
3. 用集成测试 `tests/integration_test.sh` + 一组人工抽查（特别是私信 / 个人资料）回归；
4. 一切正常后在**生产**业务库重复执行；先 `ENABLE` 不 `FORCE`，预留 `BYPASSRLS` 角色给运维；观察 24-48 小时；
5. 加上 `FORCE ROW LEVEL SECURITY`，关闭运维 BYPASSRLS（改用方案 B 或 C）。
