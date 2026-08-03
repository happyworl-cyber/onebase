#!/usr/bin/env bash
# ============================================================
# W1 项目工作空间端到端集成测试
#
# 跑法：
#   ./tests/m1_workspace_test.sh
#   API_BASE=http://127.0.0.1:3010 ./tests/m1_workspace_test.sh
#
# 前置：
#   - 服务已启动
#   - 存在 admin 账号（默认 admin@example.com / Admin123）且 is_superadmin=true
#   - 存在普通用户账号（默认 test@example.com / Test1234）
#   - 普通用户至少加入 1 个 tenant（脚本会查询 user_tenants 跳过 seed）
# ============================================================

set -u

API_BASE="${API_BASE:-http://127.0.0.1:3010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin123}"
USER_EMAIL="${USER_EMAIL:-test@example.com}"
USER_PASSWORD="${USER_PASSWORD:-Test1234}"

PASS=0
FAIL=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        PASS=$((PASS + 1)); log "  PASS  $name (= $actual)"
    else
        FAIL=$((FAIL + 1)); log "  FAIL  $name (期望 $expected, 实际 $actual)"
    fi
}

login() {
    # $1=email $2=password → echo token
    curl -sS -X POST "$API_BASE/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
        | grep -oE '"token":"[^"]+"' | head -1 | cut -d'"' -f4
}

# 准备 token
log "Login as admin ($ADMIN_EMAIL)"
ADMIN_TOKEN=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[[ -z "$ADMIN_TOKEN" ]] && { echo "FATAL: admin 登录失败"; exit 2; }

log "Login as normal user ($USER_EMAIL)"
USER_TOKEN=$(login "$USER_EMAIL" "$USER_PASSWORD")
[[ -z "$USER_TOKEN" ]] && { echo "FATAL: 普通用户登录失败（请确认账号存在并密码正确）"; exit 2; }

# Test 1: 未授权访问 /api/projects → 401
log "Test 1: GET /api/projects 无 token"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/api/projects")
assert_eq "/api/projects 401 without token" "401" "$STATUS"

# Test 2: 超管 GET /api/projects → 200 + projects 数组
log "Test 2: 超管 GET /api/projects"
BODY=$(curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/api/projects")
echo "$BODY" | grep -q '"projects":\[' && r=ok || r=no
assert_eq "admin projects array exists" "ok" "$r"

# Test 3: 普通用户 GET /api/projects → 200 + projects 数组
log "Test 3: 普通用户 GET /api/projects"
USER_BODY=$(curl -sS -H "Authorization: Bearer $USER_TOKEN" "$API_BASE/api/projects")
echo "$USER_BODY" | grep -q '"projects":\[' && r=ok || r=no
assert_eq "user projects array exists" "ok" "$r"

# Test 4: 普通用户返回里 user_role 字段不应为 'superadmin'
log "Test 4: 普通用户 projects 里 user_role 不应是 superadmin"
echo "$USER_BODY" | grep -q '"user_role":"superadmin"' && r=found || r=ok
assert_eq "user not flagged as superadmin" "ok" "$r"

# Test 5: 拿用户第一个项目 id
FIRST_USER_PROJECT_ID=$(echo "$USER_BODY" | grep -oE '"id":[0-9]+' | head -1 | cut -d':' -f2)
if [[ -z "$FIRST_USER_PROJECT_ID" ]]; then
    log "  SKIP  Test 5-7：普通用户没有任何项目，跳过"
else
    # Test 5: 普通用户 GET /api/projects/:id (自己的) → 200
    log "Test 5: 普通用户 GET /api/projects/$FIRST_USER_PROJECT_ID"
    STATUS=$(curl -sS -o /tmp/m1_get.json -w "%{http_code}" \
        -H "Authorization: Bearer $USER_TOKEN" \
        "$API_BASE/api/projects/$FIRST_USER_PROJECT_ID")
    assert_eq "get own project 200" "200" "$STATUS"

    # Test 6: 返回里包含 user_role 字段
    grep -q '"user_role":' /tmp/m1_get.json && r=ok || r=no
    assert_eq "get_project 包含 user_role" "ok" "$r"

    # Test 7: 超管访问任意项目 → 200 + user_role=superadmin
    log "Test 7: 超管 GET /api/projects/$FIRST_USER_PROJECT_ID"
    curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
        "$API_BASE/api/projects/$FIRST_USER_PROJECT_ID" > /tmp/m1_admin_get.json
    grep -q '"user_role":"superadmin"' /tmp/m1_admin_get.json && r=ok || r=no
    assert_eq "admin user_role=superadmin" "ok" "$r"
fi

# Test 8: GET /api/projects/999999 不存在 → 404
log "Test 8: GET /api/projects/999999"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$API_BASE/api/projects/999999")
assert_eq "get nonexistent project 404" "404" "$STATUS"

# Test 9: 普通用户访问他人项目（用一个超管能看到但用户不参与的 id）→ 403
log "Test 9: 普通用户访问他不参与的项目"
ADMIN_PROJECTS=$(echo "$BODY" | grep -oE '"id":[0-9]+' | cut -d':' -f2 | sort -u)
USER_PROJECTS=$(echo "$USER_BODY" | grep -oE '"id":[0-9]+' | cut -d':' -f2 | sort -u)
NOT_USER_PROJECT=""
for pid in $ADMIN_PROJECTS; do
    if ! echo "$USER_PROJECTS" | grep -qx "$pid"; then
        NOT_USER_PROJECT="$pid"
        break
    fi
done
if [[ -z "$NOT_USER_PROJECT" ]]; then
    log "  SKIP  Test 9：找不到一个超管能看但用户不参与的项目（跳过）"
else
    STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $USER_TOKEN" \
        "$API_BASE/api/projects/$NOT_USER_PROJECT")
    assert_eq "non-member access -> 403" "403" "$STATUS"
fi

# 总结
log "================================================"
log "PASS=$PASS  FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
