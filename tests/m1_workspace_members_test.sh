#!/usr/bin/env bash
# ============================================================
# W4 / PASE Stage E：项目成员管理 + 项目元信息编辑 端到端测试
#
# 跑法：
#   ./tests/m1_workspace_members_test.sh
#   API_BASE=http://127.0.0.1:3010 ./tests/m1_workspace_members_test.sh
#
# 前置：
#   - 服务已启动
#   - 存在 admin 账号（默认 admin@example.com / Admin123）且 is_superadmin=true
#   - 存在普通用户账号（默认 test@example.com / Test1234）
#   - 普通用户至少加入 1 个 tenant，且在该 tenant 是 owner 或 admin
#     （脚本会自动选第一个项目；如果普通用户不是 owner 部分用例 SKIP）
# ============================================================

set -u

API_BASE="${API_BASE:-http://127.0.0.1:3010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin123}"
USER_EMAIL="${USER_EMAIL:-test@example.com}"
USER_PASSWORD="${USER_PASSWORD:-Test1234}"

PASS=0
FAIL=0
SKIP=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        PASS=$((PASS + 1)); log "  PASS  $name (= $actual)"
    else
        FAIL=$((FAIL + 1)); log "  FAIL  $name (期望 $expected, 实际 $actual)"
    fi
}
note_skip() { SKIP=$((SKIP + 1)); log "  SKIP  $*"; }

login() {
    curl -sS -X POST "$API_BASE/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
        | grep -oE '"token":"[^"]+"' | head -1 | cut -d'"' -f4
}

log "Login as admin ($ADMIN_EMAIL)"
ADMIN_TOKEN=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[[ -z "$ADMIN_TOKEN" ]] && { echo "FATAL: admin 登录失败"; exit 2; }

log "Login as normal user ($USER_EMAIL)"
USER_TOKEN=$(login "$USER_EMAIL" "$USER_PASSWORD")
[[ -z "$USER_TOKEN" ]] && { echo "FATAL: 普通用户登录失败"; exit 2; }

# 取普通用户的第一个项目 + 该用户在该项目的 role
USER_PROJECTS=$(curl -sS -H "Authorization: Bearer $USER_TOKEN" "$API_BASE/api/projects")
PROJECT_ID=$(echo "$USER_PROJECTS" | grep -oE '"id":[0-9]+' | head -1 | cut -d':' -f2)
if [[ -z "$PROJECT_ID" ]]; then
    echo "FATAL: 普通用户没有任何项目，无法跑成员管理测试"
    exit 2
fi
log "Using project_id = $PROJECT_ID for member tests"

USER_ROLE=$(curl -sS -H "Authorization: Bearer $USER_TOKEN" "$API_BASE/api/projects/$PROJECT_ID" \
    | grep -oE '"user_role":"[^"]+"' | head -1 | cut -d'"' -f4)
log "Normal user role in project $PROJECT_ID = $USER_ROLE"

# 取 admin 自己的 user_id（用于"添加成员"时不要重复加自己）
ADMIN_USER_ID=$(curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/auth/me" \
    | grep -oE '"id":[0-9]+' | head -1 | cut -d':' -f2)
USER_USER_ID=$(curl -sS -H "Authorization: Bearer $USER_TOKEN" "$API_BASE/auth/me" \
    | grep -oE '"id":[0-9]+' | head -1 | cut -d':' -f2)
log "ADMIN_USER_ID=$ADMIN_USER_ID  USER_USER_ID=$USER_USER_ID"

# ─── Test 1: 无 token GET members → 401 ─────────────────────────────────
log "Test 1: GET /api/projects/$PROJECT_ID/members 无 token"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/api/projects/$PROJECT_ID/members")
assert_eq "list members 401 without token" "401" "$STATUS"

# ─── Test 2: 超管列成员 → 200 ────────────────────────────────────────────
log "Test 2: admin GET members"
STATUS=$(curl -sS -o /tmp/m1_members.json -w "%{http_code}" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$API_BASE/api/projects/$PROJECT_ID/members")
assert_eq "admin list members 200" "200" "$STATUS"
grep -q '"role":' /tmp/m1_members.json && r=ok || r=no
assert_eq "admin list members contains role" "ok" "$r"

# ─── Test 3: 普通用户列成员（自己是 admin+ 时） → 200；否则 403 ───────────
log "Test 3: normal user GET members (role=$USER_ROLE)"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $USER_TOKEN" \
    "$API_BASE/api/projects/$PROJECT_ID/members")
case "$USER_ROLE" in
    owner|admin|superadmin)
        assert_eq "admin+ user list members 200" "200" "$STATUS"
        ;;
    *)
        assert_eq "member/viewer list members 403" "403" "$STATUS"
        ;;
esac

# ─── Test 4: 添加成员（admin 自己当目标，role=member），再删除 ──────────
# 先把 admin 临时加进项目（项目应该没有 admin 在里），完事再删
log "Test 4a: 超管 POST member (target=admin self, role=member)"
STATUS=$(curl -sS -o /tmp/m1_add.json -w "%{http_code}" \
    -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":$ADMIN_USER_ID,\"role\":\"member\"}" \
    "$API_BASE/api/projects/$PROJECT_ID/members")
assert_eq "admin add member 200" "200" "$STATUS"
grep -q "\"user_id\":$ADMIN_USER_ID" /tmp/m1_add.json && r=ok || r=no
assert_eq "add member returns new row" "ok" "$r"

# ─── Test 4b: 不能改自己的角色 → 400 ────────────────────────────────────
log "Test 4b: 不能改自己角色"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"role":"viewer"}' \
    "$API_BASE/api/projects/$PROJECT_ID/members/$ADMIN_USER_ID")
assert_eq "cannot change own role 400" "400" "$STATUS"

# ─── Test 4c: 改 admin 用户的角色到 admin → 200 ─────────────────────────
log "Test 4c: 改 admin 角色 (普通用户视角；走超管路径)"
STATUS=$(curl -sS -o /tmp/m1_patch.json -w "%{http_code}" \
    -X PATCH -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"role":"admin"}' \
    "$API_BASE/api/projects/$PROJECT_ID/members/$ADMIN_USER_ID")
case "$USER_ROLE" in
    owner|admin|superadmin)
        assert_eq "admin+ update role 200" "200" "$STATUS"
        ;;
    *)
        assert_eq "member/viewer update role 403" "403" "$STATUS"
        ;;
esac

# ─── Test 4d: 删除 admin（普通用户视角） → 200 ──────────────────────────
log "Test 4d: 删除 admin 用户"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X DELETE -H "Authorization: Bearer $USER_TOKEN" \
    "$API_BASE/api/projects/$PROJECT_ID/members/$ADMIN_USER_ID")
case "$USER_ROLE" in
    owner|admin|superadmin)
        assert_eq "admin+ delete member 200" "200" "$STATUS"
        ;;
    *)
        assert_eq "member/viewer delete member 403" "403" "$STATUS"
        ;;
esac

# ─── Test 5: 不能移除自己 → 400 ─────────────────────────────────────────
log "Test 5: 普通用户尝试移除自己"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X DELETE -H "Authorization: Bearer $USER_TOKEN" \
    "$API_BASE/api/projects/$PROJECT_ID/members/$USER_USER_ID")
case "$USER_ROLE" in
    owner|admin|superadmin)
        assert_eq "cannot remove self 400" "400" "$STATUS"
        ;;
    *)
        # member/viewer 先撞 403（require_tenant_admin）；自我护栏走不到
        assert_eq "non-admin remove self 403" "403" "$STATUS"
        ;;
esac

# ─── Test 6: 改自己角色（普通用户视角）→ 400 ────────────────────────────
log "Test 6: 普通用户尝试改自己角色"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"role":"viewer"}' \
    "$API_BASE/api/projects/$PROJECT_ID/members/$USER_USER_ID")
case "$USER_ROLE" in
    owner|admin|superadmin)
        assert_eq "cannot change own role 400" "400" "$STATUS"
        ;;
    *)
        assert_eq "non-admin self-patch 403" "403" "$STATUS"
        ;;
esac

# ─── Test 7: 加非法 role → 400 ─────────────────────────────────────────
log "Test 7: 加成员用非法 role 字符串"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":$ADMIN_USER_ID,\"role\":\"god-mode\"}" \
    "$API_BASE/api/projects/$PROJECT_ID/members")
assert_eq "invalid role 400" "400" "$STATUS"

# ─── Test 8: PATCH /api/projects/:id（超管改 name）→ 200 ──────────────
log "Test 8a: 超管 PATCH /api/projects/$PROJECT_ID name"
# 取当前 name 备份
ORIG_NAME=$(curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$API_BASE/api/projects/$PROJECT_ID" \
    | grep -oE '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
NEW_NAME="${ORIG_NAME}_w4_test"

STATUS=$(curl -sS -o /tmp/m1_patch_proj.json -w "%{http_code}" \
    -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$NEW_NAME\"}" \
    "$API_BASE/api/projects/$PROJECT_ID")
assert_eq "admin patch project name 200" "200" "$STATUS"

# 还原
curl -sS -o /dev/null \
    -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$ORIG_NAME\"}" \
    "$API_BASE/api/projects/$PROJECT_ID"

# ─── Test 8b: 普通用户改 name（owner 或非 owner）─────────────────────
log "Test 8b: 普通用户 PATCH /api/projects/$PROJECT_ID name (role=$USER_ROLE)"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$NEW_NAME\"}" \
    "$API_BASE/api/projects/$PROJECT_ID")
if [[ "$USER_ROLE" == "owner" || "$USER_ROLE" == "superadmin" ]]; then
    assert_eq "owner patch project 200" "200" "$STATUS"
    # 还原
    curl -sS -o /dev/null \
        -X PATCH -H "Authorization: Bearer $USER_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"$ORIG_NAME\"}" \
        "$API_BASE/api/projects/$PROJECT_ID"
else
    assert_eq "non-owner patch project 403" "403" "$STATUS"
fi

# ─── Test 8c: 试改禁止字段 slug → 400 ──────────────────────────────────
log "Test 8c: 改 slug 应被禁止"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"slug":"hacked"}' \
    "$API_BASE/api/projects/$PROJECT_ID")
assert_eq "patch slug rejected 400" "400" "$STATUS"

# ─── Test 8d: 空 body → 400 ─────────────────────────────────────────
log "Test 8d: PATCH 空 body"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' \
    "$API_BASE/api/projects/$PROJECT_ID")
assert_eq "patch empty body 400" "400" "$STATUS"

# ─── 总结 ─────────────────────────────────────────────────────────────
log "================================================"
log "PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
