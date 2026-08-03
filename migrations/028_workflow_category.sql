-- 工作流分类（category）：用于在工作流数量增多后做分组/筛选管理。
--
-- 单字段自由文本（前端配合已有分类自动补全），不单独建分类表，保持灵活、改动最小。
-- 备注沿用已有的 description 字段，无需新增列。

ALTER TABLE management.workflows
ADD COLUMN IF NOT EXISTS category VARCHAR(64);

-- 按库 + 分类建索引，支撑列表按分类筛选。
CREATE INDEX IF NOT EXISTS idx_workflows_category
ON management.workflows(database_id, category);
