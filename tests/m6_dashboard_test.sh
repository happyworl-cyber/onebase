#!/usr/bin/env bash
# ============================================================
# M6 项目级简化大盘：endpoint smoke 测试
#
# 跑法：
#   ./tests/m6_dashboard_test.sh
#   API_BASE=http://127.0.0.1:3010 TENANT_ID=2 ./tests/m6_dashboard_test.sh
#
# 前置：
#   - 服务已启动并应用了 M6 后端改动（夹路由 /api/dashboard/*）
#   - 平台超管账号（默认 admin@example.com / Admin123）
#   - 普通用户账号（默认 test@example.com / Test1234），属于 TENANT_ID 任意角色
#   - 可选 VIEWER_EMAIL / VIEWER_PASSWORD：用于 T4 viewer 读权放行确认
#
# 覆盖：
#   T1  普通成员 GET /api/dashboard/overview → 200 + 6 字段都在
#   T2  GET /api/dashboard/recent-activity → 200 + 数组（可能为空）
#   T3  没传 tenant_id → 400
#   T4  viewer 也能看（如果配置了 viewer 账号）→ 200
#   T5  非成员（不属于 TENANT_ID）→ 403
#   T6  hourly_24h 必须恰好 24 条
#   T7  recent-activity 不暴露 IP / user_agent / request_body 字段
# ============================================================

set -u

API_BASE="${API_BASE:-http://127.0.0.1:3010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin123}"
USER_EMAIL="${USER_EMAIL:-test@example.com}"
USER_PASSWORD="${USER_PASSWORD:-Test1234}"
TENANT_ID="${TENANT_ID:-}"

# 可选：viewer 账号；非成员账号
VIEWER_EMAIL="${VIEWER_EMAIL:-}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-}"
OUTSIDER_EMAIL="${OUTSIDER_EMAIL:-}"
OUTSIDER_PASSWORD="${OUTSIDER_PASSWORD:-}"

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

log "M6 dashboard smoke — $API_BASE"
USER_TOKEN=$(login "$USER_EMAIL" "$USER_PASSWORD" || true)
if [[ -z "$USER_TOKEN" ]]; then fail "普通用户登录失败，停止"; exit 1; fi
if [[ -z "$TENANT_ID" ]]; then
    fail "请设置 TENANT_ID（指向 $USER_EMAIL 加入的某个 tenant）"
    log "  Tip: 查 GET /api/projects 看自己的项目；project.id 就是 tenant_id"
    exit 1
fi

# ─── T1: overview 字段完整 ──────────────────────────────────────
log ""; log "── T1 overview 字段 ──"
R1=$(curl -sS -w "\n%{http_code}" "$API_BASE/api/dashboard/overview?tenant_id=$TENANT_ID" \
    -H "Authorization: Bearer $USER_TOKEN")
HTTP1=$(echo "$R1" | tail -1)
BODY1=$(echo "$R1" | sed '$d')
if [[ "$HTTP1" == "200" ]] \
   && [[ "$BODY1" == *'"qps_5min"'* ]] \
   && [[ "$BODY1" == *'"p95_ms_5min"'* ]] \
   && [[ "$BODY1" == *'"error_rate_24h"'* ]] \
   && [[ "$BODY1" == *'"slow_queries_24h"'* ]] \
   && [[ "$BODY1" == *'"active_api_keys"'* ]] \
   && [[ "$BODY1" == *'"calls_24h"'* ]] \
   && [[ "$BODY1" == *'"hourly_24h"'* ]]; then
    pass "T1 6 个指标 + hourly_24h 字段都在"
else
    fail "T1 字段缺失，实际 $HTTP1 / $BODY1"
fi

# ─── T2: recent-activity ─────────────────────────────────────────
log ""; log "── T2 recent-activity ──"
R2=$(curl -sS -w "\n%{http_code}" "$API_BASE/api/dashboard/recent-activity?tenant_id=$TENANT_ID&limit=5" \
    -H "Authorization: Bearer $USER_TOKEN")
HTTP2=$(echo "$R2" | tail -1)
BODY2=$(echo "$R2" | sed '$d')
if [[ "$HTTP2" == "200" ]] && [[ "$BODY2" == "["* ]]; then
    pass "T2 recent-activity 返回数组（可能为空）"
else
    fail "T2 期望 200 + JSON 数组，实际 $HTTP2 / ${BODY2:0:120}"
fi

# ─── T3: 缺 tenant_id ────────────────────────────────────────────
log ""; log "── T3 缺 tenant_id ──"
R3=$(curl -sS -w "\n%{http_code}" "$API_BASE/api/dashboard/overview" \
    -H "Authorization: Bearer $USER_TOKEN")
HTTP3=$(echo "$R3" | tail -1)
if [[ "$HTTP3" == "400" || "$HTTP3" == "422" ]]; then
    pass "T3 缺 tenant_id 拒绝 HTTP=$HTTP3"
else
    fail "T3 期望 400/422，实际 $HTTP3"
fi

# ─── T4: viewer 角色读权（可选）─────────────────────────────────
log ""; log "── T4 viewer 读权 ──"
if [[ -n "$VIEWER_EMAIL" && -n "$VIEWER_PASSWORD" ]]; then
    VTOK=$(login "$VIEWER_EMAIL" "$VIEWER_PASSWORD")
    if [[ -n "$VTOK" ]]; then
        R4=$(curl -sS -w "\n%{http_code}" "$API_BASE/api/dashboard/overview?tenant_id=$TENANT_ID" \
            -H "Authorization: Bearer $VTOK")
        HTTP4=$(echo "$R4" | tail -1)
        if [[ "$HTTP4" == "200" ]]; then
            pass "T4 viewer 200"
        else
            fail "T4 viewer 期望 200，实际 $HTTP4"
        fi
    else
        skip "T4（VIEWER 登录失败）"
    fi
else
    skip "T4（VIEWER_EMAIL / VIEWER_PASSWORD 未配置）"
fi

# ─── T5: 非成员 403（可选）──────────────────────────────────────
log ""; log "── T5 非成员 403 ──"
if [[ -n "$OUTSIDER_EMAIL" && -n "$OUTSIDER_PASSWORD" ]]; then
    OTOK=$(login "$OUTSIDER_EMAIL" "$OUTSIDER_PASSWORD")
    if [[ -n "$OTOK" ]]; then
        R5=$(curl -sS -w "\n%{http_code}" "$API_BASE/api/dashboard/overview?tenant_id=$TENANT_ID" \
            -H "Authorization: Bearer $OTOK")
        HTTP5=$(echo "$R5" | tail -1)
        if [[ "$HTTP5" == "403" ]]; then
            pass "T5 非成员 403"
        else
            fail "T5 非成员期望 403，实际 $HTTP5"
        fi
    else
        skip "T5（OUTSIDER 登录失败）"
    fi
else
    skip "T5（OUTSIDER_EMAIL / OUTSIDER_PASSWORD 未配置）"
fi

# ─── T6: hourly_24h 恰好 24 条 ──────────────────────────────────
log ""; log "── T6 hourly_24h 长度 ──"
N=$(echo "$BODY1" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["hourly_24h"]))' 2>/dev/null || echo "0")
if [[ "$N" == "24" ]]; then
    pass "T6 hourly_24h = 24"
else
    fail "T6 hourly_24h 长度 $N（期望 24）"
fi

# ─── T7: recent-activity 不暴露敏感字段 ─────────────────────────
log ""; log "── T7 recent-activity sanitized ──"
LEAK=0
for K in ip_address user_agent request_body; do
    if [[ "$BODY2" == *"\"$K\""* ]]; then
        fail "T7 暴露了敏感字段 $K"
        LEAK=1
    fi
done
[[ "$LEAK" == "0" ]] && pass "T7 sanitized OK（无 IP / user_agent / request_body）"

log ""
log "─────────────────────────────"
log "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
log "─────────────────────────────"
[[ "$FAIL" == "0" ]]
