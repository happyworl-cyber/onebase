#!/usr/bin/env bash
# ============================================================
# OneBase PostgreSQL RLS 端到端验证
#
# RLS 在 PostgreSQL 里对 SUPERUSER 永远不生效（即便 FORCE ROW LEVEL
# SECURITY 也无法约束 super）。因此本测试会先建一个非 super 的应用
# 角色 rls_app_user，并以此账号配一条新的 tenant_databases 连接，
# 再走 Auto API 验证 POLICY。
#
# 跑法：
#   ./tests/rls_test.sh
#   API_BASE=http://your-host:3010 ./tests/rls_test.sh
# ============================================================

set -u

API_BASE="${API_BASE:-http://127.0.0.1:3010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin123}"

PASS=0
FAIL=0
FAILED=()

ts() { date +"%H:%M:%S"; }
log() { echo "[$(ts)] $*"; }

assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        PASS=$((PASS + 1))
        log "  PASS  $name (= $actual)"
    else
        FAIL=$((FAIL + 1))
        FAILED+=("$name")
        log "  FAIL  $name (期望 $expected, 实际 $actual)"
    fi
}

extract_token() {
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p' | head -1
}

extract_int() {
    sed -n "s/.*\"$1\":\([0-9]*\).*/\1/p" | head -1
}

count_objects() {
    # 数 JSON data 数组里有多少个对象（粗略：数顶层 "id":<num> 数量）
    grep -o '"id":[0-9]*' | wc -l
}

need_docker_psql() {
    if ! docker ps --format '{{.Names}}' | grep -q '^onebase$'; then
        log "FATAL: 容器 onebase 未运行（本测试通过 docker exec 操作业务库）"
        exit 2
    fi
}

run_sql() {
    docker exec onebase su - postgres -c "psql -d onebase -v ON_ERROR_STOP=1 -tA -c \"$1\"" 2>&1
}
run_sql_silent() {
    docker exec onebase su - postgres -c "psql -d onebase -v ON_ERROR_STOP=1 -q -c \"$1\"" >/dev/null 2>&1
}

# ============================================================
log "=== Onebase RLS 集成测试  base=$API_BASE ==="
need_docker_psql

# 0. 健康检查 + 清 Redis（防上轮残留缓存影响断言）
status=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/health/ready")
[[ "$status" == "200" ]] || { log "FATAL: 服务未就绪"; exit 2; }
docker exec onebase redis-cli FLUSHDB >/dev/null 2>&1 || true

# 1. 安装 app schema 辅助函数（幂等）
log "[1/9] 安装 app.current_user_id() 辅助函数"
docker exec onebase bash -c "psql -U postgres -d onebase -f /app/migrations/013_rls_helpers.sql" >/dev/null 2>&1
got=$(run_sql "SELECT app.current_user_id() IS NULL")
assert_eq "app.current_user_id() 默认返回 NULL" "t" "$got"

# 2. 准备非 super 应用角色（PostgreSQL 的 RLS 对 super 不生效，必须用普通角色）
log "[2/9] 创建非 super 应用角色 rls_app_user"
run_sql_silent "DROP ROLE IF EXISTS rls_app_user"
run_sql_silent "CREATE ROLE rls_app_user LOGIN PASSWORD 'rls_app_secret_pwd' NOSUPERUSER NOBYPASSRLS"
run_sql_silent "GRANT CONNECT ON DATABASE onebase TO rls_app_user"
run_sql_silent "GRANT USAGE ON SCHEMA app TO rls_app_user"
run_sql_silent "GRANT EXECUTE ON FUNCTION app.current_user_id() TO rls_app_user"

# 3. 准备测试 schema + 表 + RLS POLICY
log "[3/9] 准备 rls_test schema + messages 表 + POLICY"
run_sql_silent "DROP SCHEMA IF EXISTS rls_test CASCADE"
run_sql_silent "CREATE SCHEMA rls_test"
run_sql_silent "GRANT USAGE, CREATE ON SCHEMA rls_test TO rls_app_user"
run_sql_silent "CREATE TABLE rls_test.messages (id BIGSERIAL PRIMARY KEY, sender_id INT NOT NULL, receiver_id INT NOT NULL, body TEXT, created_at TIMESTAMPTZ DEFAULT NOW())"
run_sql_silent "ALTER TABLE rls_test.messages ENABLE ROW LEVEL SECURITY"
# 不需要 FORCE：rls_app_user 不是 owner 也不是 super，POLICY 默认就强制
run_sql_silent "CREATE POLICY msg_sender_read ON rls_test.messages FOR SELECT USING (sender_id = app.current_user_id())"
run_sql_silent "CREATE POLICY msg_receiver_read ON rls_test.messages FOR SELECT USING (receiver_id = app.current_user_id())"
run_sql_silent "CREATE POLICY msg_send ON rls_test.messages FOR INSERT WITH CHECK (sender_id = app.current_user_id())"
run_sql_silent "GRANT SELECT, INSERT, UPDATE, DELETE ON rls_test.messages TO rls_app_user"
run_sql_silent "GRANT USAGE, SELECT ON SEQUENCE rls_test.messages_id_seq TO rls_app_user"

# 4. 注册 / 登录 alice + cathy
log "[4/9] 准备测试用户 alice / bob / cathy"
ensure_user() {
    local username="$1" email="$2" password="$3"
    curl -sS -X POST "$API_BASE/auth/register" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$username\",\"email\":\"$email\",\"password\":\"$password\"}" >/dev/null 2>&1
    run_sql "SELECT id FROM users WHERE email='$email'" | head -1
}
ALICE_ID=$(ensure_user alice  alice@example.com  Alice12345)
BOB_ID=$(ensure_user   bob    bob@example.com    Bob12345678)
CATHY_ID=$(ensure_user cathy  cathy@example.com  Cathy123456)
log "  alice=$ALICE_ID  bob=$BOB_ID  cathy=$CATHY_ID"

# 5. 用 superuser 直接插测试数据（postgres 是 super，自动绕过 RLS POLICY）
log "[5/9] 插入测试数据（绕过 RLS）"
run_sql_silent "INSERT INTO rls_test.messages (sender_id, receiver_id, body) VALUES ($ALICE_ID, $BOB_ID, 'hi bob')"
run_sql_silent "INSERT INTO rls_test.messages (sender_id, receiver_id, body) VALUES ($BOB_ID, $ALICE_ID, 'hi alice')"
run_sql_silent "INSERT INTO rls_test.messages (sender_id, receiver_id, body) VALUES ($BOB_ID, $CATHY_ID, 'cathy private')"
total=$(run_sql "SELECT COUNT(*) FROM rls_test.messages")
assert_eq "测试数据插入 3 条" "3" "$total"

# 6. 用 admin token 创建一个走 rls_app_user 的 tenant_databases 连接
log "[6/9] 注册 tenant_databases 条目（db_user=rls_app_user）"
ADMIN_TOKEN=$(curl -sS -X POST "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | extract_token)
[[ -n "$ADMIN_TOKEN" ]] || { log "FATAL: admin 登录失败"; exit 2; }

# 找 admin 在哪个 tenant 是 owner/admin
TENANT_ID=$(run_sql "SELECT tenant_id FROM management.user_tenants WHERE user_id=(SELECT id FROM users WHERE email='$ADMIN_EMAIL') AND role IN ('owner','admin') ORDER BY tenant_id LIMIT 1")
[[ -n "$TENANT_ID" ]] || TENANT_ID=1
log "  tenant_id=$TENANT_ID"

create_resp=$(curl -sS -X POST "$API_BASE/api/tenants/connections" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"tenant_id\":$TENANT_ID,\"connection_name\":\"rls_test_conn_$$\",\"db_host\":\"localhost\",\"db_port\":5432,\"db_name\":\"onebase\",\"db_user\":\"rls_app_user\",\"db_password\":\"rls_app_secret_pwd\",\"is_primary\":false}")
DB_ID=$(echo "$create_resp" | extract_int "id")
[[ -n "$DB_ID" ]] || { log "FATAL: 创建连接失败 resp=$create_resp"; exit 2; }
log "  rls_test database_id=$DB_ID"

# 7. 给 alice/cathy 在该 tenant 加 viewer + editor 角色（让 RBAC 放行 SELECT/INSERT）
log "[7/9] 给测试用户加 RBAC 角色"
VIEWER_ID=$(run_sql "SELECT id FROM management.roles WHERE tenant_id=$TENANT_ID AND name='viewer'")
EDITOR_ID=$(run_sql "SELECT id FROM management.roles WHERE tenant_id=$TENANT_ID AND name='editor'")
for uid in $ALICE_ID $CATHY_ID; do
    run_sql_silent "INSERT INTO management.user_tenants (user_id, tenant_id, role) VALUES ($uid, $TENANT_ID, 'member') ON CONFLICT DO NOTHING"
    run_sql_silent "INSERT INTO management.user_roles (user_id, role_id, tenant_id) VALUES ($uid, $VIEWER_ID, $TENANT_ID) ON CONFLICT DO NOTHING"
    run_sql_silent "INSERT INTO management.user_roles (user_id, role_id, tenant_id) VALUES ($uid, $EDITOR_ID, $TENANT_ID) ON CONFLICT DO NOTHING"
done

# 8. 验证 RLS 行为
log "[8/9] 通过 Auto API 验证 RLS"

ALICE_TOKEN=$(curl -sS -X POST "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"alice@example.com\",\"password\":\"Alice12345\"}" | extract_token)

resp=$(curl -sS -H "Authorization: Bearer $ALICE_TOKEN" \
    "$API_BASE/api/v1/$DB_ID/rls_test/messages?limit=100")
alice_count=$(echo "$resp" | count_objects)
assert_eq "alice 通过 RLS 只看到 sender/receiver=自己 的消息(2 条)" "2" "$alice_count"

CATHY_TOKEN=$(curl -sS -X POST "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"cathy@example.com\",\"password\":\"Cathy123456\"}" | extract_token)

resp=$(curl -sS -H "Authorization: Bearer $CATHY_TOKEN" \
    "$API_BASE/api/v1/$DB_ID/rls_test/messages?limit=100")
cathy_count=$(echo "$resp" | count_objects)
log "  cathy resp=${resp:0:200}"
assert_eq "cathy 通过 RLS 只看到 receiver=cathy 的消息(1 条)" "1" "$cathy_count"

# alice 用自己身份 INSERT
status=$(curl -sS -o /tmp/rls_post.json -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $ALICE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"sender_id\":$ALICE_ID,\"receiver_id\":$BOB_ID,\"body\":\"alice ok\"}" \
    "$API_BASE/api/v1/$DB_ID/rls_test/messages")
assert_eq "alice POST 自己发出 -> 201" "201" "$status"

# alice 伪造 sender_id=bob：RLS WITH CHECK 拒绝（PG 报错 → 400）
status=$(curl -sS -o /tmp/rls_fake.json -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $ALICE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"sender_id\":$BOB_ID,\"receiver_id\":$CATHY_ID,\"body\":\"fake\"}" \
    "$API_BASE/api/v1/$DB_ID/rls_test/messages")
fake_resp_first40=$(head -c 200 /tmp/rls_fake.json)
log "  伪造请求响应 status=$status body=$fake_resp_first40"
# 期望被 RLS 拒绝（PG 抛 row violates row-level security policy → 业务层包成 400）
if [[ "$status" == "400" || "$status" == "403" ]]; then
    PASS=$((PASS + 1))
    log "  PASS  alice 伪造 sender_id=bob 被拒 (= $status)"
else
    FAIL=$((FAIL + 1))
    FAILED+=("伪造未被拒")
    log "  FAIL  alice 伪造未被拒（status=$status）"
fi

# 9. 清理
log "[9/9] 清理"
run_sql_silent "DELETE FROM management.tenant_databases WHERE id=$DB_ID"
run_sql_silent "DELETE FROM management.user_roles WHERE user_id=$CATHY_ID"
run_sql_silent "DELETE FROM management.user_tenants WHERE user_id=$CATHY_ID"
run_sql_silent "DROP SCHEMA rls_test CASCADE"
run_sql_silent "REVOKE ALL ON FUNCTION app.current_user_id() FROM rls_app_user"
run_sql_silent "REVOKE ALL ON SCHEMA app FROM rls_app_user"
run_sql_silent "REVOKE ALL ON DATABASE onebase FROM rls_app_user"
run_sql_silent "DROP ROLE IF EXISTS rls_app_user"

# ===== 总结 =====
echo ""
log "=========================================="
log "PASS: $PASS  FAIL: $FAIL"
if (( FAIL > 0 )); then
    log "失败用例: ${FAILED[*]}"
    log "=== RLS TESTS FAILED ==="
    exit 1
fi
log "=== ALL RLS TESTS PASSED ==="
exit 0
