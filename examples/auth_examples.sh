#!/bin/bash

# OneBase 认证 API 使用示例

BASE_URL="http://localhost:3000"

echo "=== OneBase 认证 API 测试 ==="
echo ""

# 1. 健康检查
echo "1. 健康检查"
curl -X GET "$BASE_URL/health"
echo ""
echo ""

# 2. 用户注册
echo "2. 用户注册"
REGISTER_RESPONSE=$(curl -X POST "$BASE_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "newuser",
    "email": "newuser@example.com",
    "password": "Password123"
  }')
echo $REGISTER_RESPONSE | jq '.'
echo ""

# 提取 token
TOKEN=$(echo $REGISTER_RESPONSE | jq -r '.token')
echo "Token: $TOKEN"
echo ""

# 3. 用户登录
echo "3. 用户登录"
LOGIN_RESPONSE=$(curl -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@example.com",
    "password": "Password123"
  }')
echo $LOGIN_RESPONSE | jq '.'
echo ""

# 更新 token
TOKEN=$(echo $LOGIN_RESPONSE | jq -r '.token')
echo "新 Token: $TOKEN"
echo ""

# 4. 获取当前用户信息
echo "4. 获取当前用户信息"
curl -X GET "$BASE_URL/auth/me" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""
echo ""

# 5. 刷新 Token
echo "5. 刷新 Token"
REFRESH_RESPONSE=$(curl -X POST "$BASE_URL/auth/refresh" \
  -H "Authorization: Bearer $TOKEN")
echo $REFRESH_RESPONSE | jq '.'
echo ""

# 6. 修改密码
echo "6. 修改密码"
curl -X POST "$BASE_URL/auth/change-password" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "old_password": "Password123",
    "new_password": "NewPassword456"
  }' | jq '.'
echo ""
echo ""

# 7. 用新密码登录
echo "7. 用新密码登录"
NEW_LOGIN_RESPONSE=$(curl -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@example.com",
    "password": "NewPassword456"
  }')
echo $NEW_LOGIN_RESPONSE | jq '.'
echo ""

# 8. 测试无效 Token
echo "8. 测试无效 Token"
curl -X GET "$BASE_URL/auth/me" \
  -H "Authorization: Bearer invalid_token_here"
echo ""
echo ""

# 9. 测试缺少 Token
echo "9. 测试缺少 Token"
curl -X GET "$BASE_URL/auth/me"
echo ""
echo ""

echo "=== 测试完成 ==="

