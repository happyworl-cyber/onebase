-- ============================================================
-- M2 自助开通向导（Onboarding Wizard）
-- ============================================================
-- 新增两张元数据表：
--   pg_pools           - 超管维护的"可分配 PG 服务器池"，每条带 admin 凭据（加密）
--   project_templates  - 项目模板（v1 只 seed 4 条，其中 3 条 is_coming_soon）
--
-- 业务上：普通用户走 wizard 时，前端只能从 pg_pools 选一台（不允许自填
-- host/port），由后端用 admin 凭据在那台机器上 CREATE DATABASE，然后把
-- 新库挂到 tenants.tenant_databases。
--
-- 详见 docs/superpowers/plans/2026-05-19-m2-onboarding-wizard.md

-- ─── pg_pools ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS management.pg_pools (
    id                          SERIAL       PRIMARY KEY,
    name                        VARCHAR(100) NOT NULL UNIQUE,
    db_host                     VARCHAR(255) NOT NULL,
    db_port                     INTEGER      NOT NULL DEFAULT 5432,
    admin_user                  VARCHAR(100) NOT NULL,
    admin_password_encrypted    TEXT         NOT NULL,
    note                        TEXT,
    is_active                   BOOLEAN      NOT NULL DEFAULT true,
    created_at                  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pg_pools_active ON management.pg_pools(is_active);

DROP TRIGGER IF EXISTS update_pg_pools_updated_at ON management.pg_pools;
CREATE TRIGGER update_pg_pools_updated_at
    BEFORE UPDATE ON management.pg_pools
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();

COMMENT ON TABLE management.pg_pools IS
    'M2 自助开通：超管预先注册的 PG 服务器池。普通用户走 wizard 时只能从 is_active=true 的条目里选一台。';
COMMENT ON COLUMN management.pg_pools.admin_password_encrypted IS
    'AES-256-GCM 加密的 admin 密码；用 crate::crypto::encrypt_secret 写入，decrypt_secret 读出。';
COMMENT ON COLUMN management.pg_pools.note IS
    '运营备注，如"阿里云 RDS prod 共享池 / 容量 100 库"';

-- ─── project_templates ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS management.project_templates (
    id              SERIAL       PRIMARY KEY,
    slug            VARCHAR(50)  NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    scenario        VARCHAR(50)  NOT NULL DEFAULT '通用',
    ddl_sql         TEXT         NOT NULL DEFAULT '',
    is_coming_soon  BOOLEAN      NOT NULL DEFAULT false,
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    sort_order      INTEGER      NOT NULL DEFAULT 0,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_templates_active ON management.project_templates(is_active);

COMMENT ON TABLE management.project_templates IS
    'M2 自助开通：项目模板。v1 只有 blank 可用，其余 3 条 is_coming_soon=true 占位';
COMMENT ON COLUMN management.project_templates.ddl_sql IS
    '模板的 DDL SQL，在 provision 流程的最后一步执行在新建的项目库里。空字符串 = 不执行任何 DDL（如 blank 模板）。';
COMMENT ON COLUMN management.project_templates.is_coming_soon IS
    'true 时前端 wizard 列出但灰掉禁选；用于在 v1 阶段占位"敬请期待"。';

-- ─── seed 4 个模板（v1 只 blank 可选）──────────────────────────

INSERT INTO management.project_templates (slug, name, description, scenario, ddl_sql, is_coming_soon, sort_order)
VALUES
    ('blank',     '空白项目',  '不预置任何业务表，建好就是一个干净的 PG 数据库。适合自带 schema 设计或想用 ER 编辑器从头建表的场景。', '通用',     '', false, 10),
    ('blog',      '博客系统',  '内置 文章 / 评论 / 标签 / 作者 表（v1.x 即将推出）',                                                    '内容应用', '', true,  20),
    ('tasks',     '任务管理',  '内置 项目 / 任务 / 分配 / 评论 表（v1.x 即将推出）',                                                    '内部工具', '', true,  30),
    ('community', '社区论坛',  '内置 话题 / 回复 / 用户档案 / 标签 表（v1.x 即将推出）',                                               '内容应用', '', true,  40)
ON CONFLICT (slug) DO NOTHING;
