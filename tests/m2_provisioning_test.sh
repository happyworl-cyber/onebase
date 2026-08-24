#!/usr/bin/env bash
# ============================================================
# M2 自助开通向导：端到端 smoke 测试
#
# 跑法：
#   ./tests/m2_provisioning_test.sh
#   API_BASE=http://127.0.0.1:3010 ./tests/m2_provisioning_test.sh
#
# 前置：
#   - 服务已启动并已应用 migration 018
#   - 平台超管账号（默认 admin@example.com / Admin123, is_superadmin=true）
#   - 普通用户账号（默认 test@example.com / Test1234）
#   - 至少一个**真实可连通**的 PG 池条目；脚本可以自动加一条（用 PG_POOL_HOST 等环境变量）
#     如果没有手工准备，将通过 /api/admin/pg-pools 加一条指向 ${PG_POOL_HOST:-localhost}
#
# 覆盖：
#   T1 普通用户用 'blank' 模板成功 provision
#   T2 同用户用相同 slug 重发 → provisioned=false（幂等）
#   T3 不同用户用相同 slug → 400/409 "slug 已被其他项目占用"
#   T4 非法 slug（含大写字母）→ 400
#   T5 选了 is_coming_soon=true 的 'blog' 模板 → 400
#   T6 用户视角 GET /api/provision/pg-pools/available → 不含 admin_user 字段
#   T7 用户视角 GET /api/project-templates → 4 条（含 stub）
# ============================================================

set -u

API_BASE="${API_BASE:-http://127.0.0.1:3010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin123}"
USER_EMAIL="${USER_EMAIL:-test@example.com}"
USER_PASSWORD="${USER_PASSWORD:-Test1234}"
USER2_EMAIL="${USER2_EMAIL:-}"
USER2_PASSWORD="${USER2_PASSWORD:-}"

# 用于"如果没池，临时加一条"——指向本机管理库主机，admin/admin_password 通常 = 业务方的 PG
PG_POOL_NAME="${PG_POOL_NAME:-m2-smoke-pool}"
PG_POOL_HOST="${PG_POOL_HOST:-localhost}"
PG_POOL_PORT="${PG_POOL_PORT:-5432}"
PG_POOL_ADMIN_USER="${PG_POOL_ADMIN_USER:-postgres}"
PG_POOL_ADMIN_PASSWORD="${PG_POOL_ADMIN_PASSWORD:-postgres}"

PASS=0; FAIL=0; SKIP=0
log()  { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "  PASS  $*"; }
fail() { FAIL=$((FAIL+1)); log "  FAIL  $*"; }
skip() { SKIP=$((SKIP+1)); log "  SKIP  $*"; }

login() {
    curl -sS -X POST "$API_BASE/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
        | grep -oE '"token":"[^"]+"' | head -1 | cut -d'"' -f4
}

slug_unique() { echo "m2smoke$(date +%s)$RANDOM"; }

log "M2 onboarding wizard smoke — $API_BASE"
log "登录管理员 + 普通用户..."
ADMIN_TOKEN=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" || true)
USER_TOKEN=$(login "$USER_EMAIL" "$USER_PASSWORD" || true)

if [[ -z "$ADMIN_TOKEN" ]]; then
    fail "管理员登录失败，停止"
    exit 1
fi
if [[ -z "$USER_TOKEN" ]]; then
    fail "普通用户登录失败，停止"
    exit 1
fi

# ─── 准备：确保至少有一条 PG 池 ─────────────────────────────────
log ""
log "── 准备 PG 池 ──"
POOLS_JSON=$(curl -sS "$API_BASE/api/admin/pg-pools" -H "Authorization: Bearer $ADMIN_TOKEN")
POOL_COUNT=$(echo "$POOLS_JSON" | grep -oE '"id":[0-9]+' | wc -l | tr -d ' ')

if [[ "$POOL_COUNT" == "0" ]]; then
    log "没有 PG 池，自动添加一条指向 ${PG_POOL_HOST}:${PG_POOL_PORT}"
    POOL_CREATE=$(curl -sS -X POST "$API_BASE/api/admin/pg-pools" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"$PG_POOL_NAME\",\"db_host\":\"$PG_POOL_HOST\",\"db_port\":$PG_POOL_PORT,\"admin_user\":\"$PG_POOL_ADMIN_USER\",\"admin_password\":\"$PG_POOL_ADMIN_PASSWORD\",\"note\":\"M2 smoke test pool\"}")
    POOL_ID=$(echo "$POOL_CREATE" | grep -oE '"id":[0-9]+' | head -1 | cut -d':' -f2)
    if [[ -z "$POOL_ID" ]]; then
        fail "创建 PG 池失败: $POOL_CREATE"
        exit 1
    fi
    log "  已创建池 #$POOL_ID"
else
    POOL_ID=$(echo "$POOLS_JSON" | grep -oE '"id":[0-9]+' | head -1 | cut -d':' -f2)
    log "  复用已有池 #$POOL_ID"
fi

# 验证池可连
TEST_RESULT=$(curl -sS -X POST "$API_BASE/api/admin/pg-pools/$POOL_ID/test" \
    -H "Authorization: Bearer $ADMIN_TOKEN")
if [[ "$TEST_RESULT" != *'"ok":true'* ]]; then
    skip "PG 池 #$POOL_ID 不可连，跳过实际 provisioning 测试: $TEST_RESULT"
    POOL_OK=false
else
    POOL_OK=true
    log "  池连通性 OK"
fi

# ─── T1 普通用户 provision blank 模板 ──────────────────────────
log ""
log "── T1 普通用户 provision blank 模板 ──"
if [[ "$POOL_OK" == "true" ]]; then
    SLUG=$(slug_unique)
    R1=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/projects/provision" \
        -H "Authorization: Bearer $USER_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"M2 Smoke $SLUG\",\"slug\":\"$SLUG\",\"pg_pool_id\":$POOL_ID,\"template_slug\":\"blank\",\"scenario\":\"通用\"}")
    HTTP1=$(echo "$R1" | tail -1)
    BODY1=$(echo "$R1" | sed '$d')
    if [[ "$HTTP1" == "200" ]] && [[ "$BODY1" == *'"provisioned":true'* ]]; then
        pass "T1 provisioned 200 / provisioned=true"
        PROJECT_ID=$(echo "$BODY1" | grep -oE '"project_id":[0-9]+' | head -1 | cut -d':' -f2)
        log "    project_id=$PROJECT_ID slug=$SLUG"
    else
        fail "T1 期望 200 + provisioned=true，实际 $HTTP1 / $BODY1"
        PROJECT_ID=""
    fi
else
    skip "T1（池不可连）"
    PROJECT_ID=""
fi

# ─── T2 幂等：同用户重发同 slug ─────────────────────────────────
log ""
log "── T2 同用户重发同 slug ──"
if [[ -n "$PROJECT_ID" ]]; then
    R2=$(curl -sS -X POST "$API_BASE/api/projects/provision" \
        -H "Authorization: Bearer $USER_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"M2 Smoke 2nd\",\"slug\":\"$SLUG\",\"pg_pool_id\":$POOL_ID,\"template_slug\":\"blank\"}")
    if [[ "$R2" == *'"provisioned":false'* ]] && [[ "$R2" == *"\"project_id\":$PROJECT_ID"* ]]; then
        pass "T2 idempotent → 返回同一个 project_id=$PROJECT_ID"
    else
        fail "T2 期望 provisioned=false + project_id=$PROJECT_ID，实际: $R2"
    fi
else
    skip "T2（T1 未通过）"
fi

# ─── T3 不同用户用相同 slug（如果 USER2 配置了） ─────────────
log ""
log "── T3 不同用户用相同 slug ──"
if [[ -n "$PROJECT_ID" && -n "$USER2_EMAIL" && -n "$USER2_PASSWORD" ]]; then
    USER2_TOKEN=$(login "$USER2_EMAIL" "$USER2_PASSWORD")
    if [[ -n "$USER2_TOKEN" ]]; then
        R3=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/projects/provision" \
            -H "Authorization: Bearer $USER2_TOKEN" \
            -H "Content-Type: application/json" \
            -d "{\"name\":\"M2 Squat\",\"slug\":\"$SLUG\",\"pg_pool_id\":$POOL_ID,\"template_slug\":\"blank\"}")
        HTTP3=$(echo "$R3" | tail -1)
        BODY3=$(echo "$R3" | sed '$d')
        if [[ "$HTTP3" == "400" || "$HTTP3" == "409" ]] && [[ "$BODY3" == *"占用"* ]]; then
            pass "T3 拒绝 ($HTTP3) — slug 已被其他项目占用"
        else
            fail "T3 期望 400/409+'占用'，实际 $HTTP3 / $BODY3"
        fi
    else
        skip "T3（USER2 登录失败）"
    fi
else
    skip "T3（未设置 USER2_EMAIL / USER2_PASSWORD 或 T1 未通过）"
fi

# ─── T4 非法 slug ─────────────────────────────────────────────
log ""
log "── T4 非法 slug（含大写） ──"
R4=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/projects/provision" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"Bad\",\"slug\":\"BadSlug\",\"pg_pool_id\":$POOL_ID,\"template_slug\":\"blank\"}")
HTTP4=$(echo "$R4" | tail -1)
if [[ "$HTTP4" == "400" ]]; then
    pass "T4 拒绝 400"
else
    fail "T4 期望 400，实际 $HTTP4 / $(echo "$R4" | sed '$d')"
fi

# ─── T5 选 is_coming_soon=true 的模板 ─────────────────────────
log ""
log "── T5 选 'blog' (is_coming_soon=true) 模板 ──"
SLUG5=$(slug_unique)
R5=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/projects/provision" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"M2 Blog\",\"slug\":\"$SLUG5\",\"pg_pool_id\":$POOL_ID,\"template_slug\":\"blog\"}")
HTTP5=$(echo "$R5" | tail -1)
BODY5=$(echo "$R5" | sed '$d')
if [[ "$HTTP5" == "400" ]] && [[ "$BODY5" == *"coming_soon"* || "$BODY5" == *"未发布"* ]]; then
    pass "T5 拒绝 400 — 模板未发布"
else
    fail "T5 期望 400+'未发布'，实际 $HTTP5 / $BODY5"
fi

# ─── T6 用户视角 GET /api/pg-pools/available ──────────────────
log ""
log "── T6 用户视角 pg-pools 不暴露 admin_user ──"
R6=$(curl -sS "$API_BASE/api/provision/pg-pools/available" -H "Authorization: Bearer $USER_TOKEN")
if [[ "$R6" != *"admin_user"* ]] && [[ "$R6" != *"admin_password"* ]]; then
    pass "T6 响应不含 admin_user / admin_password"
else
    fail "T6 响应泄露 admin 字段: $R6"
fi

# ─── T7 GET /api/project-templates 返回 4 条 ──────────────────
log ""
log "── T7 项目模板列表 ──"
R7=$(curl -sS "$API_BASE/api/project-templates" -H "Authorization: Bearer $USER_TOKEN")
COUNT7=$(echo "$R7" | grep -oE '"slug":"[a-z_-]+"' | wc -l | tr -d ' ')
if [[ "$COUNT7" == "4" ]] && [[ "$R7" == *'"slug":"blank"'* ]]; then
    pass "T7 4 条模板，含 blank"
else
    fail "T7 期望 4 条 + blank，实际 count=$COUNT7 body=$R7"
fi

# ─── 汇总 ─────────────────────────────────────────────────────
log ""
log "─────────────────────────────"
log "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
log "─────────────────────────────"
[[ "$FAIL" == "0" ]]
