#!/usr/bin/env bash
# ============================================================
# M4 RBAC 可视化：endpoint smoke 测试
#
# 跑法：
#   ./tests/m4_rbac_smoke.sh
#   API_BASE=http://127.0.0.1:3010 DATABASE_ID=2 ./tests/m4_rbac_smoke.sh
#
# 前置：
#   - 服务已启动并应用了 M4 后端（实际后端零改动；M4 是前端工程）
#   - 平台超管账号（默认 admin@example.com / Admin123）—— 用于建租户管理员
#   - 一个 tenant admin 账号（USER_EMAIL / USER_PASSWORD，默认 test@example.com / Test1234）
#   - 该账号挂在某 tenant 上且角色 = admin / owner
#   - DATABASE_ID = 该 tenant 对应的 database_id（前端项目 ID）
#
# 覆盖：
#   T1  admin 创建带结构化条件的 permission → 200
#   T2  list permissions 含刚创建的（按 resource 找）
#   T3  update 该 permission（替换 conditions + 改 allowed_columns）→ 200
#   T4  创建 role + setRolePermissions 把上面 permission 挂上 → 200，回读匹配
#   T5  legacy 裸字符串 conditions （旧格式）→ 后端 INSERT 通过（数据层兼容），但运行时
#       merge_permissions 解析失败 = 视为该权限失效。此 smoke 仅校验 schema 接受 + 列表正常
#   T6  非 admin（member / viewer）尝试创建 → 403（如配 OUTSIDER 账号；否则 skip）
#   T7  删除 permission + role 清理
# ============================================================

set -u

API_BASE="${API_BASE:-http://127.0.0.1:3010}"
USER_EMAIL="${USER_EMAIL:-test@example.com}"
USER_PASSWORD="${USER_PASSWORD:-Test1234}"
DATABASE_ID="${DATABASE_ID:-}"

# 可选：非 admin 账号
OUTSIDER_EMAIL="${OUTSIDER_EMAIL:-}"
OUTSIDER_PASSWORD="${OUTSIDER_PASSWORD:-}"

RESOURCE="${RESOURCE:-public.m4_smoke_resource}"

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

call() {
    # call METHOD URL TOKEN [BODY]
    local method="$1" url="$2" token="$3" body="${4:-}"
    if [[ -n "$body" ]]; then
        curl -sS -w "\n%{http_code}" -X "$method" "$API_BASE$url" \
            -H "Authorization: Bearer $token" \
            -H "X-Database-Id: $DATABASE_ID" \
            -H "Content-Type: application/json" \
            -d "$body"
    else
        curl -sS -w "\n%{http_code}" -X "$method" "$API_BASE$url" \
            -H "Authorization: Bearer $token" \
            -H "X-Database-Id: $DATABASE_ID"
    fi
}

log "M4 RBAC smoke — $API_BASE"

if [[ -z "$DATABASE_ID" ]]; then
    fail "请设置 DATABASE_ID（指向 $USER_EMAIL 加入的某个 tenant 的 database_id）"
    exit 1
fi

USER_TOKEN=$(login "$USER_EMAIL" "$USER_PASSWORD" || true)
if [[ -z "$USER_TOKEN" ]]; then fail "用户登录失败，停止"; exit 1; fi

# ─── T1: 创建带结构化条件的 permission ─────────────────────────────────
log ""; log "── T1 创建结构化 permission ──"
BODY1=$(cat <<EOF
{
  "resource": "$RESOURCE",
  "action": "SELECT",
  "conditions": [
    {"field": "author_id", "op": "=", "value": "\$current_user_id"},
    {"field": "status", "op": "in", "value": ["published","draft"]}
  ],
  "allowed_columns": null,
  "denied_columns": ["password_hash"],
  "description": "M4 smoke test"
}
EOF
)
R1=$(call POST /api/rbac/permissions "$USER_TOKEN" "$BODY1")
HTTP1=$(echo "$R1" | tail -1)
BODY1R=$(echo "$R1" | sed '$d')
if [[ "$HTTP1" == "200" ]] && [[ "$BODY1R" == *'"resource"'* ]]; then
    PERM_ID=$(echo "$BODY1R" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])' 2>/dev/null || echo "")
    if [[ -n "$PERM_ID" ]]; then
        pass "T1 创建成功 id=$PERM_ID"
    else
        fail "T1 200 但无法解析 id：${BODY1R:0:160}"; exit 1
    fi
else
    fail "T1 期望 200，实际 $HTTP1 / ${BODY1R:0:200}"
    exit 1
fi

# ─── T2: 列表能查到 ────────────────────────────────────────────────
log ""; log "── T2 list permissions 含刚创建的 ──"
R2=$(call GET /api/rbac/permissions "$USER_TOKEN")
HTTP2=$(echo "$R2" | tail -1)
BODY2=$(echo "$R2" | sed '$d')
if [[ "$HTTP2" == "200" ]] && [[ "$BODY2" == *"\"resource\":\"$RESOURCE\""* ]]; then
    pass "T2 list 含 $RESOURCE"
else
    fail "T2 list 不含 / 异常 HTTP=$HTTP2 body=${BODY2:0:160}"
fi

# ─── T3: 更新条件 + 列控制 ──────────────────────────────────────────
log ""; log "── T3 update permission（条件 + 列）──"
BODY3=$(cat <<EOF
{
  "conditions": [
    {"field": "tenant_id", "op": "=", "value": "\$current_user_id"}
  ],
  "allowed_columns": ["id","title","author_id"],
  "denied_columns": []
}
EOF
)
R3=$(call PATCH "/api/rbac/permissions/$PERM_ID" "$USER_TOKEN" "$BODY3")
HTTP3=$(echo "$R3" | tail -1)
BODY3R=$(echo "$R3" | sed '$d')
if [[ "$HTTP3" == "200" ]] \
    && [[ "$BODY3R" == *'"tenant_id"'* ]] \
    && [[ "$BODY3R" == *'"allowed_columns"'* ]]; then
    pass "T3 update 200"
else
    fail "T3 期望 200 + 更新字段，实际 $HTTP3 / ${BODY3R:0:200}"
fi

# ─── T4: 创建 role + 挂 permission ──────────────────────────────────
log ""; log "── T4 创建 role 并绑定 permission ──"
ROLE_NAME="m4_smoke_role_$(date +%s)"
R4A=$(call POST /api/rbac/roles "$USER_TOKEN" "{\"name\":\"$ROLE_NAME\",\"description\":\"M4 smoke\"}")
HTTP4A=$(echo "$R4A" | tail -1)
BODY4A=$(echo "$R4A" | sed '$d')
if [[ "$HTTP4A" != "200" ]]; then
    fail "T4 创建 role 失败 HTTP=$HTTP4A / ${BODY4A:0:160}"
else
    ROLE_ID=$(echo "$BODY4A" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])' 2>/dev/null || echo "")
    if [[ -z "$ROLE_ID" ]]; then
        fail "T4 200 但无 role.id"
    else
        R4B=$(call PUT "/api/rbac/roles/$ROLE_ID/permissions" "$USER_TOKEN" "{\"permission_ids\":[$PERM_ID]}")
        HTTP4B=$(echo "$R4B" | tail -1)
        if [[ "$HTTP4B" == "200" ]]; then
            R4C=$(call GET "/api/rbac/roles/$ROLE_ID/permissions" "$USER_TOKEN")
            BODY4C=$(echo "$R4C" | sed '$d')
            if [[ "$BODY4C" == *"\"id\":$PERM_ID"* ]]; then
                pass "T4 role $ROLE_ID 已绑 permission $PERM_ID 并回读匹配"
            else
                fail "T4 setRolePermissions 200 但回读没找到：${BODY4C:0:200}"
            fi
        else
            fail "T4 setRolePermissions HTTP=$HTTP4B"
        fi
    fi
fi

# ─── T5: legacy 字符串 conditions：data layer 兼容（INSERT 通过）─────
log ""; log "── T5 legacy 字符串 conditions（schema 兼容）──"
BODY5='{
  "resource": "'"$RESOURCE"'_legacy",
  "action": "SELECT",
  "conditions": ["author_id = :current_user_id"]
}'
R5=$(call POST /api/rbac/permissions "$USER_TOKEN" "$BODY5")
HTTP5=$(echo "$R5" | tail -1)
BODY5R=$(echo "$R5" | sed '$d')
if [[ "$HTTP5" == "200" ]]; then
    LEGACY_ID=$(echo "$BODY5R" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])' 2>/dev/null || echo "")
    pass "T5 schema 接受 legacy string conditions（id=$LEGACY_ID，运行时由 parse_row_conditions 拒绝）"
elif [[ "$HTTP5" == "400" || "$HTTP5" == "422" ]]; then
    # 后端如果做了 schema-level 校验拒绝 string，也是合理选择
    pass "T5 schema 直接拒绝 legacy string（HTTP=$HTTP5）—— 更严格行为"
    LEGACY_ID=""
else
    fail "T5 期望 200 或 400/422，实际 $HTTP5 / ${BODY5R:0:160}"
    LEGACY_ID=""
fi

# ─── T6: 非 admin → 403（可选）──────────────────────────────────────
log ""; log "── T6 非 admin 创建 → 403 ──"
if [[ -n "$OUTSIDER_EMAIL" && -n "$OUTSIDER_PASSWORD" ]]; then
    OTOK=$(login "$OUTSIDER_EMAIL" "$OUTSIDER_PASSWORD")
    if [[ -n "$OTOK" ]]; then
        R6=$(call POST /api/rbac/permissions "$OTOK" "{\"resource\":\"public.x\",\"action\":\"SELECT\"}")
        HTTP6=$(echo "$R6" | tail -1)
        if [[ "$HTTP6" == "403" ]]; then
            pass "T6 非 admin 403"
        else
            fail "T6 期望 403，实际 $HTTP6"
        fi
    else
        skip "T6（OUTSIDER 登录失败）"
    fi
else
    skip "T6（OUTSIDER_EMAIL / OUTSIDER_PASSWORD 未配置）"
fi

# ─── T7: 清理 ──────────────────────────────────────────────────────
log ""; log "── T7 清理 ──"
if [[ -n "${ROLE_ID:-}" ]]; then
    call DELETE "/api/rbac/roles/$ROLE_ID" "$USER_TOKEN" > /dev/null
fi
if [[ -n "${PERM_ID:-}" ]]; then
    call DELETE "/api/rbac/permissions/$PERM_ID" "$USER_TOKEN" > /dev/null
fi
if [[ -n "${LEGACY_ID:-}" ]]; then
    call DELETE "/api/rbac/permissions/$LEGACY_ID" "$USER_TOKEN" > /dev/null
fi
pass "T7 cleanup attempted"

log ""
log "─────────────────────────────"
log "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
log "─────────────────────────────"
[[ "$FAIL" == "0" ]]
