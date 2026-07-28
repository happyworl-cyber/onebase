use crate::events::{DataChangeEvent, EventBus};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookConfig {
    pub id: i32,
    pub tenant_id: i32,
    pub name: String,
    pub url: String,
    pub event_pattern: String,
    pub headers: serde_json::Value,
    pub secret: Option<String>,
    pub retry_count: i32,
    pub timeout_ms: i32,
}

/// Webhook 管理器：监听 EventBus 并异步分发 HTTP 回调
pub struct WebhookManager {
    pool: PgPool,
    client: Client,
}

impl WebhookManager {
    pub fn new(pool: PgPool) -> Self {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self { pool, client }
    }

    /// 启动后台监听（消费 EventBus 中的事件）
    pub fn start(self, event_bus: EventBus) -> tokio::task::JoinHandle<()> {
        let manager = Arc::new(self);
        let mut rx = event_bus.subscribe();

        tokio::spawn(async move {
            tracing::info!("WebhookManager 已启动");
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let mgr = manager.clone();
                        tokio::spawn(async move {
                            mgr.dispatch(event).await;
                        });
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("WebhookManager 丢失 {} 个事件", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tracing::info!("EventBus 关闭，WebhookManager 退出");
                        break;
                    }
                }
            }
        })
    }

    /// 为单个事件分发所有匹配的 webhook
    async fn dispatch(&self, event: DataChangeEvent) {
        let webhooks = match self.load_matching_webhooks(&event).await {
            Ok(w) => w,
            Err(e) => {
                tracing::error!("加载 webhook 失败: {}", e);
                return;
            }
        };

        for wh in webhooks {
            let client = self.client.clone();
            let pool = self.pool.clone();
            let evt = event.clone();
            // 把触发本次事件的请求 ID 透出去：webhook 异步派发到独立 spawn 后，
            // 日志里就能继续看到 x_request_id，方便和前端/客户端报障对账。
            // 非 HTTP 触发的事件 request_id 为 None，scope_with 会自动跳过。
            let req_id = evt.request_id.clone();
            tokio::spawn(crate::request_id::scope_with(req_id, async move {
                Self::execute_webhook(&client, &pool, &wh, &evt).await;
            }));
        }
    }

    /// 查找与事件匹配的活跃 webhook
    async fn load_matching_webhooks(&self, event: &DataChangeEvent) -> Result<Vec<WebhookConfig>, sqlx::Error> {
        use sqlx::Row;
        let rows = sqlx::query(
            "SELECT id, tenant_id, name, url, event_pattern, \
                    COALESCE(headers, '{}') as headers, secret, \
                    retry_count, timeout_ms \
             FROM management.webhooks \
             WHERE is_active = true"
        )
        .fetch_all(&self.pool)
        .await?;

        let event_key = format!("{}.{}.{}", event.schema, event.table, event.action);

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let wh = WebhookConfig {
                    id: row.get("id"),
                    tenant_id: row.get("tenant_id"),
                    name: row.get("name"),
                    url: row.get("url"),
                    event_pattern: row.get("event_pattern"),
                    headers: row.get("headers"),
                    secret: row.get("secret"),
                    retry_count: row.get("retry_count"),
                    timeout_ms: row.get("timeout_ms"),
                };
                if pattern_matches(&wh.event_pattern, &event_key) {
                    Some(wh)
                } else {
                    None
                }
            })
            .collect())
    }

    /// 执行单个 webhook（含重试）
    async fn execute_webhook(client: &Client, pool: &PgPool, wh: &WebhookConfig, event: &DataChangeEvent) {
        let payload = serde_json::json!({
            "event": event.action.to_string(),
            "schema": event.schema,
            "table": event.table,
            "data": event.new_data,
            "old_data": event.old_data,
            "timestamp": event.timestamp.to_rfc3339(),
        });

        let max_attempts = wh.retry_count.max(1) as u32;

        for attempt in 1..=max_attempts {
            let start = Instant::now();

            let mut req = client
                .post(&wh.url)
                .timeout(std::time::Duration::from_millis(wh.timeout_ms as u64))
                .json(&payload);

            // 自定义 headers
            if let Some(obj) = wh.headers.as_object() {
                for (k, v) in obj {
                    if let Some(vs) = v.as_str() {
                        req = req.header(k.as_str(), vs);
                    }
                }
            }

            // HMAC 签名
            if let Some(ref secret) = wh.secret {
                use sha2::{Digest, Sha256};
                let body_str = serde_json::to_string(&payload).unwrap_or_default();
                let mut hasher = Sha256::new();
                hasher.update(secret.as_bytes());
                hasher.update(body_str.as_bytes());
                let sig = hex::encode(hasher.finalize());
                req = req.header("X-Webhook-Signature", sig);
            }

            let duration_ms = start.elapsed().as_millis() as i32;

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16() as i32;
                    let body = resp.text().await.unwrap_or_default();
                    let success = (200..300).contains(&(status as u16 as i32));
                    let dur = start.elapsed().as_millis() as i32;

                    Self::log_execution(pool, wh.id, &payload, Some(status), Some(&body), attempt as i32, success, None, dur).await;

                    if success {
                        return;
                    }
                    tracing::warn!("Webhook {} 返回 {}, attempt {}/{}", wh.id, status, attempt, max_attempts);
                }
                Err(e) => {
                    let msg = e.to_string();
                    Self::log_execution(pool, wh.id, &payload, None, None, attempt as i32, false, Some(&msg), duration_ms).await;
                    tracing::warn!("Webhook {} 调用失败: {}, attempt {}/{}", wh.id, msg, attempt, max_attempts);
                }
            }

            if attempt < max_attempts {
                let backoff = std::time::Duration::from_millis(500 * 2u64.pow(attempt - 1));
                tokio::time::sleep(backoff).await;
            }
        }
    }

    async fn log_execution(
        pool: &PgPool,
        webhook_id: i32,
        event_data: &serde_json::Value,
        response_status: Option<i32>,
        response_body: Option<&str>,
        attempt: i32,
        success: bool,
        error_message: Option<&str>,
        duration_ms: i32,
    ) {
        let _ = sqlx::query(
            "INSERT INTO management.webhook_logs \
             (webhook_id, event_data, response_status, response_body, attempt, success, error_message, duration_ms) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"
        )
        .bind(webhook_id)
        .bind(event_data)
        .bind(response_status)
        .bind(response_body)
        .bind(attempt)
        .bind(success)
        .bind(error_message)
        .bind(duration_ms)
        .execute(pool)
        .await;
    }
}

/// 通配符模式匹配：`*` 匹配任意单段，`*.*.*` 匹配全部
fn pattern_matches(pattern: &str, event_key: &str) -> bool {
    let pat_parts: Vec<&str> = pattern.split('.').collect();
    let key_parts: Vec<&str> = event_key.split('.').collect();

    if pat_parts.len() != key_parts.len() {
        return false;
    }

    pat_parts
        .iter()
        .zip(key_parts.iter())
        .all(|(p, k)| *p == "*" || p.eq_ignore_ascii_case(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pattern_matching() {
        assert!(pattern_matches("public.posts.INSERT", "public.posts.INSERT"));
        assert!(!pattern_matches("public.posts.INSERT", "public.posts.UPDATE"));
        assert!(pattern_matches("public.*.INSERT", "public.posts.INSERT"));
        assert!(pattern_matches("*.*.*", "public.posts.DELETE"));
        assert!(!pattern_matches("public.posts", "public.posts.INSERT"));
        assert!(pattern_matches("*.posts.*", "public.posts.UPDATE"));
    }
}
