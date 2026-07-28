#!/bin/bash

# OneBase 事务 API 使用示例

BASE_URL="http://localhost:3000"

echo "=== OneBase 事务 API 测试 ==="
echo ""

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. 简单事务：插入一个用户
echo -e "${YELLOW}1. 简单事务：插入一个用户${NC}"
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "method": "POST",
        "schema": "public",
        "table": "users",
        "data": {
          "username": "txuser1",
          "email": "txuser1@example.com",
          "password_hash": "$2b$12$test",
          "role": "user"
        }
      }
    ]
  }' | jq '.'
echo ""
echo ""

# 2. 批量插入：一次插入多个用户
echo -e "${YELLOW}2. 批量插入：一次插入多个用户${NC}"
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "method": "POST",
        "schema": "public",
        "table": "users",
        "data": {
          "username": "txuser2",
          "email": "txuser2@example.com",
          "password_hash": "$2b$12$test",
          "role": "user"
        }
      },
      {
        "method": "POST",
        "schema": "public",
        "table": "users",
        "data": {
          "username": "txuser3",
          "email": "txuser3@example.com",
          "password_hash": "$2b$12$test",
          "role": "user"
        }
      },
      {
        "method": "POST",
        "schema": "public",
        "table": "users",
        "data": {
          "username": "txuser4",
          "email": "txuser4@example.com",
          "password_hash": "$2b$12$test",
          "role": "user"
        }
      }
    ]
  }' | jq '.'
echo ""
echo ""

# 3. 混合操作：插入 + 更新
echo -e "${YELLOW}3. 混合操作：插入新用户并更新现有用户${NC}"
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "method": "POST",
        "schema": "public",
        "table": "users",
        "data": {
          "username": "txuser5",
          "email": "txuser5@example.com",
          "password_hash": "$2b$12$test",
          "role": "user"
        }
      },
      {
        "method": "PATCH",
        "schema": "public",
        "table": "users",
        "where": {"email": "txuser1@example.com"},
        "data": {"role": "admin"}
      }
    ]
  }' | jq '.'
echo ""
echo ""

# 4. 复杂事务：创建、更新、删除
echo -e "${YELLOW}4. 复杂事务：创建、更新、删除${NC}"
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "method": "POST",
        "schema": "public",
        "table": "users",
        "data": {
          "username": "tempuser",
          "email": "temp@example.com",
          "password_hash": "$2b$12$test",
          "role": "user"
        }
      },
      {
        "method": "PATCH",
        "schema": "public",
        "table": "users",
        "where": {"email": "temp@example.com"},
        "data": {"role": "guest"}
      },
      {
        "method": "DELETE",
        "schema": "public",
        "table": "users",
        "where": {"email": "temp@example.com"}
      }
    ]
  }' | jq '.'
echo ""
echo ""

# 5. 测试事务回滚（故意制造错误）
echo -e "${YELLOW}5. 测试事务回滚（预期失败）${NC}"
echo "尝试插入重复邮箱，事务应该完全回滚..."
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "method": "POST",
        "schema": "public",
        "table": "users",
        "data": {
          "username": "gooduser",
          "email": "good@example.com",
          "password_hash": "$2b$12$test",
          "role": "user"
        }
      },
      {
        "method": "POST",
        "schema": "public",
        "table": "users",
        "data": {
          "username": "duplicate",
          "email": "txuser1@example.com",
          "password_hash": "$2b$12$test",
          "role": "user"
        }
      }
    ]
  }' | jq '.'
echo ""
echo "验证：gooduser 应该不存在（事务已回滚）"
curl -X GET "$BASE_URL/api/public/users?email=eq.good@example.com" | jq '.'
echo ""
echo ""

# 6. 批量更新
echo -e "${YELLOW}6. 批量更新：更新所有测试用户的角色${NC}"
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {
        "method": "PATCH",
        "schema": "public",
        "table": "users",
        "where": {"email": "txuser2@example.com"},
        "data": {"role": "moderator"}
      },
      {
        "method": "PATCH",
        "schema": "public",
        "table": "users",
        "where": {"email": "txuser3@example.com"},
        "data": {"role": "moderator"}
      }
    ]
  }' | jq '.'
echo ""
echo ""

# 7. 性能测试：大批量插入
echo -e "${YELLOW}7. 性能测试：插入 10 个用户${NC}"
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {"method": "POST", "schema": "public", "table": "users", "data": {"username": "perf1", "email": "perf1@example.com", "password_hash": "$2b$12$test", "role": "user"}},
      {"method": "POST", "schema": "public", "table": "users", "data": {"username": "perf2", "email": "perf2@example.com", "password_hash": "$2b$12$test", "role": "user"}},
      {"method": "POST", "schema": "public", "table": "users", "data": {"username": "perf3", "email": "perf3@example.com", "password_hash": "$2b$12$test", "role": "user"}},
      {"method": "POST", "schema": "public", "table": "users", "data": {"username": "perf4", "email": "perf4@example.com", "password_hash": "$2b$12$test", "role": "user"}},
      {"method": "POST", "schema": "public", "table": "users", "data": {"username": "perf5", "email": "perf5@example.com", "password_hash": "$2b$12$test", "role": "user"}},
      {"method": "POST", "schema": "public", "table": "users", "data": {"username": "perf6", "email": "perf6@example.com", "password_hash": "$2b$12$test", "role": "user"}},
      {"method": "POST", "schema": "public", "table": "users", "data": {"username": "perf7", "email": "perf7@example.com", "password_hash": "$2b$12$test", "role": "user"}},
      {"method": "POST", "schema": "public", "table": "users", "data": {"username": "perf8", "email": "perf8@example.com", "password_hash": "$2b$12$test", "role": "user"}},
      {"method": "POST", "schema": "public", "table": "users", "data": {"username": "perf9", "email": "perf9@example.com", "password_hash": "$2b$12$test", "role": "user"}},
      {"method": "POST", "schema": "public", "table": "users", "data": {"username": "perf10", "email": "perf10@example.com", "password_hash": "$2b$12$test", "role": "user"}}
    ]
  }' | jq '. | {success_count, elapsed_ms}'
echo ""
echo ""

# 8. 清理：删除所有测试数据
echo -e "${YELLOW}8. 清理：删除所有测试用户${NC}"
curl -X POST "$BASE_URL/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "txuser1"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "txuser2"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "txuser3"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "txuser4"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "txuser5"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "perf1"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "perf2"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "perf3"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "perf4"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "perf5"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "perf6"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "perf7"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "perf8"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "perf9"}},
      {"method": "DELETE", "schema": "public", "table": "users", "where": {"username": "perf10"}}
    ]
  }' | jq '. | {success_count, elapsed_ms}'
echo ""
echo ""

echo -e "${GREEN}=== 测试完成 ===${NC}"
echo ""
echo "事务特性："
echo "✅ 原子性：所有操作要么全部成功，要么全部失败"
echo "✅ 一致性：数据库始终保持一致状态"
echo "✅ 隔离性：并发事务互不干扰"
echo "✅ 持久性：提交后的更改永久保存"

