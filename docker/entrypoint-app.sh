#!/bin/bash
set -euo pipefail

mkdir -p /var/log/onebase

echo "========================================="
echo "  OneBase app image (API + Next.js)"
echo "  Backend :${PORT:-3000}   Frontend :3001"
echo "  数据库 / Redis 请使用外部服务，注入 DATABASE_URL / REDIS_URL"
echo "========================================="

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/onebase-app.conf
