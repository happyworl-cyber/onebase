use crate::workflow_qa::callers::WorkflowSketch;
use serde_json::Value;
use sqlx::{PgPool, Row};

pub async fn load_tenant_sketches(
    pool: &PgPool,
    tenant_id: Option<i32>,
) -> Result<Vec<WorkflowSketch>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, slug, name, nodes, input_schema, is_enabled \
         FROM management.workflows \
         WHERE tenant_id IS NOT DISTINCT FROM $1",
    )
    .bind(tenant_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|row| WorkflowSketch {
            id: row.get("id"),
            slug: row.get::<Option<String>, _>("slug").unwrap_or_default(),
            name: row.get::<Option<String>, _>("name").unwrap_or_default(),
            nodes: row
                .try_get("nodes")
                .unwrap_or_else(|_| Value::Array(vec![])),
            input_schema: row
                .try_get::<Option<Value>, _>("input_schema")
                .ok()
                .flatten()
                .filter(|v| !v.is_null()),
            is_enabled: row.try_get("is_enabled").unwrap_or(true),
        })
        .collect())
}

pub async fn load_saved_slug(pool: &PgPool, id: i32) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>("SELECT slug FROM management.workflows WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}
