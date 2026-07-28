-- ============================================
-- 定时任务 Shell 类型：放开到租户级
-- ============================================
-- 015 里给 shell 任务加的 `chk_st_shell_platform_only`（强制 tenant_id IS NULL）
-- 是早期保守做法 —— 当时把 shell 任务只交给平台超管，规避"租户管理员 RCE 宿主机"
-- 的口子。
--
-- 现在的诉求是允许在具体项目（租户）内也建 shell 任务，方便项目维护方接管自己
-- 的定时脚本。安全边界没变 —— 仍然有：
--   1. bwrap / nsjail 沙盒（运行时强制）
--   2. 解释器白名单（sh/bash/dash/zsh/python3/node/ruby）
--   3. env_clear + 注入白名单 ENV（不泄露 onebase 自身的 secret）
--   4. kill_on_drop + 超时
--   5. handler 层 `validate_can_manage`：租户级仍只允许该租户 owner/admin
--
-- 所以这里只是把 DB 层这道额外的 tenant_id 限制摘掉；handler/sandbox 仍然守门。
--
-- 幂等：若约束不存在（新部署或迁移已执行过）直接 no-op。
ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_shell_platform_only;
