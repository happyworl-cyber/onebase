-- 074: 列表「更新时间」应对齐定义修改（保存草稿 / 发布），不要被任意 UPDATE 带跑。
-- 旧触发器 BEFORE UPDATE 无条件 NEW.updated_at = NOW()：073 回填 updated_by、启停、
-- 告警节流、文档分享、published_version 指针都会把时间改成「刚才」，与版本历史对不上。
--
-- 本仓库迁移每次启动整表重跑，回填必须只在触发器还在时做一次，否则会反复覆盖
-- 之后合法的 updated_at（例如列表里挪分类）。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'management'
       AND c.relname = 'workflows'
       AND t.tgname = 'trigger_workflows_updated_at'
       AND NOT t.tgisinternal
  ) THEN
    UPDATE management.workflows w
    SET updated_at = GREATEST(
      w.created_at,
      COALESCE(
        (SELECT MAX(v.created_at) FROM management.workflow_versions v WHERE v.workflow_id = w.id),
        w.created_at
      ),
      COALESCE(
        (SELECT d.updated_at FROM management.workflow_drafts d WHERE d.workflow_id = w.id),
        w.created_at
      )
    );
  END IF;
END $$;

DROP TRIGGER IF EXISTS trigger_workflows_updated_at ON management.workflows;
DROP FUNCTION IF EXISTS management.update_workflows_updated_at();
