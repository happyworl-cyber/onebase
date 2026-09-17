use crate::error::Result;
use crate::workflow_handlers::Workflow;
use serde_json::Value;
use sqlx::{Executor, PgPool, Postgres};
use std::collections::HashMap;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct WorkflowDraft {
    pub workflow_id: i32,
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub department: Option<String>,
    pub trigger_type: String,
    pub trigger_config: Value,
    pub input_schema: Option<Value>,
    pub nodes: Value,
    pub edges: Value,
    pub dependencies: Value,
    pub timeout_ms: i32,
    pub max_retries: i32,
    pub note: Option<String>,
    pub updated_by: Option<i32>,
    pub updated_at: chrono::NaiveDateTime,
}

pub fn workflow_is_live(wf: &Workflow) -> bool {
    wf.is_enabled && wf.published_version.is_some()
}

pub fn apply_draft(wf: &mut Workflow, draft: &WorkflowDraft) {
    wf.published_slug = wf.published_version.map(|_| wf.slug.clone());
    wf.name.clone_from(&draft.name);
    wf.slug.clone_from(&draft.slug);
    wf.description.clone_from(&draft.description);
    wf.category.clone_from(&draft.category);
    wf.department.clone_from(&draft.department);
    wf.trigger_type.clone_from(&draft.trigger_type);
    wf.trigger_config.clone_from(&draft.trigger_config);
    wf.input_schema.clone_from(&draft.input_schema);
    wf.nodes.clone_from(&draft.nodes);
    wf.edges.clone_from(&draft.edges);
    wf.dependencies.clone_from(&draft.dependencies);
    wf.timeout_ms = draft.timeout_ms;
    wf.max_retries = draft.max_retries;
    wf.updated_by = draft.updated_by;
    wf.updated_at = draft.updated_at;
    wf.has_unpublished = true;
}

pub fn editor_view(mut wf: Workflow, draft: Option<WorkflowDraft>) -> Workflow {
    if let Some(draft) = draft {
        apply_draft(&mut wf, &draft);
    } else {
        wf.has_unpublished = false;
    }
    wf
}

/// 接口文档：已发布用主表（不叠草稿）；从未发布则叠草稿。
pub fn workflow_for_api_doc(live: Workflow, draft: Option<WorkflowDraft>) -> (Workflow, bool) {
    let unpublished = live.published_version.is_none();
    if unpublished {
        (editor_view(live, draft), true)
    } else {
        (live, false)
    }
}

pub fn duplicate_copy_name(name: &str) -> String {
    format!("{name} (副本)")
}

/// 从编辑态定义构造草稿（新 id / 新 name / 新 slug）。
pub fn draft_from_editor(
    editor: &Workflow,
    workflow_id: i32,
    name: String,
    slug: String,
    note: Option<String>,
    updated_by: Option<i32>,
) -> WorkflowDraft {
    WorkflowDraft {
        workflow_id,
        name,
        slug,
        description: editor.description.clone(),
        category: editor.category.clone(),
        department: editor.department.clone(),
        trigger_type: editor.trigger_type.clone(),
        trigger_config: editor.trigger_config.clone(),
        input_schema: editor.input_schema.clone(),
        nodes: editor.nodes.clone(),
        edges: editor.edges.clone(),
        dependencies: editor.dependencies.clone(),
        timeout_ms: editor.timeout_ms,
        max_retries: editor.max_retries,
        note,
        updated_by,
        updated_at: chrono::Utc::now().naive_utc(),
    }
}

#[derive(Default)]
pub struct UpdateKind {
    pub definition: bool,
    pub taxonomy_only: bool,
}

pub fn classify_update(has_definition: bool, has_taxonomy: bool) -> UpdateKind {
    UpdateKind {
        definition: has_definition,
        taxonomy_only: has_taxonomy && !has_definition,
    }
}

/// Field presence for `remove_node_ids` — empty slice still counts as definition PATCH.
pub fn has_remove_node_ids(ids: Option<&[String]>) -> bool {
    ids.is_some()
}

pub fn slug_conflict_sql() -> &'static str {
    r#"SELECT EXISTS(
         SELECT 1 FROM management.workflows w
          WHERE w.slug = $1
            AND w.database_id IS NOT DISTINCT FROM $2
            AND ($3::int IS NULL OR w.id <> $3)
         UNION ALL
         SELECT 1 FROM management.workflow_drafts d
         JOIN management.workflows w2 ON w2.id = d.workflow_id
          WHERE d.slug = $1
            AND w2.database_id IS NOT DISTINCT FROM $2
            AND ($3::int IS NULL OR d.workflow_id <> $3)
       )"#
}

pub async fn fetch_draft<'e, E>(executor: E, workflow_id: i32) -> Result<Option<WorkflowDraft>>
where
    E: Executor<'e, Database = Postgres>,
{
    let draft = sqlx::query_as::<_, WorkflowDraft>(
        "SELECT * FROM management.workflow_drafts WHERE workflow_id = $1",
    )
    .bind(workflow_id)
    .fetch_optional(executor)
    .await?;
    Ok(draft)
}

pub async fn fetch_draft_for_update<'e, E>(
    executor: E,
    workflow_id: i32,
) -> Result<Option<WorkflowDraft>>
where
    E: Executor<'e, Database = Postgres>,
{
    let draft = sqlx::query_as::<_, WorkflowDraft>(
        "SELECT * FROM management.workflow_drafts WHERE workflow_id = $1 FOR UPDATE",
    )
    .bind(workflow_id)
    .fetch_optional(executor)
    .await?;
    Ok(draft)
}

pub async fn fetch_drafts_for(pool: &PgPool, ids: &[i32]) -> Result<HashMap<i32, WorkflowDraft>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query_as::<_, WorkflowDraft>(
        "SELECT * FROM management.workflow_drafts WHERE workflow_id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|d| (d.workflow_id, d)).collect())
}

pub fn upsert_draft_sql() -> &'static str {
    r#"WITH d AS (
            INSERT INTO management.workflow_drafts
            (workflow_id, name, slug, description, category, department,
             trigger_type, trigger_config, input_schema, nodes, edges, dependencies,
             timeout_ms, max_retries, note, updated_by, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (workflow_id) DO UPDATE SET
              name = EXCLUDED.name,
              slug = EXCLUDED.slug,
              description = EXCLUDED.description,
              category = EXCLUDED.category,
              department = EXCLUDED.department,
              trigger_type = EXCLUDED.trigger_type,
              trigger_config = EXCLUDED.trigger_config,
              input_schema = EXCLUDED.input_schema,
              nodes = EXCLUDED.nodes,
              edges = EXCLUDED.edges,
              dependencies = EXCLUDED.dependencies,
              timeout_ms = EXCLUDED.timeout_ms,
              max_retries = EXCLUDED.max_retries,
              note = EXCLUDED.note,
              updated_by = EXCLUDED.updated_by,
              updated_at = EXCLUDED.updated_at
            RETURNING workflow_id, updated_by, updated_at
        )
        UPDATE management.workflows w
        SET updated_by = d.updated_by,
            updated_at = d.updated_at
        FROM d
        WHERE w.id = d.workflow_id
          AND d.updated_by IS NOT NULL"#
}

pub async fn upsert_draft<'e, E>(executor: E, draft: &WorkflowDraft) -> Result<()>
where
    E: Executor<'e, Database = Postgres>,
{
    sqlx::query(upsert_draft_sql())
        .bind(draft.workflow_id)
        .bind(&draft.name)
        .bind(&draft.slug)
        .bind(&draft.description)
        .bind(&draft.category)
        .bind(&draft.department)
        .bind(&draft.trigger_type)
        .bind(&draft.trigger_config)
        .bind(&draft.input_schema)
        .bind(&draft.nodes)
        .bind(&draft.edges)
        .bind(&draft.dependencies)
        .bind(draft.timeout_ms)
        .bind(draft.max_retries)
        .bind(&draft.note)
        .bind(draft.updated_by)
        .bind(draft.updated_at)
        .execute(executor)
        .await?;
    Ok(())
}

pub async fn delete_draft<'e, E>(executor: E, workflow_id: i32) -> Result<u64>
where
    E: Executor<'e, Database = Postgres>,
{
    let result = sqlx::query("DELETE FROM management.workflow_drafts WHERE workflow_id = $1")
        .bind(workflow_id)
        .execute(executor)
        .await?;
    Ok(result.rows_affected())
}

pub async fn draft_slug_taken(
    pool: &PgPool,
    database_id: Option<i32>,
    slug: &str,
    self_id: Option<i32>,
) -> Result<bool> {
    let taken = sqlx::query_scalar(slug_conflict_sql())
        .bind(slug)
        .bind(database_id)
        .bind(self_id)
        .fetch_one(pool)
        .await?;
    Ok(taken)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn timestamp(seconds: i64) -> chrono::NaiveDateTime {
        chrono::Utc.timestamp_opt(seconds, 0).unwrap().naive_utc()
    }

    fn live_wf() -> Workflow {
        Workflow {
            id: 1,
            tenant_id: Some(9),
            database_id: Some(2),
            name: "live".into(),
            slug: "live".into(),
            description: Some("L".into()),
            category: Some("cat".into()),
            department: Some("dept".into()),
            trigger_type: "endpoint".into(),
            trigger_config: json!({}),
            input_schema: None,
            nodes: json!([{"id":"a"}]),
            edges: json!([]),
            dependencies: json!({"javascript": {"lodash": "4.0.0"}}),
            is_enabled: true,
            timeout_ms: 30_000,
            max_retries: 0,
            alert_webhook_url: Some("https://example.com".into()),
            alert_webhook_template: None,
            alert_throttle_hours: 24,
            last_alert_sent_at: None,
            created_by: None,
            updated_by: None,
            created_at: timestamp(0),
            updated_at: timestamp(0),
            created_by_name: None,
            created_by_email: None,
            updated_by_name: None,
            updated_by_email: None,
            published_version: Some(3),
            has_unpublished: false,
            published_slug: None,
        }
    }

    fn draft() -> WorkflowDraft {
        WorkflowDraft {
            workflow_id: 1,
            name: "draft".into(),
            slug: "draft".into(),
            description: None,
            category: Some("new-cat".into()),
            department: Some("dept".into()),
            trigger_type: "manual".into(),
            trigger_config: json!({"x": 1}),
            input_schema: Some(json!({"type": "object"})),
            nodes: json!([{"id":"b"}]),
            edges: json!([{"from":"b","to":"b"}]),
            dependencies: json!({}),
            timeout_ms: 12_000,
            max_retries: 2,
            note: Some("n".into()),
            updated_by: Some(1),
            updated_at: timestamp(1),
        }
    }

    #[test]
    fn live_requires_enabled_and_published_version() {
        let mut wf = live_wf();
        assert!(workflow_is_live(&wf));
        wf.is_enabled = false;
        assert!(!workflow_is_live(&wf));
        wf.is_enabled = true;
        wf.published_version = None;
        assert!(!workflow_is_live(&wf));
    }

    #[test]
    fn apply_draft_overwrites_definition_keeps_binding() {
        let mut wf = live_wf();
        apply_draft(&mut wf, &draft());
        assert_eq!(wf.name, "draft");
        assert_eq!(wf.slug, "draft");
        assert_eq!(wf.trigger_type, "manual");
        assert_eq!(wf.nodes, json!([{"id":"b"}]));
        assert_eq!(wf.timeout_ms, 12_000);
        assert_eq!(wf.published_version, Some(3));
        assert!(wf.is_enabled);
        assert_eq!(wf.database_id, Some(2));
        assert_eq!(wf.alert_webhook_url.as_deref(), Some("https://example.com"));
        assert!(wf.has_unpublished);
        assert_eq!(wf.published_slug.as_deref(), Some("live"));
        assert_eq!(wf.updated_at, timestamp(1));
        assert_eq!(wf.updated_by, Some(1));
    }

    #[test]
    fn editor_view_without_draft_is_live_row() {
        let wf = editor_view(live_wf(), None);
        assert!(!wf.has_unpublished);
        assert_eq!(wf.name, "live");
    }

    #[test]
    fn slug_conflict_sql_excludes_self() {
        assert!(slug_conflict_sql().contains("$3"));
        assert!(slug_conflict_sql().contains("workflow_drafts"));
    }

    #[test]
    fn classify_editor_save_is_definition_not_taxonomy_only() {
        let k = classify_update(true, true);
        assert!(k.definition);
        assert!(!k.taxonomy_only);
    }

    #[test]
    fn classify_list_move_is_taxonomy_only() {
        let k = classify_update(false, true);
        assert!(!k.definition);
        assert!(k.taxonomy_only);
    }

    #[test]
    fn empty_remove_node_ids_is_definition_not_taxonomy_only() {
        assert!(has_remove_node_ids(Some(&[])));
        let k = classify_update(has_remove_node_ids(Some(&[])), true);
        assert!(k.definition);
        assert!(!k.taxonomy_only);
    }

    #[test]
    fn api_doc_uses_live_when_published() {
        let live = live_wf();
        let (doc, unpublished) = workflow_for_api_doc(live, Some(draft()));
        assert!(!unpublished);
        assert_eq!(doc.name, "live");
        assert_eq!(doc.slug, "live");
        assert_eq!(doc.nodes, json!([{"id":"a"}]));
    }

    #[test]
    fn api_doc_overlays_draft_when_unpublished() {
        let mut live = live_wf();
        live.published_version = None;
        let (doc, unpublished) = workflow_for_api_doc(live, Some(draft()));
        assert!(unpublished);
        assert_eq!(doc.name, "draft");
        assert_eq!(doc.slug, "draft");
        assert_eq!(doc.nodes, json!([{"id":"b"}]));
    }

    #[test]
    fn draft_from_editor_takes_new_id_name_slug() {
        let editor = editor_view(live_wf(), Some(draft()));
        let d = draft_from_editor(&editor, 99, "Copy".into(), "copy".into(), None, Some(7));
        assert_eq!(d.workflow_id, 99);
        assert_eq!(d.name, "Copy");
        assert_eq!(d.slug, "copy");
        assert_eq!(d.nodes, json!([{"id":"b"}]));
        assert_eq!(d.trigger_type, "manual");
        assert_eq!(d.timeout_ms, 12_000);
        assert_eq!(d.updated_by, Some(7));
        assert_eq!(d.note, None);
    }

    #[test]
    fn duplicate_copy_name_appends_suffix() {
        assert_eq!(duplicate_copy_name("草稿名"), "草稿名 (副本)");
    }

    #[test]
    fn upsert_draft_sql_updates_workflow_when_updated_by_present() {
        let sql = upsert_draft_sql();
        assert!(
            sql.contains("INSERT INTO management.workflow_drafts"),
            "{sql}"
        );
        assert!(sql.contains("UPDATE management.workflows w"), "{sql}");
        assert!(sql.contains("AND d.updated_by IS NOT NULL"), "{sql}");
        assert!(sql.contains("updated_at = d.updated_at"), "{sql}");
    }
}
