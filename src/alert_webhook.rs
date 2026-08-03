use chrono::Utc;
use reqwest::Client;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::BTreeMap;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct AlertWebhookContext {
    pub source: &'static str,
    pub object_id: i64,
    pub run_id: i64,
    pub name: String,
    pub status: String,
    pub error: Option<String>,
    pub trigger_type: String,
    pub trace_id: Option<String>,
}

fn default_template() -> Value {
    json!({
        "msg_type": "markdown",
        "content": "### \u{1F6A8} 报警\n- **类型**: {{source}}\n- **名称**: {{name}}\n- **状态**: {{status}}\n- **错误**: {{error}}\n- **时间**: {{time}}\n- **Run ID**: {{run_id}}"
    })
}

pub fn render_template(template: &Value, vars: &BTreeMap<String, String>) -> Value {
    match template {
        Value::String(s) => Value::String(render_string(s, vars)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| render_template(item, vars))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), render_template(v, vars)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn render_string(input: &str, vars: &BTreeMap<String, String>) -> String {
    let mut out = input.to_string();
    for (key, value) in vars {
        out = out.replace(&format!("{{{{{key}}}}}"), value);
    }
    out
}

pub fn spawn_workflow_failure_alert(pool: PgPool, workflow_id: i32, ctx: AlertWebhookContext) {
    tokio::spawn(async move {
        if let Err(e) = send_workflow_failure_alert(&pool, workflow_id, ctx).await {
            tracing::warn!(workflow_id, error = %e, "工作流失败告警 Webhook 发送流程失败");
        }
    });
}

pub fn spawn_scheduled_task_failure_alert(pool: PgPool, task_id: i64, ctx: AlertWebhookContext) {
    tokio::spawn(async move {
        if let Err(e) = send_scheduled_task_failure_alert(&pool, task_id, ctx).await {
            tracing::warn!(task_id, error = %e, "定时任务失败告警 Webhook 发送流程失败");
        }
    });
}

async fn send_workflow_failure_alert(
    pool: &PgPool,
    workflow_id: i32,
    ctx: AlertWebhookContext,
) -> Result<(), String> {
    let row = sqlx::query(
        "UPDATE management.workflows \
         SET last_alert_sent_at = NOW() \
         WHERE id = $1 \
           AND alert_webhook_url IS NOT NULL \
           AND ( \
             alert_throttle_hours = 0 \
             OR last_alert_sent_at IS NULL \
             OR last_alert_sent_at < NOW() - (alert_throttle_hours * INTERVAL '1 hour') \
           ) \
         RETURNING alert_webhook_url, alert_webhook_template",
    )
    .bind(workflow_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(row) = row {
        let url: String = row.get("alert_webhook_url");
        let template: Option<Value> = row.try_get("alert_webhook_template").unwrap_or(None);
        send_alert_payload(&url, template, ctx).await?;
    }
    Ok(())
}

async fn send_scheduled_task_failure_alert(
    pool: &PgPool,
    task_id: i64,
    ctx: AlertWebhookContext,
) -> Result<(), String> {
    let row = sqlx::query(
        "UPDATE management.scheduled_tasks \
         SET last_alert_sent_at = NOW() \
         WHERE id = $1 \
           AND alert_webhook_url IS NOT NULL \
           AND ( \
             alert_throttle_hours = 0 \
             OR last_alert_sent_at IS NULL \
             OR last_alert_sent_at < NOW() - (alert_throttle_hours * INTERVAL '1 hour') \
           ) \
         RETURNING alert_webhook_url, alert_webhook_template",
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(row) = row {
        let url: String = row.get("alert_webhook_url");
        let template: Option<Value> = row.try_get("alert_webhook_template").unwrap_or(None);
        send_alert_payload(&url, template, ctx).await?;
    }
    Ok(())
}

async fn send_alert_payload(
    url: &str,
    template: Option<Value>,
    ctx: AlertWebhookContext,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let vars = BTreeMap::from([
        ("source".to_string(), ctx.source.to_string()),
        ("name".to_string(), ctx.name),
        ("status".to_string(), ctx.status),
        (
            "error".to_string(),
            ctx.error.unwrap_or_else(|| "执行失败".to_string()),
        ),
        ("time".to_string(), now),
        ("run_id".to_string(), ctx.run_id.to_string()),
        ("object_id".to_string(), ctx.object_id.to_string()),
        ("trigger_type".to_string(), ctx.trigger_type),
        ("trace_id".to_string(), ctx.trace_id.unwrap_or_default()),
    ]);
    let tmpl = template.unwrap_or_else(default_template);
    post_webhook_json(url, &tmpl, &vars).await
}

/// 向 Webhook URL POST 渲染后的 JSON（5s 超时，不重试）。平台监控告警复用。
pub async fn post_webhook_json(
    url: &str,
    template: &Value,
    vars: &BTreeMap<String, String>,
) -> Result<(), String> {
    let payload = render_template(template, vars);
    let client = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Webhook 返回 HTTP {}", resp.status()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn render_template_replaces_nested_string_values() {
        let template = json!({
            "msg_type": "markdown",
            "content": "name={{name}} error={{error}}",
            "nested": { "trace": "{{trace_id}}" },
            "count": 3
        });
        let vars = BTreeMap::from([
            ("name".to_string(), "orders".to_string()),
            ("error".to_string(), "boom".to_string()),
            ("trace_id".to_string(), "tr_1".to_string()),
        ]);

        assert_eq!(
            render_template(&template, &vars),
            json!({
                "msg_type": "markdown",
                "content": "name=orders error=boom",
                "nested": { "trace": "tr_1" },
                "count": 3
            })
        );
    }

    #[test]
    fn render_template_keeps_unknown_variables() {
        let template = json!({ "content": "{{missing}} {{name}}" });
        let vars = BTreeMap::from([("name".to_string(), "wf".to_string())]);
        assert_eq!(
            render_template(&template, &vars),
            json!({ "content": "{{missing}} wf" })
        );
    }
}
