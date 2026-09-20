//! 阿里云 SLS GetLogs：签名与 HTTP。测试用 `SlsHttp` 注入，不连真网。

use crate::cloud_log::{CloudLogLine, CloudLogQuery};
use async_trait::async_trait;
use base64::{engine::general_purpose, Engine as _};
use serde_json::{Map, Value};

pub fn sls_string_to_sign(
    method: &str,
    content_md5: &str,
    content_type: &str,
    date: &str,
    canonical_headers: &str,
    canonical_resource: &str,
) -> String {
    format!(
        "{method}\n{content_md5}\n{content_type}\n{date}\n{canonical_headers}{canonical_resource}"
    )
}

pub fn sls_authorization(
    access_key_id: &str,
    access_key_secret: &str,
    string_to_sign: &str,
) -> Result<String, String> {
    let mac = crate::crypto_primitives::hmac_sha1(
        access_key_secret.as_bytes(),
        string_to_sign.as_bytes(),
    )?;
    Ok(format!(
        "LOG {access_key_id}:{}",
        general_purpose::STANDARD.encode(mac)
    ))
}

pub fn sls_canonical_resource(logstore: &str, q: &CloudLogQuery) -> String {
    let reverse = if q.reverse { "true" } else { "false" };
    format!(
        "/logstores/{logstore}?from={}&line={}&offset={}&query={}&reverse={reverse}&to={}&type=log",
        q.from, q.line, q.offset, q.query, q.to
    )
}

fn sls_canonical_headers() -> &'static str {
    "x-log-apiversion:0.6.0\nx-log-bodyrawsize:0\nx-log-signaturemethod:hmac-sha1\n"
}

fn parse_embedded_object(raw: &str) -> Option<Map<String, Value>> {
    let start = raw.find('{')?;
    match serde_json::from_str::<Value>(raw[start..].trim()) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// Logtail 常把整行 JSON 放在 `content` / `message` 里；PlaneOS stdout 的
/// `level` / `message` / `x_request_id` 都在那一层。已有同名键不覆盖。
fn flatten_embedded_json(row: &mut Map<String, Value>) {
    const EMBEDDED: [&str; 4] = ["content", "message", "__raw_log__", "log"];
    let keys: Vec<String> = EMBEDDED
        .iter()
        .filter(|k| row.contains_key(**k))
        .map(|s| (*s).to_string())
        .collect();
    for key in keys {
        let parsed = match row.get(&key) {
            Some(Value::String(s)) => match parse_embedded_object(s) {
                Some(m) => m,
                None => continue,
            },
            Some(Value::Object(m)) => m.clone(),
            _ => continue,
        };
        for (k, v) in parsed {
            row.entry(k).or_insert(v);
        }
    }
    if let Some(Value::Object(fields)) = row.get("fields").cloned() {
        for (k, v) in fields {
            row.entry(k).or_insert(v);
        }
    }
}

pub fn parse_getlogs_json(body: &str) -> Result<Vec<CloudLogLine>, String> {
    let rows: Vec<Map<String, Value>> =
        serde_json::from_str(body).map_err(|e| format!("SLS 响应不是 JSON 数组: {e}"))?;
    let mut logs = Vec::with_capacity(rows.len());
    for mut row in rows {
        let time = match row.remove("__time__") {
            Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
            Some(Value::String(s)) => s.parse().unwrap_or(0),
            _ => 0,
        };
        flatten_embedded_json(&mut row);
        logs.push(CloudLogLine {
            time,
            contents: row,
        });
    }
    Ok(logs)
}

#[async_trait]
pub trait SlsHttp {
    async fn get(&self, url: &str, headers: Vec<(String, String)>)
        -> Result<(u16, String), String>;
}

pub async fn get_logs<H: SlsHttp + Sync>(
    http: &H,
    endpoint: &str,
    access_key_id: &str,
    access_key_secret: &str,
    _sls_project: &str,
    logstore: &str,
    date_rfc1123: &str,
    q: &CloudLogQuery,
) -> Result<Vec<CloudLogLine>, String> {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let resource = sls_canonical_resource(logstore, q);
    let headers_canon = sls_canonical_headers();
    let sts = sls_string_to_sign("GET", "", "", date_rfc1123, headers_canon, &resource);
    let auth = sls_authorization(access_key_id, access_key_secret, &sts)?;
    let host = endpoint
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let query_enc = utf8_percent_encode(&q.query, NON_ALPHANUMERIC);
    let url = format!(
        "https://{host}/logstores/{logstore}?from={}&to={}&line={}&offset={}&reverse={}&query={query_enc}&type=log",
        q.from,
        q.to,
        q.line,
        q.offset,
        if q.reverse { "true" } else { "false" },
    );
    let headers = vec![
        ("Date".into(), date_rfc1123.to_string()),
        ("Authorization".into(), auth),
        ("Accept".into(), "application/json".into()),
        ("Host".into(), host.to_string()),
        ("x-log-apiversion".into(), "0.6.0".into()),
        ("x-log-bodyrawsize".into(), "0".into()),
        ("x-log-signaturemethod".into(), "hmac-sha1".into()),
    ];
    let (status, body) = http.get(&url, headers).await?;
    if status == 401 || status == 403 {
        return Err("凭证无效或没有该 Logstore 的读权限".into());
    }
    if status != 200 {
        let brief: String = body.chars().take(300).collect();
        return Err(format!("SLS 返回 {status}: {brief}"));
    }
    parse_getlogs_json(&body)
}

pub struct ReqwestSlsHttp {
    pub client: reqwest::Client,
}

#[async_trait]
impl SlsHttp for ReqwestSlsHttp {
    async fn get(
        &self,
        url: &str,
        headers: Vec<(String, String)>,
    ) -> Result<(u16, String), String> {
        let mut req = self
            .client
            .get(url)
            .timeout(std::time::Duration::from_secs(10));
        for (k, v) in headers {
            req = req.header(&k, v);
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let body = res.text().await.map_err(|e| e.to_string())?;
        Ok((status, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_log::CloudLogQuery;

    fn sample_q() -> CloudLogQuery {
        CloudLogQuery {
            from: 100,
            to: 200,
            query: "error".into(),
            line: 50,
            offset: 0,
            reverse: true,
        }
    }

    #[test]
    fn canonical_resource_sorts_params() {
        let r = sls_canonical_resource("app-log", &sample_q());
        assert_eq!(
            r,
            "/logstores/app-log?from=100&line=50&offset=0&query=error&reverse=true&to=200&type=log"
        );
    }

    #[test]
    fn authorization_is_log_scheme() {
        let sts = sls_string_to_sign(
            "GET",
            "",
            "",
            "Mon, 3 Jan 2010 08:33:47 GMT",
            "x-log-apiversion:0.6.0\nx-log-bodyrawsize:0\nx-log-signaturemethod:hmac-sha1\n",
            "/logstores/app-log?type=log",
        );
        let auth = sls_authorization("testid", "testsecret", &sts).unwrap();
        assert!(auth.starts_with("LOG testid:"));
        assert_eq!(
            auth,
            sls_authorization("testid", "testsecret", &sts).unwrap()
        );
    }

    #[test]
    fn parse_getlogs_json_reads_time_and_fields() {
        let logs = parse_getlogs_json(
            r#"[{"__time__":1726032000,"message":"hello","x_request_id":"abc12345"}]"#,
        )
        .unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].time, 1726032000);
        assert_eq!(logs[0].contents["message"], "hello");
        assert_eq!(logs[0].contents["x_request_id"], "abc12345");
        assert!(!logs[0].contents.contains_key("__time__"));
    }

    #[test]
    fn parse_getlogs_json_flattens_embedded_content() {
        let logs = parse_getlogs_json(
            r#"[{"__time__":1,"__source__":"10.0.0.1","content":"{\"level\":\"INFO\",\"message\":\"hello\",\"x_request_id\":\"abc12345\"}"}]"#,
        )
        .unwrap();
        assert_eq!(logs[0].contents["level"], "INFO");
        assert_eq!(logs[0].contents["message"], "hello");
        assert_eq!(logs[0].contents["x_request_id"], "abc12345");
        assert_eq!(logs[0].contents["__source__"], "10.0.0.1");
    }

    #[test]
    fn parse_getlogs_json_flattens_prefixed_content_without_overwrite() {
        let logs = parse_getlogs_json(
            r#"[{"__time__":1,"message":"keep-outer","content":"2026-09-11T06:32:00Z stdout F {\"level\":\"WARN\",\"message\":\"inner\"}"}]"#,
        )
        .unwrap();
        assert_eq!(logs[0].contents["level"], "WARN");
        assert_eq!(logs[0].contents["message"], "keep-outer");
    }

    struct MockHttp {
        status: u16,
        body: String,
    }

    #[async_trait]
    impl SlsHttp for MockHttp {
        async fn get(
            &self,
            _url: &str,
            _headers: Vec<(String, String)>,
        ) -> Result<(u16, String), String> {
            Ok((self.status, self.body.clone()))
        }
    }

    #[tokio::test]
    async fn get_logs_maps_403() {
        let http = MockHttp {
            status: 403,
            body: r#"{"errorMessage":"denied"}"#.into(),
        };
        let err = get_logs(
            &http,
            "https://p.cn-hangzhou.log.aliyuncs.com",
            "id",
            "sec",
            "p",
            "app-log",
            "Mon, 3 Jan 2010 08:33:47 GMT",
            &sample_q(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("凭证") || err.contains("权限") || err.contains("403"));
    }

    #[tokio::test]
    async fn get_logs_parses_200() {
        let http = MockHttp {
            status: 200,
            body: r#"[{"__time__":1,"message":"ok"}]"#.into(),
        };
        let logs = get_logs(
            &http,
            "https://p.cn-hangzhou.log.aliyuncs.com",
            "id",
            "sec",
            "p",
            "app-log",
            "Mon, 3 Jan 2010 08:33:47 GMT",
            &sample_q(),
        )
        .await
        .unwrap();
        assert_eq!(logs[0].contents["message"], "ok");
    }
}
