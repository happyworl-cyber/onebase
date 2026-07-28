#!/bin/bash
set -e

PGDATA="/var/lib/postgresql/15/main"
PG_BIN="/usr/lib/postgresql/15/bin"
PG_USER="${POSTGRES_USER:-onebase}"
PG_PASS="${POSTGRES_PASSWORD:-onebase123}"
PG_DB="${POSTGRES_DB:-onebase}"

echo "========================================="
echo "  OneBase All-in-One Container"
echo "========================================="

# ─── 1. 初始化 PostgreSQL（首次运行）───
if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "[1/5] 初始化 PostgreSQL 数据目录..."
    mkdir -p "$PGDATA"
    chown -R postgres:postgres "$PGDATA"
    su - postgres -c "$PG_BIN/initdb -D $PGDATA --encoding=UTF8 --locale=C"

    # 仅允许容器内部连接（127.0.0.1）使用密码认证
    echo "host all all 127.0.0.1/32 md5" >> "$PGDATA/pg_hba.conf"
    # 如果需要从宿主机访问 PG（调试），取消下面一行的注释：
    # echo "host all all 0.0.0.0/0 md5" >> "$PGDATA/pg_hba.conf"

    # 监听所有地址（supervisord 内部管理需要）
    sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" "$PGDATA/postgresql.conf"
else
    echo "[1/5] PostgreSQL 数据目录已存在，跳过初始化"
fi

# ─── 2. 启动 PostgreSQL（临时，用于迁移）───
echo "[2/5] 启动 PostgreSQL..."
su - postgres -c "$PG_BIN/pg_ctl -D $PGDATA -l /var/log/onebase/pg_init.log start -w -t 30"

# 等待就绪
for i in $(seq 1 30); do
    if su - postgres -c "$PG_BIN/pg_isready -q" 2>/dev/null; then
        break
    fi
    echo "  等待 PostgreSQL 就绪... ($i/30)"
    sleep 1
done

# 创建用户和数据库（幂等）
su - postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'\" | grep -q 1" || \
    su - postgres -c "psql -c \"CREATE USER $PG_USER WITH PASSWORD '$PG_PASS' SUPERUSER;\""

su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='$PG_DB'\" | grep -q 1" || \
    su - postgres -c "psql -c \"CREATE DATABASE $PG_DB OWNER $PG_USER;\""

export DATABASE_URL="postgresql://$PG_USER:$PG_PASS@127.0.0.1:5432/$PG_DB"

# ─── 3. 运行数据库迁移（统一入口）───
echo "[3/5] 运行数据库迁移..."

cd /app

# 通过 psql 顺序执行迁移文件，可正确处理 dollar-quoted 函数体与中文注释。
# `ON_ERROR_STOP=0` 下任何语句失败都不会阻断后续迁移；幂等语句已使用 IF NOT EXISTS。
for f in /app/migrations/001_create_users_table.sql \
         /app/migrations/003_create_management_schema.sql \
         /app/migrations/004_add_superadmin_role.sql \
         /app/migrations/005_rbac_tables.sql \
         /app/migrations/006_sso_providers.sql \
         /app/migrations/007_read_replicas.sql \
         /app/migrations/008_webhooks.sql \
         /app/migrations/009_audit_logs.sql \
         /app/migrations/010_gateway_config.sql \
         /app/migrations/011_seed_default_permissions.sql \
         /app/migrations/012_jwt_sessions.sql; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    echo "  -> 应用 $name"
    PGPASSWORD="$PG_PASS" psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" \
        -v ON_ERROR_STOP=0 -q -f "$f" >/var/log/onebase/migrate_${name}.log 2>&1 || \
        echo "     (部分语句可能已存在，已忽略)"
done

# 兼容旧表结构：补 role / is_superadmin 字段
PGPASSWORD="$PG_PASS" psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -q -c \
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user';" \
    -c "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN DEFAULT false;" \
    >/dev/null 2>&1 || true

# ─── 4. 种子数据 ───
echo "[4/5] 初始化种子数据..."
PGPASSWORD="$PG_PASS" psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -f /app/init_multitenant.sql 2>/dev/null || \
    echo "  -> 种子数据已存在，跳过"

# 确保超级管理员账号的密码有效（migrations/001 里的种子哈希不可用，统一用 create_admin 重置一次）
echo "  -> 确保 admin@example.com / Admin123 可用"
DATABASE_URL="$DATABASE_URL" /app/bin/create_admin >/var/log/onebase/create_admin.log 2>&1 || true

# ─── 4.5 历史密码迁移：把所有非 v2: 格式的连接密码升级为 v2 AES-256-GCM ───
# 仅在配置了 ENCRYPTION_KEY 时执行；失败不会阻断启动（仅日志告警）。
if [ -n "$ENCRYPTION_KEY" ]; then
    echo "  -> 升级历史 base64 密码到 v2 加密格式（migrate_passwords）"
    DATABASE_URL="$DATABASE_URL" ENCRYPTION_KEY="$ENCRYPTION_KEY" \
        /app/bin/migrate_passwords >/var/log/onebase/migrate_passwords.log 2>&1 || \
        echo "     (密码迁移失败，详见 /var/log/onebase/migrate_passwords.log)"
fi

# ─── 5. 停止临时 PostgreSQL（交给 supervisord 管理）───
echo "[5/5] 迁移完成，切换到 supervisord 管理进程..."
su - postgres -c "$PG_BIN/pg_ctl -D $PGDATA stop -w -t 10"

echo ""
echo "========================================="
echo "  启动所有服务..."
echo "  PostgreSQL :5432  (内部)"
echo "  Redis      :6379  (内部)"
echo "  Backend    :${PORT:-3000}"
echo "  Frontend   :3001"
echo "========================================="
echo ""

# 启动 supervisord（接管所有进程）
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/onebase.conf
