-- 工作流搜索优化：为 name/slug/description 建立 pg_trgm GIN 索引，
-- 让 ILIKE '%kw%' 子串搜索走索引，避免全表顺序扫描（工作流量大时的搜索/分页 count 提速）。
-- 逐语句执行、幂等；pg_trgm 为 PostgreSQL 标准 contrib 扩展。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_workflows_name_trgm
    ON management.workflows USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_workflows_slug_trgm
    ON management.workflows USING gin (slug gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_workflows_description_trgm
    ON management.workflows USING gin (description gin_trgm_ops);
