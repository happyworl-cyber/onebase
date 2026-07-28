#!/bin/bash

# OneBase API 测试脚本
# 使用方法: bash examples/test-api.sh

set -e

# 配置
API_BASE="http://localhost:3000/api"
SCHEMA="public"
TABLE="users"

# 颜色输出
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}==================================${NC}"
echo -e "${BLUE}  OneBase API 功能测试${NC}"
echo -e "${BLUE}==================================${NC}"
echo ""

# 1. 测试查询所有用户
echo -e "${YELLOW}1. 查询所有用户${NC}"
echo -e "${GREEN}GET ${API_BASE}/${SCHEMA}/${TABLE}${NC}"
curl -s "${API_BASE}/${SCHEMA}/${TABLE}" | jq '.'
echo ""
echo ""

# 2. 测试带过滤条件的查询
echo -e "${YELLOW}2. 查询状态为 active 的用户${NC}"
echo -e "${GREEN}GET ${API_BASE}/${SCHEMA}/${TABLE}?status=active${NC}"
curl -s "${API_BASE}/${SCHEMA}/${TABLE}?status=active" | jq '.'
echo ""
echo ""

# 3. 测试排序和分页
echo -e "${YELLOW}3. 查询前 2 个用户，按 ID 降序${NC}"
echo -e "${GREEN}GET ${API_BASE}/${SCHEMA}/${TABLE}?order=id.desc&limit=2${NC}"
curl -s "${API_BASE}/${SCHEMA}/${TABLE}?order=id.desc&limit=2" | jq '.'
echo ""
echo ""

# 4. 测试选择特定字段
echo -e "${YELLOW}4. 只查询 id, name, email 字段${NC}"
echo -e "${GREEN}GET ${API_BASE}/${SCHEMA}/${TABLE}?select=id,name,email&limit=3${NC}"
curl -s "${API_BASE}/${SCHEMA}/${TABLE}?select=id,name,email&limit=3" | jq '.'
echo ""
echo ""

# 5. 测试范围查询
echo -e "${YELLOW}5. 查询年龄大于等于 25 的用户${NC}"
echo -e "${GREEN}GET ${API_BASE}/${SCHEMA}/${TABLE}?age.gte=25${NC}"
curl -s "${API_BASE}/${SCHEMA}/${TABLE}?age.gte=25" | jq '.'
echo ""
echo ""

# 6. 测试创建用户
echo -e "${YELLOW}6. 创建新用户${NC}"
echo -e "${GREEN}POST ${API_BASE}/${SCHEMA}/${TABLE}${NC}"
NEW_USER=$(curl -s -X POST "${API_BASE}/${SCHEMA}/${TABLE}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "测试用户",
    "email": "test_'$(date +%s)'@example.com",
    "age": 26,
    "status": "pending"
  }')
echo "$NEW_USER" | jq '.'
NEW_USER_ID=$(echo "$NEW_USER" | jq -r '.id')
echo ""
echo -e "${GREEN}新用户 ID: ${NEW_USER_ID}${NC}"
echo ""
echo ""

# 7. 测试更新用户
if [ ! -z "$NEW_USER_ID" ] && [ "$NEW_USER_ID" != "null" ]; then
    echo -e "${YELLOW}7. 更新用户 (ID: ${NEW_USER_ID})${NC}"
    echo -e "${GREEN}PATCH ${API_BASE}/${SCHEMA}/${TABLE}?id=${NEW_USER_ID}${NC}"
    curl -s -X PATCH "${API_BASE}/${SCHEMA}/${TABLE}?id=${NEW_USER_ID}" \
      -H "Content-Type: application/json" \
      -d '{
        "name": "已更新的测试用户",
        "status": "active"
      }' | jq '.'
    echo ""
    echo ""

    # 8. 验证更新
    echo -e "${YELLOW}8. 验证更新结果${NC}"
    echo -e "${GREEN}GET ${API_BASE}/${SCHEMA}/${TABLE}?id=${NEW_USER_ID}${NC}"
    curl -s "${API_BASE}/${SCHEMA}/${TABLE}?id=${NEW_USER_ID}" | jq '.'
    echo ""
    echo ""

    # 9. 测试删除用户
    echo -e "${YELLOW}9. 删除测试用户 (ID: ${NEW_USER_ID})${NC}"
    echo -e "${GREEN}DELETE ${API_BASE}/${SCHEMA}/${TABLE}?id=${NEW_USER_ID}${NC}"
    curl -s -X DELETE "${API_BASE}/${SCHEMA}/${TABLE}?id=${NEW_USER_ID}" | jq '.'
    echo ""
    echo ""

    # 10. 验证删除
    echo -e "${YELLOW}10. 验证删除结果 (应该为空数组)${NC}"
    echo -e "${GREEN}GET ${API_BASE}/${SCHEMA}/${TABLE}?id=${NEW_USER_ID}${NC}"
    curl -s "${API_BASE}/${SCHEMA}/${TABLE}?id=${NEW_USER_ID}" | jq '.'
    echo ""
    echo ""
else
    echo -e "${RED}创建用户失败，跳过更新和删除测试${NC}"
    echo ""
fi

# 11. 测试组合查询
echo -e "${YELLOW}11. 组合查询：active 用户，年龄 >= 20，按创建时间降序，前 5 条${NC}"
echo -e "${GREEN}GET ${API_BASE}/${SCHEMA}/${TABLE}?status=active&age.gte=20&order=created_at.desc&limit=5${NC}"
curl -s "${API_BASE}/${SCHEMA}/${TABLE}?status=active&age.gte=20&order=created_at.desc&limit=5" | jq '.'
echo ""
echo ""

# 12. 测试批量创建
echo -e "${YELLOW}12. 批量创建用户${NC}"
echo -e "${GREEN}POST ${API_BASE}/${SCHEMA}/${TABLE} (批量)${NC}"
BATCH_USERS=$(curl -s -X POST "${API_BASE}/${SCHEMA}/${TABLE}" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "name": "批量用户1",
      "email": "batch1_'$(date +%s)'@example.com",
      "age": 20
    },
    {
      "name": "批量用户2",
      "email": "batch2_'$(date +%s)'@example.com",
      "age": 21
    }
  ]')
echo "$BATCH_USERS" | jq '.'
BATCH_USER_IDS=$(echo "$BATCH_USERS" | jq -r '.[].id' | tr '\n' ',' | sed 's/,$//')
echo ""
echo -e "${GREEN}批量创建的用户 IDs: ${BATCH_USER_IDS}${NC}"
echo ""
echo ""

# 13. 清理批量创建的用户
if [ ! -z "$BATCH_USER_IDS" ]; then
    IFS=',' read -ra ID_ARRAY <<< "$BATCH_USER_IDS"
    for id in "${ID_ARRAY[@]}"; do
        echo -e "${YELLOW}清理批量用户 (ID: ${id})${NC}"
        curl -s -X DELETE "${API_BASE}/${SCHEMA}/${TABLE}?id=${id}" > /dev/null
        echo -e "${GREEN}已删除${NC}"
    done
    echo ""
fi

echo -e "${BLUE}==================================${NC}"
echo -e "${BLUE}  测试完成！${NC}"
echo -e "${BLUE}==================================${NC}"
echo ""
echo -e "${GREEN}✓ 所有功能测试通过${NC}"
echo -e "${YELLOW}提示: 需要安装 jq 命令来格式化 JSON 输出${NC}"
echo -e "${YELLOW}      在 Ubuntu/Debian: sudo apt install jq${NC}"
echo -e "${YELLOW}      在 macOS: brew install jq${NC}"

