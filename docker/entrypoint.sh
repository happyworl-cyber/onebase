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

# ─── 0. 幂等写入 AIO Postgres 调优参数（每次启动，含已有数据目录）───
# 默认对齐 docs/superpowers/specs/2026-07-27-pg-crash-hardening-design.md
apply_aio_pg_conf() {
    local conf="$1"
    [ -f "$conf" ] || return 0

    local max_conn="${AIO_PG_MAX_CONNECTIONS:-120}"
    local shared_buffers="${AIO_PG_SHARED_BUFFERS:-256MB}"
    local work_mem="${AIO_PG_WORK_MEM:-4MB}"

    set_pg_conf_kv() {
        local key="$1"
        local val="$2"
        if grep -qE "^[#[:space:]]*${key}[[:space:]]*=" "$conf"; then
            # 覆盖已有（含注释掉的）同名配置行，只保留一行生效值
            sed -i -E "s|^[#[:space:]]*${key}[[:space:]]*=.*|${key} = ${val}|" "$conf"
        else
            echo "${key} = ${val}" >> "$conf"
        fi
    }

    set_pg_conf_kv "listen_addresses" "'*'"
    set_pg_conf_kv "max_connections" "$max_conn"
    set_pg_conf_kv "shared_buffers" "$shared_buffers"
    set_pg_conf_kv "work_mem" "$work_mem"
    echo "[0/5] 已应用 AIO PG 调优: max_connections=${max_conn}, shared_buffers=${shared_buffers}, work_mem=${work_mem}"
}

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
else
    echo "[1/5] PostgreSQL 数据目录已存在，跳过初始化"
fi

# 无论首次还是已有 volume，都幂等写入 listen_addresses + 调优参数
apply_aio_pg_conf "$PGDATA/postgresql.conf"

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
# 主进程 supervisord 会读 AUTO_MIGRATE；缺省 on（与 app 镜像一致）
export AUTO_MIGRATE="${AUTO_MIGRATE:-on}"

# ─── 3. 运行数据库迁移（统一入口）───
echo "[3/5] 运行数据库迁移 (AUTO_MIGRATE=${AUTO_MIGRATE})..."

cd /app

# 与主进程 AUTO_MIGRATE / `cargo run --bin migrate_all` 共用同一序列（src/migrate.rs）。
# 不要再手写 001..012 的 psql 列表——会漏掉后续 migration（如 054 dependencies）。
if [ -x /app/bin/migrate_all ]; then
    echo "  -> /app/bin/migrate_all"
    if DATABASE_URL="$DATABASE_URL" /app/bin/migrate_all \
        >/var/log/onebase/migrate_all.log 2>&1; then
        echo "  -> migrate_all 完成"
    else
        echo "  !! migrate_all 失败，详见 /var/log/onebase/migrate_all.log（继续启动，主进程 AUTO_MIGRATE 会再试）"
        tail -n 40 /var/log/onebase/migrate_all.log || true
    fi
else
    echo "  !! /app/bin/migrate_all 不存在，跳过入口迁移（依赖主进程 AUTO_MIGRATE）"
fi

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
