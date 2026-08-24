#!/usr/bin/env bash
# ============================================================
# M3 可视化建表：DDL endpoints smoke 测试
#
# 跑法：
#   ./tests/m3_ddl_test.sh
#   API_BASE=http://127.0.0.1:3010 DATABASE_ID=2 ./tests/m3_ddl_test.sh
#
# 前置：
#   - 服务已启动并应用了 phase 1/2 改动
#   - 平台超管账号（默认 admin@example.com / Admin123）
#   - 普通用户账号（默认 test@example.com / Test1234）
#   - DATABASE_ID 指向一个**可写**的租户业务库（不是管理库）
#   - 普通用户在该 database 对应的 tenant 里有 member+ 角色
#
# 覆盖：
#   T1 普通 member 调 POST /api/ddl/tables 建表 → 200
#   T2 同一表名再建 → 5xx 表已存在
#   T3 PATCH /api/ddl/tables/:s/:t 加列 + SET NOT NULL → 200
#   T4 PATCH 用 v1 不支持的操作（改列名）→ 400
#   T5 黑名单 schema management → 403
#   T6 非法 schema 名（含空格）→ 400
#   T7 非法数据类型 hstore → 400
#   T8 DELETE 删表 + cascade → 200
#   T9 viewer 角色（如配置了 USER3）调用 → 403
#   T10 超管不带 X-Database-Id 调用 → 400 "缺少 X-Database-Id"
# ============================================================

set -u

API_BASE="${API_BASE:-http://127.0.0.1:3010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin123}"
USER_EMAIL="${USER_EMAIL:-test@example.com}"
USER_PASSWORD="${USER_PASSWORD:-Test1234}"
DATABASE_ID="${DATABASE_ID:-}"
TARGET_SCHEMA="${TARGET_SCHEMA:-public}"

# 可选：viewer 角色账号，用于 T9
USER3_EMAIL="${USER3_EMAIL:-}"
USER3_PASSWORD="${USER3_PASSWORD:-}"

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

log "M3 DDL smoke — $API_BASE"
ADMIN_TOKEN=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" || true)
USER_TOKEN=$(login "$USER_EMAIL" "$USER_PASSWORD" || true)

if [[ -z "$ADMIN_TOKEN" ]]; then fail "管理员登录失败，停止"; exit 1; fi
if [[ -z "$USER_TOKEN" ]]; then fail "普通用户登录失败，停止"; exit 1; fi
if [[ -z "$DATABASE_ID" ]]; then
    fail "请设置 DATABASE_ID 指向一个可写业务库"
    log "  Tip: curl -sS '$API_BASE/api/tenants/my-connections' -H \"Authorization: Bearer \$USER_TOKEN\""
    exit 1
fi

TABLE_NAME="m3smoke_$(date +%s)$RANDOM"

# ─── T1: 建表（普通 member） ───────────────────────────────────────
log ""; log "── T1 建表 ──"
R1=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/ddl/tables" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "X-Database-Id: $DATABASE_ID" \
    -H "Content-Type: application/json" \
    -d "{
        \"schema\": \"$TARGET_SCHEMA\",
        \"table\": \"$TABLE_NAME\",
        \"columns\": [
            {\"name\":\"id\",\"data_type\":\"serial\",\"nullable\":false,\"is_primary_key\":true},
            {\"name\":\"title\",\"data_type\":\"varchar\",\"length\":200,\"nullable\":false},
            {\"name\":\"created_at\",\"data_type\":\"timestamptz\",\"nullable\":false,\"default_value\":\"CURRENT_TIMESTAMP\"}
        ],
        \"indexes\": [
            {\"name\":\"${TABLE_NAME}_title_idx\",\"columns\":[\"title\"],\"is_unique\":false}
        ]
    }")
HTTP1=$(echo "$R1" | tail -1)
BODY1=$(echo "$R1" | sed '$d')
if [[ "$HTTP1" == "200" ]] && [[ "$BODY1" == *'"success":true'* ]]; then
    pass "T1 建表成功 $TARGET_SCHEMA.$TABLE_NAME"
else
    fail "T1 期望 200/success，实际 $HTTP1 / $BODY1"
fi

# ─── T2: 重复建 ───────────────────────────────────────────────────
log ""; log "── T2 重复建（应失败）──"
R2=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/ddl/tables" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "X-Database-Id: $DATABASE_ID" \
    -H "Content-Type: application/json" \
    -d "{
        \"schema\": \"$TARGET_SCHEMA\",
        \"table\": \"$TABLE_NAME\",
        \"columns\": [{\"name\":\"id\",\"data_type\":\"integer\",\"nullable\":false}]
    }")
HTTP2=$(echo "$R2" | tail -1)
if [[ "$HTTP2" != "200" ]]; then
    pass "T2 重复建拒绝 HTTP=$HTTP2"
else
    fail "T2 重复建应失败但返回 200"
fi

# ─── T3: ALTER 加列 + SET NOT NULL ────────────────────────────────
log ""; log "── T3 ALTER：加列 + 改 NOT NULL ──"
R3=$(curl -sS -w "\n%{http_code}" -X PATCH "$API_BASE/api/ddl/tables/$TARGET_SCHEMA/$TABLE_NAME" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "X-Database-Id: $DATABASE_ID" \
    -H "Content-Type: application/json" \
    -d '{
        "operations": [
            {"kind":"add_column","column":{"name":"author","data_type":"varchar","length":100,"nullable":true}},
            {"kind":"set_default","name":"author","value":"anonymous"},
            {"kind":"set_not_null","name":"author","value":false}
        ]
    }')
HTTP3=$(echo "$R3" | tail -1)
BODY3=$(echo "$R3" | sed '$d')
if [[ "$HTTP3" == "200" ]] && [[ "$BODY3" == *'"operations":3'* ]]; then
    pass "T3 ALTER 3 操作成功"
else
    fail "T3 期望 200/operations=3，实际 $HTTP3 / $BODY3"
fi

# ─── T4: 不支持的操作（用未知 kind） ──────────────────────────────
log ""; log "── T4 未知 AlterOp ──"
R4=$(curl -sS -w "\n%{http_code}" -X PATCH "$API_BASE/api/ddl/tables/$TARGET_SCHEMA/$TABLE_NAME" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "X-Database-Id: $DATABASE_ID" \
    -H "Content-Type: application/json" \
    -d '{"operations":[{"kind":"rename_column","name":"title","new_name":"heading"}]}')
HTTP4=$(echo "$R4" | tail -1)
# serde 解析 unknown tag → 422 in axum default
if [[ "$HTTP4" == "400" || "$HTTP4" == "422" ]]; then
    pass "T4 未知 op 拒绝 HTTP=$HTTP4"
else
    fail "T4 期望 400/422，实际 $HTTP4 / $(echo "$R4" | sed '$d')"
fi

# ─── T5: 黑名单 schema management ─────────────────────────────────
log ""; log "── T5 黑名单 schema ──"
R5=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/ddl/tables" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "X-Database-Id: $DATABASE_ID" \
    -H "Content-Type: application/json" \
    -d '{
        "schema":"management",
        "table":"hacked",
        "columns":[{"name":"x","data_type":"integer","nullable":true}]
    }')
HTTP5=$(echo "$R5" | tail -1)
BODY5=$(echo "$R5" | sed '$d')
if [[ "$HTTP5" == "403" ]] && [[ "$BODY5" == *"不允许"* ]]; then
    pass "T5 黑名单 schema 拒绝 403"
else
    fail "T5 期望 403+'不允许'，实际 $HTTP5 / $BODY5"
fi

# ─── T6: 非法 schema 名 ──────────────────────────────────────────
log ""; log "── T6 非法 schema 名 ──"
R6=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/ddl/tables" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "X-Database-Id: $DATABASE_ID" \
    -H "Content-Type: application/json" \
    -d '{
        "schema":"has space",
        "table":"x",
        "columns":[{"name":"id","data_type":"integer"}]
    }')
HTTP6=$(echo "$R6" | tail -1)
if [[ "$HTTP6" == "400" ]]; then
    pass "T6 非法 schema 名 400"
else
    fail "T6 期望 400，实际 $HTTP6"
fi

# ─── T7: 非法 data_type ──────────────────────────────────────────
log ""; log "── T7 非法 data_type ──"
R7=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/ddl/tables" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "X-Database-Id: $DATABASE_ID" \
    -H "Content-Type: application/json" \
    -d "{
        \"schema\":\"$TARGET_SCHEMA\",
        \"table\":\"m3smoke_bad\",
        \"columns\":[{\"name\":\"x\",\"data_type\":\"hstore\"}]
    }")
HTTP7=$(echo "$R7" | tail -1)
if [[ "$HTTP7" == "400" ]]; then
    pass "T7 非白名单类型拒绝 400"
else
    fail "T7 期望 400，实际 $HTTP7"
fi

# ─── T8: 删表 ────────────────────────────────────────────────────
log ""; log "── T8 删表（CASCADE）──"
R8=$(curl -sS -w "\n%{http_code}" -X DELETE "$API_BASE/api/ddl/tables/$TARGET_SCHEMA/$TABLE_NAME?cascade=true" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "X-Database-Id: $DATABASE_ID")
HTTP8=$(echo "$R8" | tail -1)
BODY8=$(echo "$R8" | sed '$d')
if [[ "$HTTP8" == "200" ]] && [[ "$BODY8" == *'"success":true'* ]]; then
    pass "T8 删表成功"
else
    fail "T8 期望 200，实际 $HTTP8 / $BODY8"
fi

# ─── T9: viewer 角色（可选）────────────────────────────────────
log ""; log "── T9 viewer 调用 DDL ──"
if [[ -n "$USER3_EMAIL" && -n "$USER3_PASSWORD" ]]; then
    USER3_TOKEN=$(login "$USER3_EMAIL" "$USER3_PASSWORD")
    if [[ -n "$USER3_TOKEN" ]]; then
        R9=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/ddl/tables" \
            -H "Authorization: Bearer $USER3_TOKEN" \
            -H "X-Database-Id: $DATABASE_ID" \
            -H "Content-Type: application/json" \
            -d "{\"schema\":\"$TARGET_SCHEMA\",\"table\":\"viewer_$RANDOM\",\"columns\":[{\"name\":\"id\",\"data_type\":\"integer\"}]}")
        HTTP9=$(echo "$R9" | tail -1)
        if [[ "$HTTP9" == "403" ]]; then
            pass "T9 viewer 403"
        else
            fail "T9 期望 403，实际 $HTTP9 / $(echo "$R9" | sed '$d')"
        fi
    else
        skip "T9（USER3 登录失败）"
    fi
else
    skip "T9（USER3_EMAIL / USER3_PASSWORD 未配置）"
fi

# ─── T10: 超管不带 X-Database-Id ────────────────────────────────
log ""; log "── T10 超管不带 X-Database-Id ──"
R10=$(curl -sS -w "\n%{http_code}" -X POST "$API_BASE/api/ddl/tables" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"schema\":\"$TARGET_SCHEMA\",\"table\":\"noheader_$RANDOM\",\"columns\":[{\"name\":\"id\",\"data_type\":\"integer\"}]}")
HTTP10=$(echo "$R10" | tail -1)
BODY10=$(echo "$R10" | sed '$d')
if [[ "$HTTP10" == "400" ]] && [[ "$BODY10" == *"X-Database-Id"* ]]; then
    pass "T10 缺头拒绝 400"
else
    fail "T10 期望 400+'X-Database-Id'，实际 $HTTP10 / $BODY10"
fi

log ""
log "─────────────────────────────"
log "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
log "─────────────────────────────"
[[ "$FAIL" == "0" ]]
