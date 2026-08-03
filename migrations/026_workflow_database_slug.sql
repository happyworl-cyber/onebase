-- Workflow endpoint 可读化路由：
--   /workflow/{database_slug}/{workflow_slug}
--
-- 在 tenant_databases 上新增路由别名 slug（tenant 内唯一），用于替代对外暴露 database_id。

ALTER TABLE management.tenant_databases
ADD COLUMN IF NOT EXISTS slug VARCHAR(50);

-- 历史数据回填：
-- 1) connection_name 归一化为 slug（小写 + 非字母数字替换为 '-'）
-- 2) 空值兜底为 db-{id}
-- 3) 若同 tenant 下冲突，附加 "-{id}" 保证唯一
WITH normalized AS (
    SELECT
        id,
        tenant_id,
        COALESCE(
            NULLIF(
                trim(both '-' FROM regexp_replace(lower(connection_name), '[^a-z0-9]+', '-', 'g')),
                ''
            ),
            format('db-%s', id)
        ) AS base_slug
    FROM management.tenant_databases
),
dedup AS (
    SELECT
        id,
        tenant_id,
        base_slug,
        row_number() OVER (PARTITION BY tenant_id, base_slug ORDER BY id) AS rn
    FROM normalized
)
UPDATE management.tenant_databases td
SET slug = CASE
    WHEN d.rn = 1 THEN d.base_slug
    ELSE format('%s-%s', d.base_slug, td.id)
END
FROM dedup d
WHERE td.id = d.id
  AND (td.slug IS NULL OR td.slug = '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_databases_tenant_slug
ON management.tenant_databases(tenant_id, slug)
WHERE slug IS NOT NULL;
