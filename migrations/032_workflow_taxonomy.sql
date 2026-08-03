-- 工作流 taxonomy：部门（department）+ 分类（category）
--
-- 层级：全部 → 部门（含「共享」）→ 分类 → 工作流
-- workflow_folders 仅存空文件夹占位；有工作流的节点从 workflows 字段推导。

-- 1) 列
ALTER TABLE management.workflows
    ADD COLUMN IF NOT EXISTS department VARCHAR(64);

ALTER TABLE management.workflows
    ALTER COLUMN category TYPE VARCHAR(128);

ALTER TABLE management.workflow_versions
    ADD COLUMN IF NOT EXISTS department VARCHAR(64);

ALTER TABLE management.workflow_versions
    ALTER COLUMN category TYPE VARCHAR(128);

-- 2) 从旧 category 回填（幂等：仅 department 仍为空的行）
--    「部门/分类」→ 拆分；单段名称 → 共享部门下的分类
UPDATE management.workflows
SET
    department = NULLIF(trim(split_part(category, '/', 1)), ''),
    category = NULLIF(trim(split_part(category, '/', 2)), '')
WHERE department IS NULL
  AND category IS NOT NULL
  AND trim(category) <> ''
  AND position('/' in category) > 0;

UPDATE management.workflows
SET
    department = '共享',
    category = trim(category)
WHERE department IS NULL
  AND category IS NOT NULL
  AND trim(category) <> ''
  AND position('/' in category) = 0;

UPDATE management.workflow_versions
SET
    department = NULLIF(trim(split_part(category, '/', 1)), ''),
    category = NULLIF(trim(split_part(category, '/', 2)), '')
WHERE department IS NULL
  AND category IS NOT NULL
  AND trim(category) <> ''
  AND position('/' in category) > 0;

UPDATE management.workflow_versions
SET
    department = '共享',
    category = trim(category)
WHERE department IS NULL
  AND category IS NOT NULL
  AND trim(category) <> ''
  AND position('/' in category) = 0;

-- 3) 索引
DROP INDEX IF EXISTS management.idx_workflows_taxonomy;

CREATE INDEX IF NOT EXISTS idx_workflows_taxonomy
    ON management.workflows (database_id, department, category);

-- 4) 空文件夹表（parent_id IS NULL = 部门，否则 = 分类）
CREATE TABLE IF NOT EXISTS management.workflow_folders (
    id          SERIAL PRIMARY KEY,
    database_id INTEGER NOT NULL REFERENCES management.tenant_databases(id) ON DELETE CASCADE,
    parent_id   INTEGER REFERENCES management.workflow_folders(id) ON DELETE CASCADE,
    name        VARCHAR(64) NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_shared   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT workflow_folders_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id)
);

ALTER TABLE management.workflow_folders
    ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_folders_unique_name
    ON management.workflow_folders (database_id, COALESCE(parent_id, 0), name);

CREATE INDEX IF NOT EXISTS idx_workflow_folders_database
    ON management.workflow_folders (database_id, parent_id);

UPDATE management.workflow_folders
SET is_shared = true
WHERE parent_id IS NULL AND name = '共享';

INSERT INTO management.workflow_folders (database_id, parent_id, name, is_shared, sort_order)
SELECT DISTINCT w.database_id, NULL::integer, '共享', true, -100
FROM management.workflows w
WHERE w.database_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM management.workflow_folders f
    WHERE f.database_id = w.database_id
      AND f.parent_id IS NULL
      AND f.name = '共享'
  );

-- 双空 → 共享 / 未分类；任意部门下 category 为空 → 未分类
UPDATE management.workflows
SET department = '共享',
    category = '未分类'
WHERE department IS NULL
  AND (category IS NULL OR trim(category) = '');

UPDATE management.workflows
SET category = '未分类'
WHERE department IS NOT NULL
  AND (category IS NULL OR trim(category) = '');

UPDATE management.workflow_versions
SET department = '共享',
    category = '未分类'
WHERE department IS NULL
  AND (category IS NULL OR trim(category) = '');

UPDATE management.workflow_versions
SET category = '未分类'
WHERE department IS NOT NULL
  AND (category IS NULL OR trim(category) = '');

INSERT INTO management.workflow_folders (database_id, parent_id, name, sort_order)
SELECT f.database_id, f.id, '未分类', -99
FROM management.workflow_folders f
WHERE f.parent_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM management.workflow_folders c
    WHERE c.database_id = f.database_id
      AND c.parent_id = f.id
      AND c.name = '未分类'
  );
