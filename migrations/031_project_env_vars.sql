-- 项目级环境变量表
--
-- 前端「项目」= 后端 management.tenants，作用域键为 tenant_id。
-- 变量值以 crypto::encrypt_secret（AES-256-GCM）密文形式存储，明文仅在
-- handler 解密后回显 / 工作流执行期一次性装入 ExecutionContext。
--
-- 未来若需环境维度（dev/prod），加 environment 列并改组合唯一键即可。
CREATE TABLE IF NOT EXISTS management.project_env_vars (
    id SERIAL PRIMARY KEY,
    -- 所属项目（租户）；项目删除时级联清理其全部环境变量
    tenant_id INTEGER NOT NULL REFERENCES management.tenants(id) ON DELETE CASCADE,
    -- 变量名：^[A-Za-z_][A-Za-z0-9_]*$（在 handler 层校验）
    name VARCHAR(255) NOT NULL,
    -- crypto::encrypt_secret 产出的密文（v2:base64...）
    value_encrypted TEXT NOT NULL,
    -- 用途描述（可空）
    description TEXT,
    -- 审计：创建 / 最后修改人（users.id，弱引用不加外键，避免删用户阻塞）
    created_by INTEGER,
    updated_by INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    -- 同一项目内变量名唯一
    UNIQUE(tenant_id, name)
);

-- 按项目查全部变量（WHERE tenant_id ORDER BY name）由 UNIQUE(tenant_id, name)
-- 自带的复合索引最左前缀覆盖，无需额外单列索引。

-- updated_at 由全库统一触发器维护（与 pg_pools / webhooks / rbac 等表同一约定），
-- 避免依赖各代码路径手写 NOW() 兜底。函数定义见 003_create_management_schema.sql。
DROP TRIGGER IF EXISTS update_project_env_vars_updated_at ON management.project_env_vars;
CREATE TRIGGER update_project_env_vars_updated_at
    BEFORE UPDATE ON management.project_env_vars
    FOR EACH ROW EXECUTE FUNCTION management.update_updated_at_column();
