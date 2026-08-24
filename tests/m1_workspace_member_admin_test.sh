#!/usr/bin/env bash
# Project-scoped member account administration end-to-end tests.
#
# Usage:
#   ./tests/m1_workspace_member_admin_test.sh
#   API_BASE=http://127.0.0.1:3010 ./tests/m1_workspace_member_admin_test.sh
#
# The script creates a disposable project member, always attempts to reactivate
# it on exit, and removes its project membership after the assertions finish.

set -u

API_BASE="${API_BASE:-http://127.0.0.1:3010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin123}"

PASS=0
FAIL=0
SKIP=0
DISPOSABLE_USER_ID=""
PROJECT_ID=""
ADMIN_TOKEN=""
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/m1-member-admin.XXXXXX")

log() { echo "[$(date +%H:%M:%S)] $*"; }
assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        PASS=$((PASS + 1))
        log "  PASS  $name (= $actual)"
    else
        FAIL=$((FAIL + 1))
        log "  FAIL  $name (expected $expected, got $actual)"
    fi
}
assert_file_contains() {
    local name="$1" pattern="$2" file="$3"
    if grep -q "$pattern" "$file"; then
        PASS=$((PASS + 1))
        log "  PASS  $name"
    else
        FAIL=$((FAIL + 1))
        log "  FAIL  $name (pattern '$pattern' not found)"
    fi
}

login_token() {
    curl -sS -X POST "$API_BASE/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
        | grep -oE '"token":"[^"]+"' | head -1 | cut -d'"' -f4
}

cleanup() {
    local status
    if [[ -n "$DISPOSABLE_USER_ID" && -n "$PROJECT_ID" && -n "$ADMIN_TOKEN" ]]; then
        status=$(curl -sS -o /dev/null -w "%{http_code}" \
            -X PATCH \
            -H "Authorization: Bearer $ADMIN_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"is_active":true}' \
            "$API_BASE/api/projects/$PROJECT_ID/members/$DISPOSABLE_USER_ID/status" 2>/dev/null || true)
        if [[ "$status" == "200" ]]; then
            log "Cleanup: disposable user reactivated"
            status=$(curl -sS -o /dev/null -w "%{http_code}" \
                -X DELETE \
                -H "Authorization: Bearer $ADMIN_TOKEN" \
                "$API_BASE/api/projects/$PROJECT_ID/members/$DISPOSABLE_USER_ID" 2>/dev/null || true)
            [[ "$status" == "200" ]] \
                && log "Cleanup: disposable project membership removed" \
                || log "Cleanup warning: membership removal returned ${status:-curl-error}"
        else
            log "Cleanup warning: reactivation returned ${status:-curl-error}; membership retained"
        fi
    fi
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if ! curl -sS --connect-timeout 2 -o /dev/null "$API_BASE/" 2>/dev/null; then
    log "SKIP: API is not reachable at $API_BASE"
    SKIP=$((SKIP + 1))
    log "PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
    exit 0
fi

log "Login as platform admin ($ADMIN_EMAIL)"
ADMIN_TOKEN=$(login_token "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
if [[ -z "$ADMIN_TOKEN" ]]; then
    log "FATAL: admin login failed"
    exit 2
fi

PROJECTS=$(curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/api/projects")
PROJECT_ID=$(echo "$PROJECTS" | grep -oE '"id":[0-9]+' | head -1 | cut -d':' -f2)
if [[ -z "$PROJECT_ID" ]]; then
    log "FATAL: admin cannot access any project"
    exit 2
fi

ADMIN_USER_ID=$(curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/auth/me" \
    | grep -oE '"id":[0-9]+' | head -1 | cut -d':' -f2)
if [[ -z "$ADMIN_USER_ID" ]]; then
    log "FATAL: could not determine admin user id"
    exit 2
fi

SUFFIX="$(date +%s)$$"
ORIGINAL_USERNAME="e2e_member_$SUFFIX"
UPDATED_USERNAME="${ORIGINAL_USERNAME}_renamed"
DISPOSABLE_EMAIL="${ORIGINAL_USERNAME}@example.test"
ORIGINAL_PASSWORD="TempPass1A"
NEW_PASSWORD="ResetPass2B"

log "Create disposable member in project $PROJECT_ID"
STATUS=$(curl -sS -o "$TMP_DIR/create.json" -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$ORIGINAL_USERNAME\",\"email\":\"$DISPOSABLE_EMAIL\",\"password\":\"$ORIGINAL_PASSWORD\",\"role\":\"member\"}" \
    "$API_BASE/api/projects/$PROJECT_ID/members/create-user")
assert_eq "create disposable member" "200" "$STATUS"
DISPOSABLE_USER_ID=$(grep -oE '"user_id":[0-9]+' "$TMP_DIR/create.json" | head -1 | cut -d':' -f2)
if [[ -z "$DISPOSABLE_USER_ID" ]]; then
    log "FATAL: create-user response did not contain user_id"
    exit 2
fi

log "Test profile authorization"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH -H "Content-Type: application/json" \
    -d '{"username":"unauthorized_name"}' \
    "$API_BASE/api/projects/$PROJECT_ID/members/$DISPOSABLE_USER_ID/profile")
assert_eq "profile without token" "401" "$STATUS"

DISPOSABLE_TOKEN=$(login_token "$DISPOSABLE_EMAIL" "$ORIGINAL_PASSWORD")
if [[ -z "$DISPOSABLE_TOKEN" ]]; then
    log "FATAL: disposable user login failed"
    exit 2
fi
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH \
    -H "Authorization: Bearer $DISPOSABLE_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"username":"unauthorized_name"}' \
    "$API_BASE/api/projects/$PROJECT_ID/members/$DISPOSABLE_USER_ID/profile")
assert_eq "non-admin cannot patch profile" "403" "$STATUS"

STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin_self_rename"}' \
    "$API_BASE/api/projects/$PROJECT_ID/members/$ADMIN_USER_ID/profile")
assert_eq "admin cannot patch own profile" "403" "$STATUS"

log "Test profile update and restore"
STATUS=$(curl -sS -o "$TMP_DIR/profile.json" -w "%{http_code}" \
    -X PATCH \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$UPDATED_USERNAME\"}" \
    "$API_BASE/api/projects/$PROJECT_ID/members/$DISPOSABLE_USER_ID/profile")
assert_eq "admin patches member username" "200" "$STATUS"
assert_file_contains "profile response contains new username" \
    "\"username\":\"$UPDATED_USERNAME\"" "$TMP_DIR/profile.json"

STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$ORIGINAL_USERNAME\"}" \
    "$API_BASE/api/projects/$PROJECT_ID/members/$DISPOSABLE_USER_ID/profile")
assert_eq "restore member username" "200" "$STATUS"

log "Test list includes account status"
STATUS=$(curl -sS -o "$TMP_DIR/members.json" -w "%{http_code}" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$API_BASE/api/projects/$PROJECT_ID/members")
assert_eq "list members" "200" "$STATUS"
assert_file_contains "member list includes is_active" '"is_active":' "$TMP_DIR/members.json"

log "Test password reset and session revocation"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"new_password":"weak"}' \
    "$API_BASE/api/projects/$PROJECT_ID/members/$DISPOSABLE_USER_ID/reset-password")
assert_eq "reject weak password" "400" "$STATUS"

STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"new_password\":\"$NEW_PASSWORD\"}" \
    "$API_BASE/api/projects/$PROJECT_ID/members/$DISPOSABLE_USER_ID/reset-password")
assert_eq "accept strong password" "200" "$STATUS"

STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $DISPOSABLE_TOKEN" \
    "$API_BASE/auth/me")
assert_eq "old token revoked after reset" "401" "$STATUS"

DISPOSABLE_TOKEN=$(login_token "$DISPOSABLE_EMAIL" "$NEW_PASSWORD")
if [[ -z "$DISPOSABLE_TOKEN" ]]; then
    log "FATAL: login with reset password failed"
    exit 2
fi

log "Test deactivate and reactivate"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"is_active":false}' \
    "$API_BASE/api/projects/$PROJECT_ID/members/$DISPOSABLE_USER_ID/status")
assert_eq "deactivate member" "200" "$STATUS"

STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$DISPOSABLE_EMAIL\",\"password\":\"$NEW_PASSWORD\"}" \
    "$API_BASE/auth/login")
assert_eq "inactive login forbidden" "403" "$STATUS"

STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"is_active":true}' \
    "$API_BASE/api/projects/$PROJECT_ID/members/$DISPOSABLE_USER_ID/status")
assert_eq "reactivate member" "200" "$STATUS"

REACTIVATED_TOKEN=$(login_token "$DISPOSABLE_EMAIL" "$NEW_PASSWORD")
if [[ -n "$REACTIVATED_TOKEN" ]]; then
    PASS=$((PASS + 1))
    log "  PASS  reactivated member can login"
else
    FAIL=$((FAIL + 1))
    log "  FAIL  reactivated member can login"
fi

log "================================================"
log "PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
