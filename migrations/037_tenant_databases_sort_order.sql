-- 连接排序：为 tenant_databases 增加 sort_order 列，支持项目下手动调整连接顺序。

ALTER TABLE management.tenant_databases
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- 存量数据回填：同一租户内按 is_primary（默认连接靠前）、id 稳定排序生成初始顺序。
UPDATE management.tenant_databases td
SET sort_order = ranked.rn
FROM (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY tenant_id
               ORDER BY is_primary DESC, id ASC
           ) AS rn
    FROM management.tenant_databases
) ranked
WHERE td.id = ranked.id
  AND td.sort_order = 0;

CREATE INDEX IF NOT EXISTS idx_tenant_databases_sort_order
    ON management.tenant_databases(tenant_id, sort_order);
