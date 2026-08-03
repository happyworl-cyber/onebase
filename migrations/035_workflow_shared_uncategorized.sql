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
