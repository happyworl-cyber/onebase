use sqlx::PgPool;
use std::env;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv::dotenv().ok();

    let database_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/onebase".to_string());

    println!("⚙️  OneBase Workflow DAG 引擎迁移");
    println!("连接数据库: {}...", &database_url[..database_url.find('@').unwrap_or(20)]);

    let pool = PgPool::connect(&database_url).await?;

    sqlx::query("CREATE SCHEMA IF NOT EXISTS management")
        .execute(&pool)
        .await?;

    // ===== 如果旧表存在则先备份重命名 =====
    let old_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'management' AND table_name = 'workflows')"
    )
    .fetch_one(&pool)
    .await?;

    if old_exists {
        // 检查是否已有 nodes 列（新表）
        let has_nodes: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = 'management' AND table_name = 'workflows' AND column_name = 'nodes')"
        )
        .fetch_one(&pool)
        .await?;

        if !has_nodes {
            println!("  检测到旧版 workflows 表（线性 steps 模型），重命名为 workflows_v1_backup...");
            sqlx::query("ALTER TABLE management.workflows RENAME TO workflows_v1_backup")
                .execute(&pool)
                .await?;
            // 旧版 workflow_runs 也一起备份
            let old_runs: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = 'management' AND table_name = 'workflow_runs')"
            )
            .fetch_one(&pool)
            .await?;
            if old_runs {
                sqlx::query("ALTER TABLE management.workflow_runs RENAME TO workflow_runs_v1_backup")
                    .execute(&pool)
                    .await?;
            }
            println!("  ✅ 旧表已备份");
        } else {
            println!("  workflows 表已是 DAG 版本，跳过创建");
            println!("✅ 迁移完成（无变更）");
            return Ok(());
        }
    }

    // ===== 新版 workflows 表（DAG 模型） =====
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS management.workflows (
            id SERIAL PRIMARY KEY,
            tenant_id INTEGER REFERENCES management.tenants(id) ON DELETE CASCADE,
            database_id INTEGER,
            name VARCHAR(200) NOT NULL,
            slug VARCHAR(64) NOT NULL,
            description TEXT,
            trigger_type VARCHAR(20) NOT NULL DEFAULT 'endpoint',
            trigger_config JSONB NOT NULL DEFAULT '{}',
            nodes JSONB NOT NULL DEFAULT '[]',
            edges JSONB NOT NULL DEFAULT '[]',
            is_enabled BOOLEAN NOT NULL DEFAULT true,
            timeout_ms INTEGER NOT NULL DEFAULT 30000,
            max_retries INTEGER NOT NULL DEFAULT 0,
            created_by INTEGER,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT workflows_slug_db_unique UNIQUE (database_id, slug)
        )
    "#)
    .execute(&pool)
    .await?;
    println!("  ✅ management.workflows（DAG 模型）");

    // ===== workflow_runs 表 =====
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS management.workflow_runs (
            id BIGSERIAL PRIMARY KEY,
            workflow_id INTEGER NOT NULL REFERENCES management.workflows(id) ON DELETE CASCADE,
            tenant_id INTEGER,
            trigger_type VARCHAR(20) NOT NULL DEFAULT 'manual',
            trigger_data JSONB,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            node_results JSONB NOT NULL DEFAULT '[]',
            final_output JSONB,
            error_message TEXT,
            elapsed_ms BIGINT,
            started_at TIMESTAMP NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMP
        )
    "#)
    .execute(&pool)
    .await?;
    println!("  ✅ management.workflow_runs");

    // ===== 索引 =====
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_workflows_slug ON management.workflows(database_id, slug)"
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON management.workflows(tenant_id)"
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON management.workflows(trigger_type) WHERE is_enabled = true"
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_workflow_runs_wid ON management.workflow_runs(workflow_id, started_at DESC)"
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON management.workflow_runs(status) WHERE status = 'running'"
    )
    .execute(&pool)
    .await?;

    println!("  ✅ 索引已创建");

    // ===== updated_at 触发器 =====
    sqlx::query(r#"
        CREATE OR REPLACE FUNCTION management.update_workflows_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    "#)
    .execute(&pool)
    .await?;

    sqlx::query("DROP TRIGGER IF EXISTS trigger_workflows_updated_at ON management.workflows")
        .execute(&pool)
        .await?;

    sqlx::query(r#"
        CREATE TRIGGER trigger_workflows_updated_at
            BEFORE UPDATE ON management.workflows
            FOR EACH ROW EXECUTE FUNCTION management.update_workflows_updated_at()
    "#)
    .execute(&pool)
    .await?;
    println!("  ✅ updated_at 触发器");

    println!("\n✅ Workflow DAG 引擎迁移完成！");
    println!("\n触发器类型:");
    println!("  - endpoint: POST /workflow/:database_id/:slug");
    println!("  - hook: Auto API CRUD 生命周期钩子");
    println!("  - cron: 定时触发（复用 scheduler）");
    println!("  - manual: 管理后台手动触发");

    Ok(())
}
