-- ============================================
-- 定时任务：Shell 脚本任务（kind='shell'）
-- ============================================
-- 目的：在 scheduled_tasks 上叠加第三种任务类型，允许超管以"平台级"任务的形式
-- 触发宿主机命令 / 解释器脚本。出于安全权衡：
--
--   1. 只允许平台级（tenant_id IS NULL）。租户级 shell 任务等于把宿主机 shell 暴露给租户管理员，
--      不在威胁模型内 —— 通过 DB CHECK 强制（handler 还会再做一次 superadmin 校验，纵深防御）。
--   2. 仍受 timeout_secs / max_retries / overlap_policy 既有调度语义约束。
--   3. 沙盒（bwrap / nsjail）由 runner 侧 `SCHEDULER_SHELL_SANDBOX_MODE` 决定，不在 schema 里编码 —
--      schema 只关心"任务定义自身"，运行时安全策略是配置维度。
--
-- 列设计：
--   shell_interpreter : 解释器二进制名（沙盒内 PATH 解析）。NULL/空 → /bin/sh
--   shell_script      : 脚本内容（裸文本，传给 interpreter 的 stdin 等价 -c）。kind='shell' 时必填
--   shell_env         : 注入到子进程的环境变量（JSONB object，key=val 字符串），可选
--   shell_cwd         : 子进程工作目录，可选；默认 /tmp（沙盒内）

ALTER TABLE management.scheduled_tasks
    ADD COLUMN IF NOT EXISTS shell_interpreter VARCHAR(50),
    ADD COLUMN IF NOT EXISTS shell_script      TEXT,
    ADD COLUMN IF NOT EXISTS shell_env         JSONB,
    ADD COLUMN IF NOT EXISTS shell_cwd         TEXT;

-- 替换 kind 白名单约束（含 'shell'）。
ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_kind;
ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_kind CHECK (kind IN ('rpc', 'http', 'shell'));

-- kind='shell' 必须提供脚本内容（沙盒里 echo '' 没意义，强制非空）。
ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_kind_shell;
ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_kind_shell CHECK (
        kind <> 'shell' OR (shell_script IS NOT NULL AND length(trim(shell_script)) > 0)
    );

-- kind='shell' 强制平台级（tenant_id IS NULL）。这是威胁模型的 DB 层兜底 —
-- 即便 handler 校验被绕过或代码回归，PG 也会直接拒绝。
ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_shell_platform_only;
ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_shell_platform_only CHECK (
        kind <> 'shell' OR tenant_id IS NULL
    );

-- shell_env 必须是 JSON object（不是数组/标量），方便 executor 直接 iter K-V。
-- 用 jsonb_typeof 而不是 ts 端类型校验，是因为有人可能直接 INSERT 一条脏数据。
ALTER TABLE management.scheduled_tasks
    DROP CONSTRAINT IF EXISTS chk_st_shell_env_object;
ALTER TABLE management.scheduled_tasks
    ADD CONSTRAINT chk_st_shell_env_object CHECK (
        shell_env IS NULL OR jsonb_typeof(shell_env) = 'object'
    );
