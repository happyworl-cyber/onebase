-- 历史数据修正：主连接 slug 误带 "-primary" 后缀。
--
-- 根因：旧版创建项目时 connection_name 写成了 '{slug}_primary'，
-- 迁移 026 回填 tenant_databases.slug 时把 connection_name 归一化
-- （'_' → '-'），于是主连接 slug 变成了 '{slug}-primary'，对外暴露在
-- /api/v1/{database_slug}/... 路由里很不友好。
--
-- 当前应用代码已修复（slug 列写入裸 slug），此处只清理历史行：
-- 去掉主连接 slug 的 "-primary" 后缀，且仅在去掉后不与同租户其它
-- slug 冲突时才更新（避免违反 idx_tenant_databases_tenant_slug 唯一约束）。
-- 幂等：再次执行时后缀已不存在，不会重复影响。

UPDATE management.tenant_databases td
SET slug = left(td.slug, length(td.slug) - length('-primary'))
WHERE td.is_primary = true
  AND td.slug LIKE '%-primary'
  AND length(td.slug) > length('-primary')
  AND NOT EXISTS (
      SELECT 1
      FROM management.tenant_databases other
      WHERE other.tenant_id = td.tenant_id
        AND other.id <> td.id
        AND other.slug = left(td.slug, length(td.slug) - length('-primary'))
  );
