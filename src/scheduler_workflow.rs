//! 定时任务 kind=workflow：进程内调用 `execute_workflow_internal`。
//!
//! 放在 bin crate：实现依赖 `workflow_handlers`，而 `scheduler` 模块同时编进 lib。

use async_trait::async_trait;
use serde_json::Value;
use sqlx::PgPool;

use crate::scheduler::executors::WorkflowKindExecutor;
use crate::scheduler::models::ScheduledTask;
use crate::workflow_engine::ApiKeyWriteGuard;
use crate::workflow_handlers::{self, Workflow};

pub struct WorkflowExecutor {
    pub pool: PgPool,
}

impl WorkflowExecutor {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl WorkflowKindExecutor for WorkflowExecutor {
    async fn execute(&self, task: &ScheduledTask) -> Result<Value, String> {
        let tenant_id = task
            .tenant_id
            .ok_or_else(|| "工作流任务缺少 tenant_id".to_string())?;
        let workflow_id = task
            .workflow_id
            .ok_or_else(|| "工作流已删除或不存在".to_string())?;

        let wf = sqlx::query_as::<_, Workflow>("SELECT * FROM management.workflows WHERE id = $1")
            .bind(workflow_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "工作流已删除或不存在".to_string())?;

        if wf.tenant_id != Some(tenant_id) {
            return Err("工作流不属于当前项目".to_string());
        }
        if !wf.is_enabled {
            return Err(format!("工作流 {} 已禁用", wf.slug));
        }

        let fired_at = chrono::Utc::now().to_rfc3339();
        let mut data = match &task.workflow_input {
            Some(v) if v.is_object() => v.clone(),
            _ => serde_json::json!({}),
        };
        if let Some(obj) = data.as_object_mut() {
            obj.insert(
                "fired_at".into(),
                serde_json::Value::String(fired_at.clone()),
            );
            obj.insert("scheduled_task_id".into(), serde_json::json!(task.id));
        }

        workflow_handlers::execute_workflow_internal(
            &self.pool,
            &wf,
            "scheduler",
            &data,
            Some(task.created_by),
            ApiKeyWriteGuard::Off,
        )
        .await
        .map_err(|e| e.to_string())?;

        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT id, status FROM management.workflow_runs \
             WHERE workflow_id = $1 AND trigger_type = 'scheduler' \
               AND trigger_data->>'fired_at' = $2 \
             ORDER BY id DESC LIMIT 1",
        )
        .bind(wf.id)
        .bind(&fired_at)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let (run_id, status) = row.unwrap_or((0, "success".into()));
        Ok(serde_json::json!({
            "workflow_run_id": run_id,
            "status": status,
        }))
    }
}
