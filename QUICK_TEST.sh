#!/bin/bash

# OneBase 快速测试脚本

echo "🧪 OneBase 管理后台快速测试"
echo "================================"
echo ""

BASE_URL="http://localhost:3000"

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 测试计数
PASSED=0
FAILED=0

# 测试函数
test_api() {
    local name=$1
    local cmd=$2
    local expected=$3
    
    echo -n "测试: $name ... "
    
    result=$(eval $cmd 2>&1)
    
    if [[ $result == *"$expected"* ]]; then
        echo -e "${GREEN}✓ 通过${NC}"
        ((PASSED++))
    else
        echo -e "${RED}✗ 失败${NC}"
        echo "  预期: $expected"
        echo "  实际: $result"
        ((FAILED++))
    fi
}

echo "1️⃣  测试服务器健康状态"
echo "---"
test_api "健康检查" "curl -s $BASE_URL/health" "healthy"
echo ""

echo "2️⃣  测试认证功能"
echo "---"

# 登录获取 token
echo -n "测试: 用户登录 ... "
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"Admin123"}')

if [[ $LOGIN_RESPONSE == *"token"* ]]; then
    echo -e "${GREEN}✓ 通过${NC}"
    ((PASSED++))
    TOKEN=$(echo $LOGIN_RESPONSE | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
    echo "  Token: ${TOKEN:0:20}..."
else
    echo -e "${RED}✗ 失败${NC}"
    echo "  响应: $LOGIN_RESPONSE"
    ((FAILED++))
fi
echo ""

echo "3️⃣  测试数据访问"
echo "---"
test_api "获取用户列表" "curl -s $BASE_URL/api/public/users | jq -r 'type'" "array"
echo ""

echo "4️⃣  测试管理后台"
echo "---"
echo -n "测试: 访问管理后台 ... "
ADMIN_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/admin/")

if [[ $ADMIN_RESPONSE == "200" ]]; then
    echo -e "${GREEN}✓ 通过${NC}"
    ((PASSED++))
else
    echo -e "${RED}✗ 失败${NC} (HTTP $ADMIN_RESPONSE)"
    ((FAILED++))
fi
echo ""

echo "================================"
echo "测试结果："
echo -e "  ${GREEN}通过: $PASSED${NC}"
echo -e "  ${RED}失败: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 所有测试通过！${NC}"
    echo ""
    echo "✅ 管理后台可以使用了！"
    echo "访问: $BASE_URL/admin/"
    echo ""
    echo "默认账号:"
    echo "  邮箱: admin@example.com"
    echo "  密码: Admin123"
    exit 0
else
    echo -e "${RED}❌ 部分测试失败${NC}"
    echo ""
    echo "请检查:"
    echo "  1. 服务器是否运行 (cargo run)"
    echo "  2. 数据库是否迁移 (migrations/001_create_users_table.sql)"
    echo "  3. admin/ 目录是否存在"
    exit 1
fi

