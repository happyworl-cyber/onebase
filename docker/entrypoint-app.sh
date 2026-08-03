#!/bin/bash
set -euo pipefail

mkdir -p /var/log/onebase

# 测试/预发默认开启动期自动迁移；显式 off 时才关闭（与 config.rs 语义一致）。
export AUTO_MIGRATE="${AUTO_MIGRATE:-on}"

echo "========================================="
echo "  OneBase app image (API + Next.js)"
echo "  Backend :${PORT:-3000}   Frontend :3001"
echo "  AUTO_MIGRATE=${AUTO_MIGRATE}"
echo "  数据库 / Redis 请使用外部服务，注入 DATABASE_URL / REDIS_URL"
echo "========================================="

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/onebase-app.conf
