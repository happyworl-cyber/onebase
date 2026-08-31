use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{AppError, Result};

// ─── 运行时超时配置（环境变量驱动，可完全关闭）─────────────────────────
//
// 根治「AI/LLM 等长耗时 HTTP 节点在默认 30s 被强杀」：所有超时层统一改为可配置，
// 并提供一个总开关彻底关闭。生效优先级：节点显式 timeout_secs > 环境变量 > 内置默认。
//
//   WORKFLOW_DISABLE_TIMEOUT            1/true/on → 关闭工作流整体超时 + HTTP 节点默认超时
//                                       （节点仍可显式设 timeout_secs 自行限制）。
//   WORKFLOW_DEFAULT_TIMEOUT_MS         工作流 timeout_ms<=0 时采用的默认整体超时；缺省 300000(5min)。
//   WORKFLOW_HTTP_DEFAULT_TIMEOUT_SECS  HTTP 节点未显式配置时的默认超时秒数；缺省 120；0=不限。
//   WORKFLOW_LUA_TIMEOUT_MS             code(Lua) 节点单节点执行的墙钟上限；缺省 30000；0=不限（慎用）。
//                                       单个 code 节点串行处理多行 + 每行调 LLM/长耗时 HTTP 时，
//                                       30s 易被强杀（如 AI 关单逐单调 DeepMind），按需调大。
//   WORKFLOW_STALE_GRACE_SECS           残留 running 收口阈值秒数；缺省 600（关闭超时时缺省 86400）。
//   WORKFLOW_DB_STATEMENT_TIMEOUT_MS    工作流 Postgres 节点 statement_timeout（毫秒）；缺省 30000。

use std::sync::OnceLock;

fn env_flag(key: &str) -> bool {
    std::env::var(key)
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "on" || v == "yes"
        })
        .unwrap_or(false)
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

/// 是否全局关闭工作流超时（`WORKFLOW_DISABLE_TIMEOUT`）。
pub fn workflow_timeout_disabled() -> bool {
    static V: OnceLock<bool> = OnceLock::new();
    *V.get_or_init(|| env_flag("WORKFLOW_DISABLE_TIMEOUT"))
}

/// 工作流 `timeout_ms <= 0` 时采用的默认整体超时（毫秒，下限 1s）。
pub fn workflow_default_timeout_ms() -> u64 {
    static V: OnceLock<u64> = OnceLock::new();
    *V.get_or_init(|| env_u64("WORKFLOW_DEFAULT_TIMEOUT_MS", 300_000).max(1_000))
}

/// HTTP 节点未显式配置 `timeout_secs`/`timeout` 时的默认超时秒数（0 = 不限）。
/// 全局关闭超时时恒为 0。
pub fn http_default_timeout_secs() -> u64 {
    static V: OnceLock<u64> = OnceLock::new();
    *V.get_or_init(|| {
        if workflow_timeout_disabled() {
            0
        } else {
            env_u64("WORKFLOW_HTTP_DEFAULT_TIMEOUT_SECS", 120)
        }
    })
}

/// code(Lua) 节点单节点执行的墙钟上限（毫秒）。缺省 30000；`0` = 不限。
///
/// 由指令计数 hook 周期性比对 deadline 实现（见 `lua_engine`）——这是防
/// `while true do end` 死循环占死 spawn_blocking 线程的唯一手段，故**不随
/// `WORKFLOW_DISABLE_TIMEOUT` 归零**，需经 `WORKFLOW_LUA_TIMEOUT_MS` 显式调整。
/// 单个 code 节点串行处理多行 + 每行调 LLM/长耗时 HTTP（如 AI 关单逐单调
/// DeepMind）时，缺省 30s 易被强杀，按需调大（同时确认工作流 `timeout_ms`
/// 够大——它是另一道更靠外的闸）。
pub fn lua_node_timeout_ms() -> u64 {
    static V: OnceLock<u64> = OnceLock::new();
    *V.get_or_init(|| env_u64("WORKFLOW_LUA_TIMEOUT_MS", 30_000))
}

/// 工作流 Postgres 节点 `statement_timeout`（毫秒）。缺省 30000。
pub fn workflow_db_statement_timeout_ms() -> u64 {
    static V: OnceLock<u64> = OnceLock::new();
    *V.get_or_init(|| {
        workflow_db_statement_timeout_ms_from(
            std::env::var("WORKFLOW_DB_STATEMENT_TIMEOUT_MS").ok(),
        )
    })
}

/// 可注入 env，便于单测。
pub fn workflow_db_statement_timeout_ms_from(env: Option<String>) -> u64 {
    const DEFAULT: u64 = 30_000;
    match env {
        None => DEFAULT,
        Some(raw) => match raw.trim().parse::<u64>() {
            Ok(v) if v > 0 => v,
            _ => {
                tracing::warn!(
                    "WORKFLOW_DB_STATEMENT_TIMEOUT_MS={:?} 无效，使用默认 {}",
                    raw,
                    DEFAULT
                );
                DEFAULT
            }
        },
    }
}

fn workflow_db_raw_sql_policy() -> crate::raw_sql_guard::RawSqlPolicy {
    let mut policy = crate::raw_sql_guard::RawSqlPolicy::defaults();
    policy.statement_timeout_ms = workflow_db_statement_timeout_ms();
    policy
}

/// 解析工作流整体超时。返回 `None` 表示不限（执行不再包 `tokio::time::timeout`）。
///   - 全局关闭，或 `timeout_ms < 0` → `None`（不限）
///   - `timeout_ms == 0` → 默认值（`WORKFLOW_DEFAULT_TIMEOUT_MS`）
///   - `timeout_ms > 0` → 采用该值（下限 1s）
pub fn resolve_workflow_timeout(workflow_timeout_ms: i32) -> Option<Duration> {
    if workflow_timeout_disabled() || workflow_timeout_ms < 0 {
        return None;
    }
    let ms = if workflow_timeout_ms == 0 {
        workflow_default_timeout_ms()
    } else {
        (workflow_timeout_ms as u64).max(1_000)
    };
    Some(Duration::from_millis(ms))
}

/// 残留 running 收口阈值（秒）。关闭超时时缺省放大到 24h，避免误伤真正在跑的长任务。
pub fn stale_grace_secs() -> i64 {
    static V: OnceLock<i64> = OnceLock::new();
    *V.get_or_init(|| {
        let default = if workflow_timeout_disabled() {
            86_400
        } else {
            600
        };
        std::env::var("WORKFLOW_STALE_GRACE_SECS")
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|n| *n >= 0)
            .unwrap_or(default)
    })
}

/// 网关 ob_ API Key 只读护栏的档位。
///
/// 既是环境变量 `WORKFLOW_APIKEY_RW_GUARD` 的解析结果，也是运行时存入
/// [`ExecutionContext::apikey_write_guard`] 的状态：
/// - `Off`：不启用（等于历史行为）。也用于「无 key / 读写 key / mode=off」时的运行时状态。
/// - `LogOnly`：只读 key 命中 DB 写节点时**不拦**，仅打审计日志（灰度观测）。
/// - `Enforce`：只读 key 命中 DB 写节点时真正拦截（返回 blocked mock）。
///
/// 用单一枚举同时承载「配置档位」与「运行时状态」：`bool` 无法区分 `log_only`
/// （不拦但要打影子日志）与 `off`（什么都不做），故用三态枚举。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ApiKeyWriteGuard {
    #[default]
    Off,
    LogOnly,
    Enforce,
}

impl ApiKeyWriteGuard {
    /// 是否应真正拦截 DB 写（仅 `Enforce`）。
    pub fn should_block_db_write(self) -> bool {
        matches!(self, ApiKeyWriteGuard::Enforce)
    }

    /// 命中 DB 写节点时是否应记审计日志（`LogOnly` 影子命中 + `Enforce` 真拦）。
    pub fn should_log_db_write(self) -> bool {
        matches!(self, ApiKeyWriteGuard::LogOnly | ApiKeyWriteGuard::Enforce)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ApiKeyWriteGuard::Off => "off",
            ApiKeyWriteGuard::LogOnly => "log_only",
            ApiKeyWriteGuard::Enforce => "enforce",
        }
    }
}

/// 解析 `WORKFLOW_APIKEY_RW_GUARD` 配置档位。默认 `log_only`（先观测，最安全）；
/// 脏值告警并回退默认。仅在进程首次读取时求值一次（OnceLock 缓存）。
pub fn apikey_rw_guard_mode() -> ApiKeyWriteGuard {
    static V: OnceLock<ApiKeyWriteGuard> = OnceLock::new();
    *V.get_or_init(|| {
        parse_apikey_rw_guard(std::env::var("WORKFLOW_APIKEY_RW_GUARD").ok().as_deref())
    })
}

/// 纯解析（可注入，便于单测）：缺失 → 默认 `log_only`；脏值告警后回退 `log_only`。
pub fn parse_apikey_rw_guard(raw: Option<&str>) -> ApiKeyWriteGuard {
    match raw {
        None => ApiKeyWriteGuard::LogOnly,
        Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "off" => ApiKeyWriteGuard::Off,
            "log_only" | "logonly" | "log" => ApiKeyWriteGuard::LogOnly,
            "enforce" | "block" | "on" => ApiKeyWriteGuard::Enforce,
            other => {
                tracing::warn!(
                    "WORKFLOW_APIKEY_RW_GUARD={:?} 无效，回退默认 log_only",
                    other
                );
                ApiKeyWriteGuard::LogOnly
            }
        },
    }
}

// ─── DAG 数据模型 ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDefinition {
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub label: Option<String>,
    pub config: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    Code,
    DbQuery,
    DbExecute,
    HttpCall,
    EmailSend,
    Condition,
    Transform,
    Response,
    /// 推送一条 SSE 消息到指定 topic（经全局 publisher，跨实例扇出）。
    SsePublish,
    /// 在单个数据库事务中执行多条 SQL（要么全成功，要么全回滚）。
    DbTransaction,
    /// 遍历数组，对每个元素执行子 SQL 列表（每个 item 独立事务）。
    #[serde(rename = "foreach")]
    ForEach,
    /// 调用另一个工作流（子工作流），同步等待其结果。
    /// config: `{ "workflow": "<slug>", "input": { ...templated... }, "allow_failure": bool }`
    /// 子工作流的 `input` 作为其 trigger_data；其 response 节点输出作为本节点输出。
    CallWorkflow,
    /// Redis 数据源操作（精选命令）。
    /// config: `{ "connection_id": <i64>, "op": "get|set|...", ...templated args... }`
    /// 连接按 `ctx.tenant_id` 校验，杜绝跨租户取数。
    Redis,
    /// Kafka produce。
    /// config: `{ "connection_id": <i64>, "op": "produce", "topic", "key"?, "value", "headers"? }`
    Kafka,
    /// 对象存储（COS / OSS / MinIO）精选操作。
    /// config: `{ "connection_id": <i64>, "op": "put|get|delete|list|presign", ...templated args... }`
    /// 连接按 `ctx.tenant_id` 校验，杜绝跨租户取数。
    ObjectStorage,
    /// 循环节点：反复执行「循环体子图」直到退出，再走 `done` 出口。
    /// config: `{ "loop_mode": "while|until|count|for_each", "expression": "...",
    ///            "max_iterations": <u64>, "delay_ms": <u64>, "count": <u64|template>,
    ///            "items": "{{...}}", "concurrency": <u64>, "allow_failure": bool }`
    /// 出边用 `branch`：`"body"`=循环体入口、`"done"`=循环结束后的后续节点；
    /// 循环体末节点经 `edge_type: "loop_back"`（`target_handle: "back"`）回边连回本节点，
    /// 该回边不参与拓扑排序。循环体内可引用 `{{loop.index}}` / `{{loop.count}}` /
    /// `{{loop.item}}`（for_each）；本节点输出含 `{index,count,reached_max,results,...}`。
    Loop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowEdge {
    pub from: String,
    pub to: String,
    /// condition 节点使用：当 from 节点求值结果匹配此分支标签时走这条边。
    /// loop 节点复用此字段承载出口：`"body"`=循环体入口、`"done"`=循环结束出口。
    pub branch: Option<String>,
    /// 特殊边类型。目前仅 `"loop_back"`（循环体末节点回连 loop 节点的回边）。
    /// 回边**不参与拓扑排序**，由 loop 子解释器识别循环体范围时使用。向后兼容：老数据无此字段=普通边。
    #[serde(default, alias = "edgeType", skip_serializing_if = "Option::is_none")]
    pub edge_type: Option<String>,
    /// 目标 handle id。loop 回边落在目标 loop 节点的 `"back"` handle 上。
    /// 兼容前端 camelCase：反序列化时接受 `targetHandle`。
    #[serde(
        default,
        alias = "targetHandle",
        skip_serializing_if = "Option::is_none"
    )]
    pub target_handle: Option<String>,
}

impl WorkflowEdge {
    /// 普通边（可带 condition/loop 的 branch 标签）。
    #[allow(dead_code)]
    pub fn new(from: impl Into<String>, to: impl Into<String>, branch: Option<String>) -> Self {
        WorkflowEdge {
            from: from.into(),
            to: to.into(),
            branch,
            edge_type: None,
            target_handle: None,
        }
    }

    /// loop 回边：循环体末节点 → loop 节点的 `back` handle，不参与拓扑排序。
    #[allow(dead_code)]
    pub fn loop_back(from: impl Into<String>, to: impl Into<String>) -> Self {
        WorkflowEdge {
            from: from.into(),
            to: to.into(),
            branch: None,
            edge_type: Some(LOOP_BACK_EDGE_TYPE.to_string()),
            target_handle: Some("back".to_string()),
        }
    }

    /// 是否为完整、规范化的循环回边。
    pub fn is_loop_back(&self) -> bool {
        self.edge_type.as_deref() == Some(LOOP_BACK_EDGE_TYPE)
            && self.target_handle.as_deref() == Some("back")
    }
}

/// 循环回边的边类型标识。
pub const LOOP_BACK_EDGE_TYPE: &str = "loop_back";

// ─── 执行上下文 ─────────────────────────────────────────

/// 单次工作流执行的运行时上下文
///
/// 注意：本结构体**手写** `Debug` impl（见下），而非 `#[derive(Debug)]`。
/// 原因是 `env_vars` 装载的是解密后的项目级密钥明文，一旦走 `{:?}` 打印（日志 / panic
/// 回溯）就会泄漏。手写 impl 把 `env_vars` 固定打印为 `<N vars masked>`，从源头封死
/// `{:?}` 这一泄漏面。
#[derive(Clone)]
pub struct ExecutionContext {
    pub workflow_id: i32,
    pub run_id: i64,
    pub trigger_type: String,
    pub trigger_data: JsonValue,
    pub user_id: Option<i32>,
    pub tenant_id: Option<i32>,
    pub database_id: Option<i32>,
    /// 每个已执行节点的输出，key = node_id
    pub node_outputs: HashMap<String, JsonValue>,
    /// 项目（租户）级环境变量，执行开始时按 tenant_id 一次性解密装入。
    /// `{{env.X}}` 模板与 Lua `env.get` 同源读取。明文驻留，仅靠手写 Debug impl 封死打印。
    pub env_vars: HashMap<String, String>,
    /// 工作流级依赖声明，在执行开始时从工作流记录快照，供 JavaScript code 节点解析。
    pub workflow_dependencies: JsonValue,
    /// 干跑模式：跳过有副作用的节点（db_execute / http_call / email_send / sse_publish），
    /// 返回 mock 输出，只验证流程与模板变量。用于编辑态调试。
    pub dry_run: bool,
    /// 生产只读护栏（MCP 调试专用）：副作用节点走 mock 拦截；db_query 包 READ ONLY
    /// 事务真实执行（防数据修改型 CTE 穿透）；Lua 禁 http。仅 MCP debug 路径在
    /// 生产实例（RUST_ENV 非 development/staging/test）置 true，其余路径恒为 false，
    /// 线上运行时行为不变。
    pub prod_readonly: bool,
    /// 网关 ob_ API Key 只读护栏（DB 写维度）。仅 `endpoint` 触发时按请求所带 ob_ key 的
    /// `permissions` 与 `WORKFLOW_APIKEY_RW_GUARD` 档位推导；其余触发路径恒 `Off`。
    ///
    /// 与 `prod_readonly` 的区别：本标志**只**约束 DB 写（db_execute / db_transaction /
    /// foreach 走 blocked mock，db_query 走 READ ONLY 事务），**不**动 http/email/sse。
    pub apikey_write_guard: ApiKeyWriteGuard,
}

impl ExecutionContext {
    /// 是否应真正拦截本次执行的 DB 写节点（只读 key + enforce 档）。
    pub fn should_block_db_write(&self) -> bool {
        self.apikey_write_guard.should_block_db_write()
    }

    /// 命中 DB 写节点时是否应记只读护栏审计日志（log_only 影子 + enforce 真拦）。
    pub fn should_log_db_write(&self) -> bool {
        self.apikey_write_guard.should_log_db_write()
    }
}

/// 手写 Debug：`env_vars` 只打印数量，绝不打印键值，防止密钥经 `{:?}` 泄漏。
impl std::fmt::Debug for ExecutionContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExecutionContext")
            .field("workflow_id", &self.workflow_id)
            .field("run_id", &self.run_id)
            .field("trigger_type", &self.trigger_type)
            .field("trigger_data", &self.trigger_data)
            .field("user_id", &self.user_id)
            .field("tenant_id", &self.tenant_id)
            .field("database_id", &self.database_id)
            .field("node_outputs", &self.node_outputs)
            .field(
                "env_vars",
                &format_args!("<{} vars masked>", self.env_vars.len()),
            )
            .field("workflow_dependencies", &self.workflow_dependencies)
            .field("dry_run", &self.dry_run)
            .field("prod_readonly", &self.prod_readonly)
            .field("apikey_write_guard", &self.apikey_write_guard)
            .finish()
    }
}

/// 单个节点的执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeExecutionResult {
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_type: Option<String>,
    pub status: NodeStatus,
    /// 节点解析模板后的实际入参（占位符已替换）。对 http_call 而言即真正发出去的
    /// url/method/headers/body，用于区分「参数问题」还是「对方响应问题」。
    #[serde(default, skip_serializing_if = "JsonValue::is_null")]
    pub input: JsonValue,
    pub output: JsonValue,
    pub elapsed_ms: u64,
    pub error: Option<String>,
    /// condition 节点使用：选中的分支标签
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Success,
    Failed,
    /// 节点执行失败，但节点配置了 `allow_failure: true`，因此被容错处理：
    /// 记录失败但不中断工作流，后续节点继续执行。区别于 `Failed`（硬失败、中断工作流），
    /// 也不会把整个 run 置为 failed。
    FailedAllowed,
    Skipped,
}

// ─── 模板变量引擎 ─────────────────────────────────────────

/// 导入 / 多一层 JSON 转义后，code 节点脚本会变成「没有真换行、只剩字面 `\n`」。
/// Lua 把两条语句粘在同一行就会报 `unexpected symbol near 'local'`。
///
/// 仅在整段还没有真换行时才还原；已是多行的脚本原样返回。单行里 Lua/JS 字符串
/// 自带的 `\n`（如 `"hello\nworld"`）还原后不像多条语句，也原样返回。
pub fn restore_escaped_script_newlines(code: &str) -> String {
    if code.contains('\n') || code.contains('\r') || !code.contains('\\') {
        return code.to_string();
    }
    let restored = unescape_json_string_escapes(code);
    if restored != code && looks_like_restored_multiline_script(&restored) {
        restored
    } else {
        code.to_string()
    }
}

fn unescape_json_string_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some('\'') => out.push('\''),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn looks_like_restored_multiline_script(s: &str) -> bool {
    let lines: Vec<&str> = s
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.len() < 2 {
        return false;
    }
    const LEADERS: &[&str] = &[
        "local ",
        "function ",
        "end",
        "return ",
        "if ",
        "for ",
        "while ",
        "repeat",
        "--",
        "ctx.",
        "const ",
        "let ",
        "var ",
        "def ",
        "async ",
        "import ",
        "#",
    ];
    lines
        .iter()
        .filter(|line| LEADERS.iter().any(|prefix| line.starts_with(prefix)))
        .count()
        >= 2
}

/// 导入落库前：把 code 节点 `config.code` 里被吃成字面 `\n` 的换行还原回来，
/// 避免编辑器里看到一整行、运行时 lua.load 再炸。
pub fn restore_script_newlines_in_nodes(nodes: &mut JsonValue) {
    let Some(arr) = nodes.as_array_mut() else {
        return;
    };
    for node in arr {
        let is_code = node
            .get("type")
            .and_then(|t| t.as_str())
            .is_some_and(|t| t == "code");
        if !is_code {
            continue;
        }
        let Some(code) = node
            .get("config")
            .and_then(|c| c.get("code"))
            .and_then(|c| c.as_str())
            .map(str::to_string)
        else {
            continue;
        };
        let restored = restore_escaped_script_newlines(&code);
        if restored == code {
            continue;
        }
        if let Some(cfg) = node.get_mut("config").and_then(|c| c.as_object_mut()) {
            cfg.insert("code".into(), JsonValue::String(restored));
        }
    }
}

/// 按节点类型解析 config 模板。code 的脚本正文、SQL、call_workflow.input
/// 必须跳过字符串替换，其余字段照常。
fn resolve_node_config(
    node_type: &NodeType,
    config: &JsonValue,
    ctx: &ExecutionContext,
) -> JsonValue {
    match node_type {
        NodeType::DbQuery | NodeType::DbExecute | NodeType::DbTransaction => {
            resolve_template_skip_keys(config, ctx, &["sql"])
        }
        NodeType::CallWorkflow => resolve_template_skip_keys(config, ctx, &["input"]),
        NodeType::Code => resolve_template_skip_keys(config, ctx, &["code"]),
        _ => resolve_template(config, ctx),
    }
}

/// 解析并替换 `{{nodeId.field}}` 模板变量
///
/// 支持嵌套路径：`{{nodeA.data.items[0].name}}`
pub fn resolve_template(template: &JsonValue, ctx: &ExecutionContext) -> JsonValue {
    match template {
        JsonValue::String(s) => resolve_string_template(s, ctx),
        JsonValue::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (k, v) in map {
                new_map.insert(k.clone(), resolve_template(v, ctx));
            }
            JsonValue::Object(new_map)
        }
        JsonValue::Array(arr) => {
            JsonValue::Array(arr.iter().map(|v| resolve_template(v, ctx)).collect())
        }
        other => other.clone(),
    }
}

fn resolve_string_template(s: &str, ctx: &ExecutionContext) -> JsonValue {
    // 如果整个字符串就是一个模板表达式，返回原始类型（不强制 string）
    let trimmed = s.trim();
    if trimmed.starts_with("{{") && trimmed.ends_with("}}") && trimmed.matches("{{").count() == 1 {
        let path = trimmed[2..trimmed.len() - 2].trim();
        return resolve_path(path, ctx);
    }

    // 混合模式：字符串中嵌入多个 {{...}}，全部替换为字符串
    let mut result = s.to_string();
    while let Some(start) = result.find("{{") {
        if let Some(end) = result[start..].find("}}") {
            let full_end = start + end + 2;
            let path = result[start + 2..start + end].trim();
            let val = resolve_path(path, ctx);
            let replacement = match &val {
                JsonValue::String(s) => s.clone(),
                JsonValue::Null => "".to_string(),
                other => other.to_string(),
            };
            result.replace_range(start..full_end, &replacement);
        } else {
            break;
        }
    }
    JsonValue::String(result)
}

/// 解析模板，但**跳过指定 key 的字符串值**（保持原文不做字符串替换）。
///
/// 专为 DB 节点而设：SQL 文本里的 `{{...}}` 绝不能走字符串替换拼进语句（那是 SQL
/// 注入面），必须保持原样交给 [`parameterize_sql_templates`] 改写成参数占位符再绑定。
/// 其余字段（`params` / `database_id` / `statements[].params` 等）照常递归解析。
///
/// 递归时按 key 名跳过，因此对 `db_transaction` 的 `statements[].sql` 同样生效
/// （每个 statement 对象都有 `sql` key）。
fn resolve_template_skip_keys(
    template: &JsonValue,
    ctx: &ExecutionContext,
    skip_keys: &[&str],
) -> JsonValue {
    match template {
        JsonValue::String(s) => resolve_string_template(s, ctx),
        JsonValue::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (k, v) in map {
                if skip_keys.contains(&k.as_str()) {
                    // 原样保留（含其内部可能的 {{}}），不做任何替换。
                    new_map.insert(k.clone(), v.clone());
                } else {
                    new_map.insert(k.clone(), resolve_template_skip_keys(v, ctx, skip_keys));
                }
            }
            JsonValue::Object(new_map)
        }
        JsonValue::Array(arr) => JsonValue::Array(
            arr.iter()
                .map(|v| resolve_template_skip_keys(v, ctx, skip_keys))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// 把 SQL 文本里的内联模板 `{{expr}}` 改写成参数占位符 `$N`，并按出现顺序收集
/// 需要绑定的值。占位符编号从 `start_index` 开始（与显式 `params` 数组共存时避免冲突）。
///
/// **这是修复 SQL 注入的核心**：用户可控的模板值（如 `{{trigger.email}}`）永远只作为
/// 绑定参数进入数据库，绝不拼接进 SQL 文本，从根上杜绝把输入当代码执行。
///
/// 扫描时区分"是否处于字符串字面量内"（正确处理 `''` 转义引号），对两类位置分别处理：
///   - **字面量外**的 `{{expr}}` → 裸 `$N`
///     - `WHERE id = {{trigger.id}}` → `WHERE id = $N`
///   - **字面量内**的 `{{expr}}` → 切开字面量，用 `||` 拼接 `$N`（占位符不能出现在
///     字符串字面量内部，否则会被当成字面文本）：
///     - `WHERE email = '{{trigger.email}}'`  → `WHERE email = $N`（整段即模板时直接裸 `$N`）
///     - `WHERE name LIKE '%{{kw}}%'`          → `WHERE name LIKE ('%' || $N || '%')`
///     - `VALUES ('Hi {{name}}, welcome')`     → `VALUES (('Hi ' || $N || ', welcome'))`
///
/// 拼接出的多段表达式整体用括号包裹，避免与 `LIKE` / `=` 等的运算符优先级纠缠。
/// 未闭合的 `{{` 或未闭合的字符串字面量原样保留（不静默拼接），交由数据库报错。
fn parameterize_sql_templates(
    raw_sql: &str,
    ctx: &ExecutionContext,
    start_index: usize,
) -> (String, Vec<JsonValue>) {
    let mut out = String::with_capacity(raw_sql.len());
    let mut binds: Vec<JsonValue> = Vec::new();
    let mut idx = start_index;
    let mut rest = raw_sql;

    loop {
        let quote = rest.find('\'');
        let tmpl = rest.find("{{");
        // 取较早出现者：引号先到则进入字面量重写，{{ 先到则按裸模板处理。
        let hit_quote = match (quote, tmpl) {
            (None, None) => {
                out.push_str(rest);
                break;
            }
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (Some(q), Some(t)) => q <= t,
        };

        if hit_quote {
            let q = quote.unwrap();
            out.push_str(&rest[..q]);
            // 仅当被引号包裹的整段模板恰好处于"比较/赋值运算符右侧"（如 `a.id = '{{x}}'`）时，
            // 才把数字串还原成数值——这种位置往往直接对着某个列，需要数值类型。若它是函数实参
            // （如 `NULLIF('{{x}}', '')` / `CAST('{{x}}' AS ...)`，前面是 `(`），作者通常按文本
            // 处理并自行 cast，绝不能擅自转数值，否则 `NULLIF(bigint, '')` 会把 '' 当 bigint 报错。
            let comparison_context = ends_with_sql_comparison(&out);
            match rewrite_string_literal(&rest[q..], comparison_context, ctx, &mut idx, &mut binds)
            {
                Some((rewritten, consumed)) => {
                    out.push_str(&rewritten);
                    rest = &rest[q + consumed..];
                }
                None => {
                    // 未闭合字符串字面量：原样输出剩余，结束。
                    out.push_str(&rest[q..]);
                    break;
                }
            }
        } else {
            let t = tmpl.unwrap();
            out.push_str(&rest[..t]);
            let after_open = &rest[t + 2..];
            match after_open.find("}}") {
                Some(close) => {
                    let expr = after_open[..close].trim();
                    // 裸（未加引号）模板 = 未加引号字面量语境：作者本意是数值/标识符。
                    // 把"看起来是数字"的字符串还原成数值再绑定，否则 `integer = $N`(text)
                    // 会因缺少 `integer = text` 运算符而报错（详见 coerce_bare_sql_value）。
                    binds.push(coerce_bare_sql_value(resolve_path(expr, ctx)));
                    out.push('$');
                    out.push_str(&idx.to_string());
                    idx += 1;
                    rest = &after_open[close + 2..];
                }
                None => {
                    // 未闭合的 {{：原样输出剩余，结束。
                    out.push_str(&rest[t..]);
                    break;
                }
            }
        }
    }
    (out, binds)
}

/// 重写一段以单引号开头的字符串字面量，把其中内联的 `{{expr}}` 改成绑定参数。
///
/// `s` 必须以 `'` 起头。返回 `(改写后的表达式, 在 s 中消费掉的字节数)`，消费长度覆盖到
/// 闭合引号之后；若字面量未闭合返回 `None`（调用方原样输出）。
///
/// 规则：
///   - 字面量内不含模板 → 原样返回（字节不变，含 `''` 转义）。
///   - 含模板 → 拆成 `'文本' || $N || '文本'` 形式；空文本段省略；整段即单个模板时返回裸 `$N`；
///     多段拼接整体加括号。文本段里的 `'` 按 SQL 规则转义为 `''`。
///
/// 仅在确认字面量闭合后才向 `binds` 推值、推进 `idx`，保证 `None` 分支不产生副作用。
///
/// `comparison_context` 表示该字面量是否紧跟在比较/赋值运算符之后；仅当它为 true 且整段就是
/// 单个模板时，才对数字串做数值还原（见 `coerce_quoted_sql_value`）。
fn rewrite_string_literal(
    s: &str,
    comparison_context: bool,
    ctx: &ExecutionContext,
    idx: &mut usize,
    binds: &mut Vec<JsonValue>,
) -> Option<(String, usize)> {
    enum Seg<'a> {
        Text(String),
        Tmpl(&'a str),
    }

    let body = &s[1..];
    let mut parts: Vec<Seg> = Vec::new();
    let mut cur = String::new();
    let mut j = 0usize;

    let consumed = loop {
        let b = &body[j..];
        let q = b.find('\'');
        let t = b.find("{{");
        let take_quote = match (q, t) {
            (None, None) => return None, // 未闭合字面量
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (Some(qq), Some(tt)) => qq <= tt,
        };

        if take_quote {
            let p = q.unwrap();
            // 紧跟另一个单引号 → '' 转义，代表一个字面 '，留在字面量内继续扫描。
            if b.as_bytes().get(p + 1) == Some(&b'\'') {
                cur.push_str(&b[..p]);
                cur.push('\'');
                j += p + 2;
            } else {
                // 闭合引号。
                cur.push_str(&b[..p]);
                parts.push(Seg::Text(std::mem::take(&mut cur)));
                j += p + 1;
                break 1 + j;
            }
        } else {
            let p = t.unwrap();
            let after_open = &b[p + 2..];
            // 模板的 }} 必须出现在下一个闭合引号之前，否则这个 {{ 只是字面量里的普通文本
            // （如 'it''s {{ ok'），不能把后面别处的 }} 吞进来当模板。
            let close = after_open.find("}}").filter(|c| match q {
                Some(qq) => p + 2 + c < qq,
                None => false,
            });
            match close {
                Some(close) => {
                    cur.push_str(&b[..p]);
                    parts.push(Seg::Text(std::mem::take(&mut cur)));
                    parts.push(Seg::Tmpl(after_open[..close].trim()));
                    j += p + 2 + close + 2;
                }
                None => {
                    // 不是字面量内的有效模板：把 {{ 当普通文本，继续找闭合引号。
                    cur.push_str(&b[..p + 2]);
                    j += p + 2;
                }
            }
        }
    };

    // 不含模板 → 原样返回（保持字节不变）。
    if !parts.iter().any(|seg| matches!(seg, Seg::Tmpl(_))) {
        return Some((s[..consumed].to_string(), consumed));
    }

    // 整段字面量恰好就是单个模板（`'{{x}}'`，无其它文本段）时，等价于旧版的 `'值'` 字面量
    // ——Postgres 会按上下文把它从 unknown 强转（如和 integer 列比较）。但参数化后按 text 绑定
    // 就会变成 `integer = text` 报错。因此这种情形按"被引号包裹"语境做保守的数值还原
    // （只认无前导零的规范整数/小数，保住 '007' 这类零填充编码仍当文本）。
    // 反之，模板和其它文本段用 `||` 拼接（如 `'%{{x}}%'`）时，结果必然是文本，绝不还原。
    let tmpl_count = parts.iter().filter(|s| matches!(s, Seg::Tmpl(_))).count();
    let nonempty_text = parts
        .iter()
        .any(|s| matches!(s, Seg::Text(t) if !t.is_empty()));
    let whole_literal_is_single_template = tmpl_count == 1 && !nonempty_text;
    let coerce = whole_literal_is_single_template && comparison_context;

    let mut exprs: Vec<String> = Vec::new();
    for seg in &parts {
        match seg {
            Seg::Text(txt) => {
                if !txt.is_empty() {
                    exprs.push(format!("'{}'", txt.replace('\'', "''")));
                }
            }
            Seg::Tmpl(expr) => {
                let value = resolve_path(expr, ctx);
                let value = if coerce {
                    coerce_quoted_sql_value(value)
                } else {
                    value
                };
                binds.push(value);
                exprs.push(format!("${idx}"));
                *idx += 1;
            }
        }
    }

    let rewritten = match exprs.len() {
        0 => "''".to_string(),
        1 => exprs.pop().unwrap(),
        _ => format!("({})", exprs.join(" || ")),
    };
    Some((rewritten, consumed))
}

// ─── MySQL 文本协议（COM_QUERY）内联参数 ─────────────────────────────
//
// Doris / StarRocks 等 MySQL 协议兼容引擎的**预编译协议**与 sqlx 不兼容
// （COM_STMT_PREPARE 响应字节数不符，报 "PrepareOk expected 12 bytes but got 10"），
// 故 MySQL 一律走文本协议（sqlx::raw_sql，不预编译），把参数值**安全转义后内联**进 SQL。
// 转义覆盖 `\`、`'` 与常见控制符，杜绝 SQL 注入（等价于 mysql_real_escape_string）。

/// 转义要放进 MySQL 单引号字符串内部的原始文本（不含外层引号）。
fn mysql_escape_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\x1a' => out.push_str("\\Z"),
            _ => out.push(c),
        }
    }
    out
}

/// JSON 值 → MySQL 字面量（用于字符串字面量**之外**的位置）。
fn json_to_mysql_literal(v: &JsonValue) -> String {
    match v {
        JsonValue::Null => "NULL".to_string(),
        JsonValue::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::String(s) => format!("'{}'", mysql_escape_str(s)),
        // 数组/对象：序列化成 JSON 文本再当字符串字面量（供 JSON 列 / 文本列使用）
        other => format!("'{}'", mysql_escape_str(&other.to_string())),
    }
}

/// JSON 值 → 放进**已在引号内**的字符串字面量里的内容（不加外层引号）。
fn json_to_mysql_inner(v: &JsonValue) -> String {
    match v {
        JsonValue::String(s) => mysql_escape_str(s),
        JsonValue::Null => String::new(),
        JsonValue::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        JsonValue::Number(n) => n.to_string(),
        other => mysql_escape_str(&other.to_string()),
    }
}

/// 内联改写一段以 `'` 开头的字符串字面量：把其中 `{{expr}}` 换成转义后的值，
/// 仍保持单个 `'...'` 字面量（MySQL 会自动做字符串↔数值的比较转换，无需拆 CONCAT）。
/// 返回 (改写后字面量, 消费字节数)；未闭合返回 None。
fn mysql_inline_string_literal(s: &str, ctx: &ExecutionContext) -> Option<(String, usize)> {
    let body = &s[1..];
    let mut out = String::from("'");
    let mut j = 0usize;
    loop {
        let b = &body[j..];
        let q = b.find('\'');
        let t = b.find("{{");
        let take_quote = match (q, t) {
            (None, None) => return None,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (Some(qq), Some(tt)) => qq <= tt,
        };
        if take_quote {
            let p = q.unwrap();
            if b.as_bytes().get(p + 1) == Some(&b'\'') {
                // '' 转义：原样保留
                out.push_str(&b[..p]);
                out.push_str("''");
                j += p + 2;
            } else {
                out.push_str(&b[..p]);
                out.push('\'');
                j += p + 1;
                return Some((out, 1 + j));
            }
        } else {
            let p = t.unwrap();
            let after_open = &b[p + 2..];
            let close = after_open.find("}}").filter(|c| match q {
                Some(qq) => p + 2 + c < qq,
                None => false,
            });
            match close {
                Some(c) => {
                    out.push_str(&b[..p]);
                    let expr = after_open[..c].trim();
                    out.push_str(&json_to_mysql_inner(&resolve_path(expr, ctx)));
                    j += p + 2 + c + 2;
                }
                None => {
                    out.push_str(&b[..p + 2]);
                    j += p + 2;
                }
            }
        }
    }
}

/// 为 MySQL 文本协议内联所有参数：`?`（按顺序取 explicit_params）与 `{{expr}}`（模板）
/// 全部替换成转义后的字面量。单引号字符串内的 `?` 视为字面文本，`{{expr}}` 则内联。
fn mysql_inline_sql(
    raw_sql: &str,
    ctx: &ExecutionContext,
    explicit_params: &[JsonValue],
) -> String {
    let mut out = String::with_capacity(raw_sql.len() + 32);
    let mut rest = raw_sql;
    let mut pi = 0usize;
    loop {
        let quote = rest.find('\'');
        let tmpl = rest.find("{{");
        let ph = rest.find('?');
        let next = [quote, tmpl, ph].into_iter().flatten().min();
        let Some(pos) = next else {
            out.push_str(rest);
            break;
        };

        if Some(pos) == quote {
            out.push_str(&rest[..pos]);
            match mysql_inline_string_literal(&rest[pos..], ctx) {
                Some((rewritten, consumed)) => {
                    out.push_str(&rewritten);
                    rest = &rest[pos + consumed..];
                }
                None => {
                    out.push_str(&rest[pos..]);
                    break;
                }
            }
        } else if Some(pos) == tmpl {
            out.push_str(&rest[..pos]);
            let after_open = &rest[pos + 2..];
            match after_open.find("}}") {
                Some(close) => {
                    let expr = after_open[..close].trim();
                    out.push_str(&json_to_mysql_literal(&resolve_path(expr, ctx)));
                    rest = &after_open[close + 2..];
                }
                None => {
                    out.push_str(&rest[pos..]);
                    break;
                }
            }
        } else {
            // '?' 占位符（字符串外）：按序取 explicit_params
            out.push_str(&rest[..pos]);
            let v = explicit_params.get(pi).cloned().unwrap_or(JsonValue::Null);
            pi += 1;
            out.push_str(&json_to_mysql_literal(&v));
            rest = &rest[pos + 1..];
        }
    }
    out
}

/// 把"裸内联模板"解析出的值，按未加引号字面量的语境做最小必要的类型还原。
///
/// 背景：sqlx 把绑定参数的类型 OID 一并发给 Postgres，`&str` 会被声明成 `text`，于是
/// `WHERE id = $N`（id 为 integer）变成 `integer = text` —— Postgres 没有这个运算符、
/// 也不会隐式把 `text` 绑定值转成 integer，直接报 `operator does not exist: integer = text`。
/// 而旧版字符串插值把 `{{id}}`（值 "42"）直接拼成未加引号的 `42`，被当作数值字面量解析，
/// 所以一直是好的。
///
/// 因此：**只有未被单引号包裹**的裸模板才走这里——作者没加引号即表示"数值/标识符"语境，
/// 把"整洁的十进制整数/小数字符串"还原成 JSON 数值（绑定为 int8/float8，可与 integer/
/// numeric 列正常比较）。非数字串保持原样按 text 绑定（`col = {{x}}` 比较文本列仍可用）。
/// 被引号包裹的 `'{{x}}'` 不经此函数，保持 text 语义（作者显式要的是字符串）。
fn coerce_bare_sql_value(val: JsonValue) -> JsonValue {
    let JsonValue::String(s) = &val else {
        return val;
    };
    let t = s.trim();
    if let Ok(i) = t.parse::<i64>() {
        return JsonValue::from(i);
    }
    // 仅当是"纯十进制小数"（可选前导负号、恰一个小数点、两侧都有数字）才转浮点，
    // 避免把 "NaN"/"inf"/"1e5"/"007abc" 之类被 f64::parse 宽松接受的串误判。
    if is_plain_decimal(t) {
        if let Ok(f) = t.parse::<f64>() {
            if let Some(n) = serde_json::Number::from_f64(f) {
                return JsonValue::Number(n);
            }
        }
    }
    val
}

/// 把"被单引号整段包裹的模板"（`'{{x}}'`）解析出的值做**保守**的数值还原。
///
/// 这类写法等价于旧版的 `'值'` 字面量：Postgres 旧行为按上下文从 unknown 强转，所以
/// `WHERE a.id = '{{article_id}}'`（id 为 integer、值是字符串 "12345"）一直能用；参数化后
/// 按 text 绑定就会 `integer = text` 报错。
///
/// 与裸语境（`coerce_bare_sql_value`）不同，作者显式加了引号往往意味着"可能是文本"，因此这里
/// 只还原**规范数字**：无前导零的整数（`is_canonical_int`，保住 `'007'` 这种零填充编码当文本）
/// 与纯十进制小数。其余（含前导零、含字母、普通文本如 'en'）一律保持 text 绑定。
///
/// 另外只有在"比较/赋值右侧"语境才会被调用（见 `rewrite_string_literal` 的 `comparison_context`）：
/// 函数实参位置（如 `NULLIF('{{x}}','')` / `CAST('{{x}}' AS bigint)`）不走这里，保持文本，
/// 避免把作者显式按文本处理 + 自行 cast 的写法改坏。
fn coerce_quoted_sql_value(val: JsonValue) -> JsonValue {
    let JsonValue::String(s) = &val else {
        return val;
    };
    let t = s.trim();
    if is_canonical_int(t) {
        if let Ok(i) = t.parse::<i64>() {
            return JsonValue::from(i);
        }
    }
    if is_plain_decimal(t) {
        if let Ok(f) = t.parse::<f64>() {
            if let Some(n) = serde_json::Number::from_f64(f) {
                return JsonValue::Number(n);
            }
        }
    }
    val
}

/// 判断字符串是否为"规范十进制整数"：可选前导 `-`，其后是单个 `0` 或不以 `0` 打头的数字串。
/// 借"无前导零"区分数值 ID（`42` → 还原）与零填充编码（`007` → 保持文本）。
fn is_canonical_int(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    if body == "0" {
        return true;
    }
    !body.is_empty() && body.as_bytes()[0] != b'0' && body.bytes().all(|b| b.is_ascii_digit())
}

/// 判断一段 SQL 文本是否以"比较/赋值运算符"结尾（忽略尾随空白），用于判断紧随其后的
/// `'{{x}}'` 是否处于"直接对着某列比较"的语境。
///
/// 覆盖 `=`、`<`、`>`、`<=`、`>=`、`<>`、`!=`（均以 `=`/`<`/`>` 收尾）；显式排除 JSON/位移
/// 运算符 `->`、`->>`、`>>`、`<<`（它们也以 `>`/`<` 收尾，但右操作数应当是文本键，不能转数值）。
fn ends_with_sql_comparison(s: &str) -> bool {
    let b = s.trim_end().as_bytes();
    let n = b.len();
    if n == 0 {
        return false;
    }
    match b[n - 1] {
        b'=' => true,
        // `>`：排除 `->`（n-2 为 `-`）与 `>>`（n-2 为 `>`）；`<>` 的 n-2 是 `<`，仍判为比较。
        b'>' => !(n >= 2 && (b[n - 2] == b'-' || b[n - 2] == b'>')),
        // `<`：排除 `<<`（n-2 为 `<`）。
        b'<' => !(n >= 2 && b[n - 2] == b'<'),
        _ => false,
    }
}

/// 判断字符串是否为"纯十进制小数"：可选前导 `-`、恰好一个 `.`、小数点两侧都至少一位数字，
/// 其余字符全是 ASCII 数字。整数交由调用方先用 `i64` 处理，这里只覆盖带小数点的形态。
fn is_plain_decimal(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    let mut parts = body.split('.');
    let (Some(int_part), Some(frac_part), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !int_part.is_empty()
        && !frac_part.is_empty()
        && int_part.bytes().all(|b| b.is_ascii_digit())
        && frac_part.bytes().all(|b| b.is_ascii_digit())
}

/// 执行输出脱敏：把 JSON 中出现的环境变量值全部替换为 `***`
///
/// 策略——**宁多勿漏的全量值掩码**：遍历 `value` 里的每个字符串字段，对每个长度 ≥ 4 的
/// 变量值做子串替换。不追踪"实际使用过"的子集，因为密钥可能经任意节点（http header /
/// email 正文 / db 参数）流出，全量掩码严格更安全且对现有不可变引用链零侵入。
///
/// 实现：递归遍历 JSON，只对**字符串节点的原始值**做子串替换。相比早期的
/// "整体序列化 → 文本替换 → 反序列化"，直接作用于反转义后的字符串，规避了 JSON
/// 转义导致的漏网（值含 `"` / `\` 时序列化文本里匹配不到）；同时省去一次序列化往返。
///
/// 密钥按**长度降序**替换：短值是长值子串时（如 `sk_live` 之于 `sk_live_2024`），
/// 先掩长值才不会把长值打成 `***_2024` 泄漏残余后缀。
///
/// 已知边界（文档已注明）：变量值被节点二次加工（base64 / 截断 / 拼接）后，
/// 精确子串匹配不到 → 漏网。跳过长度 < 4 的值，避免把 "ok"/"id" 误掩成 `***`。
pub fn mask_env_values(value: &JsonValue, env_vars: &HashMap<String, String>) -> JsonValue {
    let mut secrets: Vec<&str> = env_vars
        .values()
        .filter(|v| v.len() >= 4)
        .map(|s| s.as_str())
        .collect();
    if secrets.is_empty() {
        return value.clone();
    }
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    mask_in_value(value, &secrets)
}

/// `mask_env_values` 的递归核心：仅替换字符串叶子节点，结构原样保留。
fn mask_in_value(value: &JsonValue, secrets: &[&str]) -> JsonValue {
    match value {
        JsonValue::String(s) => {
            let mut out = s.clone();
            for secret in secrets {
                if out.contains(secret) {
                    out = out.replace(secret, "***");
                }
            }
            JsonValue::String(out)
        }
        JsonValue::Array(arr) => {
            JsonValue::Array(arr.iter().map(|v| mask_in_value(v, secrets)).collect())
        }
        JsonValue::Object(map) => JsonValue::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), mask_in_value(v, secrets)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn resolve_path(path: &str, ctx: &ExecutionContext) -> JsonValue {
    // 特殊前缀
    if path.starts_with("trigger.") {
        return json_path_lookup(&ctx.trigger_data, &path["trigger.".len()..]);
    }
    if path == "trigger" {
        return ctx.trigger_data.clone();
    }

    // env. 命名空间：{{env.X}} → 项目级环境变量。未定义返回空串（而非 Null），
    // 与"密钥未配置时模板渲染为空"的预期一致；同时 warn 便于定位漏录变量。
    // condition 表达式与 SSE 模板都经由 resolve_string_template → resolve_path，自动生效。
    if let Some(var_name) = path.strip_prefix("env.") {
        return match ctx.env_vars.get(var_name) {
            Some(v) => JsonValue::String(v.clone()),
            None => {
                tracing::warn!(
                    var = var_name,
                    "模板引用了未定义的环境变量 {{env.X}}，已渲染为空串"
                );
                JsonValue::String(String::new())
            }
        };
    }

    // nodeId.field 格式
    let (node_id, field_path) = match path.find('.') {
        Some(pos) => (&path[..pos], &path[pos + 1..]),
        None => {
            return ctx
                .node_outputs
                .get(path)
                .cloned()
                .unwrap_or(JsonValue::Null);
        }
    };

    match ctx.node_outputs.get(node_id) {
        Some(output) => json_path_lookup(output, field_path),
        None => JsonValue::Null,
    }
}

/// 简易 JSON 路径查找：支持 `a.b.c` 和 `a[0].b` 格式
fn json_path_lookup(value: &JsonValue, path: &str) -> JsonValue {
    let mut current = value;
    for segment in PathSegmentIter::new(path) {
        match segment {
            PathSegment::Key(key) => {
                current = match current.get(key) {
                    Some(v) => v,
                    None => return JsonValue::Null,
                };
            }
            PathSegment::Index(idx) => {
                current = match current.get(idx) {
                    Some(v) => v,
                    None => return JsonValue::Null,
                };
            }
        }
    }
    current.clone()
}

enum PathSegment<'a> {
    Key(&'a str),
    Index(usize),
}

struct PathSegmentIter<'a> {
    remaining: &'a str,
}

impl<'a> PathSegmentIter<'a> {
    fn new(path: &'a str) -> Self {
        Self { remaining: path }
    }
}

impl<'a> Iterator for PathSegmentIter<'a> {
    type Item = PathSegment<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining.is_empty() {
            return None;
        }

        // 处理数组索引 `[N]`
        if self.remaining.starts_with('[') {
            if let Some(end) = self.remaining.find(']') {
                let idx_str = &self.remaining[1..end];
                self.remaining = &self.remaining[end + 1..];
                if self.remaining.starts_with('.') {
                    self.remaining = &self.remaining[1..];
                }
                if let Ok(idx) = idx_str.parse::<usize>() {
                    return Some(PathSegment::Index(idx));
                }
            }
        }

        // 处理 key 段
        let (key, rest) = match self.remaining.find(|c| c == '.' || c == '[') {
            Some(pos) => {
                let key = &self.remaining[..pos];
                let rest = if self.remaining.as_bytes()[pos] == b'.' {
                    &self.remaining[pos + 1..]
                } else {
                    &self.remaining[pos..]
                };
                (key, rest)
            }
            None => (self.remaining, ""),
        };
        self.remaining = rest;
        if key.is_empty() {
            self.next()
        } else {
            Some(PathSegment::Key(key))
        }
    }
}

// ─── DAG 拓扑排序 ─────────────────────────────────────────

/// 对 DAG 执行拓扑排序，返回按依赖顺序排列的节点 ID 列表。
/// 如果图存在环，返回错误。
///
/// loop 节点的回边（`edge_type == "loop_back"`）是**有意成环**的，不参与拓扑排序——
/// 否则 while/until/count/for_each 这类循环会被误判为「循环依赖」。剔除回边后，其余边
/// 仍需构成 DAG（真实的误连环照样会被检测到）。
pub fn topological_sort(def: &WorkflowDefinition) -> Result<Vec<String>> {
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();

    for node in &def.nodes {
        in_degree.entry(node.id.as_str()).or_insert(0);
        adjacency.entry(node.id.as_str()).or_default();
    }

    let loop_ids: HashSet<&str> = def
        .nodes
        .iter()
        .filter(|node| node.node_type == NodeType::Loop)
        .map(|node| node.id.as_str())
        .collect();
    for edge in &def.edges {
        // 回边不参与拓扑（循环由 loop 子解释器在运行时驱动，见 run_loop）。
        if edge.is_loop_back() && loop_ids.contains(edge.to.as_str()) {
            continue;
        }
        adjacency
            .entry(edge.from.as_str())
            .or_default()
            .push(edge.to.as_str());
        *in_degree.entry(edge.to.as_str()).or_insert(0) += 1;
    }

    let mut queue: VecDeque<&str> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(&id, _)| id)
        .collect();

    let mut sorted = Vec::with_capacity(def.nodes.len());

    while let Some(node_id) = queue.pop_front() {
        sorted.push(node_id.to_string());
        if let Some(neighbors) = adjacency.get(node_id) {
            for &neighbor in neighbors {
                if let Some(deg) = in_degree.get_mut(neighbor) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(neighbor);
                    }
                }
            }
        }
    }

    if sorted.len() != def.nodes.len() {
        return Err(AppError::InvalidQuery(
            "工作流 DAG 包含循环依赖，无法执行".to_string(),
        ));
    }

    Ok(sorted)
}

/// 获取 condition 节点在给定 branch 下的后继节点 ID 集合
fn get_branch_successors(def: &WorkflowDefinition, node_id: &str, branch: &str) -> HashSet<String> {
    def.edges
        .iter()
        .filter(|e| e.from == node_id && e.branch.as_deref() == Some(branch))
        .map(|e| e.to.clone())
        .collect()
}

/// 沿普通边收集可达节点；loop_back 不属于正向控制流。
fn collect_reachable(def: &WorkflowDefinition, starts: &HashSet<String>) -> HashSet<String> {
    let mut reachable = HashSet::new();
    let mut queue: VecDeque<String> = starts.iter().cloned().collect();
    while let Some(node_id) = queue.pop_front() {
        if !reachable.insert(node_id.clone()) {
            continue;
        }
        for edge in &def.edges {
            if edge.from == node_id && !edge.is_loop_back() {
                queue.push_back(edge.to.clone());
            }
        }
    }
    reachable
}

/// 获取某节点的所有无条件后继（branch == None 的边）
#[allow(dead_code)]
fn get_default_successors(def: &WorkflowDefinition, node_id: &str) -> HashSet<String> {
    def.edges
        .iter()
        .filter(|e| e.from == node_id && e.branch.is_none())
        .map(|e| e.to.clone())
        .collect()
}

// ─── 循环（loop）规划 ─────────────────────────────────────
//
// loop 节点在画布上不是「容器」，而是靠三种连线界定循环体：
//   - body 出边：`{from: loop, to: 循环体首节点, branch: "body"}`
//   - done 出边：`{from: loop, to: 后续节点, branch: "done"}`
//   - loop_back 回边：`{from: 循环体末节点, to: loop, edge_type: "loop_back"}`
// 「循环体」= 从 body 首节点出发、沿非回边前向可达、且不回到 loop 自身的全部节点。
// 主 DAG 执行时这些循环体节点被 loop「拥有」（owned），不在顶层逐节点执行，而是由
// run_loop 反复执行；本模块负责在执行/校验前把这套拓扑关系解析成 LoopPlan。

/// loop 出口 branch 标签：进入循环体。
const LOOP_BODY_BRANCH: &str = "body";
/// loop 出口 branch 标签：循环结束后的后续节点。
const LOOP_DONE_BRANCH: &str = "done";
/// while/until 模式未显式配置 max_iterations 时的兜底安全上限（校验一般已强制配置）。
const DEFAULT_LOOP_MAX_ITERATIONS: u64 = 100;
/// 所有循环模式均不可绕过的服务端硬上限。
const HARD_LOOP_MAX_ITERATIONS: u64 = 1_000;
/// for_each 模式并发数的服务端硬上限（防止耗尽 DB 连接池 / 打爆下游）。
const HARD_LOOP_MAX_CONCURRENCY: u64 = 8;
/// 详细迭代执行报告最多保留前 N 轮，避免 workflow_runs 无界膨胀。
const MAX_LOOP_ITERATION_REPORTS: usize = 100;

#[derive(Debug, Clone)]
struct DirectLoopRegion {
    body_entries: Vec<String>,
    back_source: String,
    body_nodes: HashSet<String>,
}

/// 单个 loop 节点的循环体拓扑信息。
#[derive(Debug, Clone)]
struct LoopRegion {
    /// 循环体入口（body 出边的目标，通常恰好 1 个）。
    #[allow(dead_code)]
    body_entries: Vec<String>,
    /// 循环体末节点 id（loop_back 回边的源）——其每轮输出汇入 `{{loop.results}}`。
    back_source: String,
    /// 循环体全部节点 id（含 body_entries、含嵌套 loop 及其体）。构造 body_def / owned 时使用。
    #[allow(dead_code)]
    body_nodes: HashSet<String>,
    /// 循环体子图定义：body_nodes + 两端都在 body_nodes 内的边（含内部嵌套 loop 的回边，
    /// 但不含本 loop 自己的回边——它的目标是 loop 自身，不在 body_nodes 内）。
    body_def: WorkflowDefinition,
}

/// 整图的循环规划：每个 loop 的循环体 + 所有被循环体拥有的节点并集。
#[derive(Debug, Clone, Default)]
struct LoopPlan {
    /// key = loop 节点 id。仅收录「已接线」（有 body 出边）的 loop。
    regions: HashMap<String, LoopRegion>,
    /// 所有 loop 循环体节点的并集（顶层执行时需跳过，交由各自 loop 拥有）。
    owned: HashSet<String>,
}

fn expand_loop_region(
    loop_id: &str,
    direct_regions: &HashMap<String, DirectLoopRegion>,
    node_by_id: &HashMap<&str, &WorkflowNode>,
    visiting: &mut HashSet<String>,
    memo: &mut HashMap<String, HashSet<String>>,
) -> Result<HashSet<String>> {
    if let Some(cached) = memo.get(loop_id) {
        return Ok(cached.clone());
    }
    if !visiting.insert(loop_id.to_string()) {
        return Err(AppError::InvalidQuery(format!(
            "loop 节点嵌套关系形成循环: '{loop_id}'"
        )));
    }

    let direct = direct_regions.get(loop_id).ok_or_else(|| {
        AppError::InvalidQuery(format!("内部错误：loop '{loop_id}' 缺少直接循环区域"))
    })?;
    let mut expanded = direct.body_nodes.clone();
    for node_id in &direct.body_nodes {
        if node_by_id
            .get(node_id.as_str())
            .map(|n| n.node_type == NodeType::Loop)
            .unwrap_or(false)
        {
            if !direct_regions.contains_key(node_id) {
                return Err(AppError::InvalidQuery(format!(
                    "loop 节点 '{loop_id}' 的循环体包含未接线的嵌套 loop '{node_id}'"
                )));
            }
            expanded.extend(expand_loop_region(
                node_id,
                direct_regions,
                node_by_id,
                visiting,
                memo,
            )?);
        }
    }
    visiting.remove(loop_id);
    memo.insert(loop_id.to_string(), expanded.clone());
    Ok(expanded)
}

/// 从整图解析出所有 loop 的循环体范围。
///
/// 结构校验（针对**已接线**的 loop，即存在 body 出边或 loop_back 回边者）：
/// - body 出边恰好 1 条、loop_back 回边恰好 1 条；
/// - 回边的源节点必须落在该 loop 的循环体内；
/// - while/until 模式必须有非空 expression 且 max_iterations>=1。
/// 完全未接线的 loop 节点（无 body 无回边）视为草稿，跳过校验、不建 region（执行时报错）。
fn plan_loops(def: &WorkflowDefinition) -> Result<LoopPlan> {
    let loop_ids: Vec<&str> = def
        .nodes
        .iter()
        .filter(|n| n.node_type == NodeType::Loop)
        .map(|n| n.id.as_str())
        .collect();

    let node_by_id: HashMap<&str, &WorkflowNode> =
        def.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    // 所有带回边标记的边必须同时满足完整协议，且目标必须是 loop。
    // 禁止仅靠伪造 target_handle/edge_type 绕过拓扑环检测。
    for edge in &def.edges {
        let has_back_marker = edge.edge_type.as_deref() == Some(LOOP_BACK_EDGE_TYPE)
            || edge.target_handle.as_deref() == Some("back");
        if !has_back_marker {
            continue;
        }
        if !edge.is_loop_back() {
            return Err(AppError::InvalidQuery(format!(
                "回边 {} -> {} 必须同时设置 edge_type='loop_back' 与 target_handle='back'",
                edge.from, edge.to
            )));
        }
        if !node_by_id
            .get(edge.to.as_str())
            .map(|n| n.node_type == NodeType::Loop)
            .unwrap_or(false)
        {
            return Err(AppError::InvalidQuery(format!(
                "loop_back 回边的目标 '{}' 不是 loop 节点",
                edge.to
            )));
        }
    }
    if loop_ids.is_empty() {
        return Ok(LoopPlan::default());
    }

    let mut direct_regions: HashMap<String, DirectLoopRegion> = HashMap::new();
    for loop_id in loop_ids {
        let body_targets: Vec<String> = def
            .edges
            .iter()
            .filter(|e| e.from == loop_id && e.branch.as_deref() == Some(LOOP_BODY_BRANCH))
            .map(|e| e.to.clone())
            .collect();
        let back_edges: Vec<&WorkflowEdge> = def
            .edges
            .iter()
            .filter(|e| e.to == loop_id && e.is_loop_back())
            .collect();

        // 草稿态：既无 body 也无回边 → 跳过（允许保存半成品，执行时才报错）。
        if body_targets.is_empty() && back_edges.is_empty() {
            continue;
        }

        if body_targets.is_empty() {
            return Err(AppError::InvalidQuery(format!(
                "loop 节点 '{loop_id}' 缺少循环体（body）出边"
            )));
        }
        if body_targets.len() > 1 {
            return Err(AppError::InvalidQuery(format!(
                "loop 节点 '{loop_id}' 只能有一条 body 出边（当前 {} 条）",
                body_targets.len()
            )));
        }
        if back_edges.is_empty() {
            return Err(AppError::InvalidQuery(format!(
                "loop 节点 '{loop_id}' 缺少回边（loop_back），循环体末节点须连回本节点"
            )));
        }
        if back_edges.len() > 1 {
            return Err(AppError::InvalidQuery(format!(
                "loop 节点 '{loop_id}' 只能有一条回边（loop_back），当前 {} 条",
                back_edges.len()
            )));
        }

        let done_count = def
            .edges
            .iter()
            .filter(|e| e.from == loop_id && e.branch.as_deref() == Some(LOOP_DONE_BRANCH))
            .count();
        if done_count > 1 {
            return Err(AppError::InvalidQuery(format!(
                "loop 节点 '{loop_id}' 只能有一条 done 出边（当前 {done_count} 条）"
            )));
        }
        if let Some(edge) = def.edges.iter().find(|e| {
            e.from == loop_id
                && !e.is_loop_back()
                && !matches!(
                    e.branch.as_deref(),
                    Some(LOOP_BODY_BRANCH) | Some(LOOP_DONE_BRANCH)
                )
        }) {
            return Err(AppError::InvalidQuery(format!(
                "loop 节点 '{loop_id}' 存在非法出口到 '{}'（只允许 body/done）",
                edge.to
            )));
        }

        // 求直接循环区域。嵌套 loop 在父区域中视为原子节点：只沿其 done 出口继续，
        // 不把嵌套 body 当作父循环的旁路；后续再递归展开嵌套区域。
        let mut forward: HashSet<String> = HashSet::new();
        let mut queue: VecDeque<String> = body_targets.iter().cloned().collect();
        while let Some(cur) = queue.pop_front() {
            if cur == loop_id || !forward.insert(cur.clone()) {
                continue;
            }
            let nested_loop = node_by_id
                .get(cur.as_str())
                .map(|n| n.node_type == NodeType::Loop)
                .unwrap_or(false);
            for e in &def.edges {
                if e.from == cur
                    && !e.is_loop_back()
                    && e.to != loop_id
                    && (!nested_loop || e.branch.as_deref() == Some(LOOP_DONE_BRANCH))
                {
                    queue.push_back(e.to.clone());
                }
            }
        }

        let back_source = &back_edges[0].from;
        let mut reverse: HashSet<String> = HashSet::new();
        let mut reverse_queue: VecDeque<String> = VecDeque::from([back_source.clone()]);
        while let Some(cur) = reverse_queue.pop_front() {
            if cur == loop_id || !reverse.insert(cur.clone()) {
                continue;
            }
            for edge in &def.edges {
                if edge.to != cur || edge.is_loop_back() || edge.from == loop_id {
                    continue;
                }
                let source_is_nested_loop = node_by_id
                    .get(edge.from.as_str())
                    .map(|n| n.node_type == NodeType::Loop)
                    .unwrap_or(false);
                if source_is_nested_loop && edge.branch.as_deref() != Some(LOOP_DONE_BRANCH) {
                    continue;
                }
                reverse_queue.push_back(edge.from.clone());
            }
        }

        let body_nodes: HashSet<String> = forward.intersection(&reverse).cloned().collect();
        if !body_nodes.contains(&body_targets[0]) || !body_nodes.contains(back_source) {
            return Err(AppError::InvalidQuery(format!(
                "loop 节点 '{loop_id}' 的 body 入口无法沿闭合路径到达回边源 '{back_source}'"
            )));
        }

        // 模式校验。
        let loop_node = node_by_id.get(loop_id).ok_or_else(|| {
            AppError::InvalidQuery(format!("内部错误：loop 节点 '{loop_id}' 未找到"))
        })?;
        validate_loop_config(loop_id, &loop_node.config)?;

        // 并发 for_each：循环体禁止引用 {{loop.results}}（多轮同时执行，跨轮结果不可见）。
        let cfg = &loop_node.config;
        let is_concurrent_for_each = cfg.get("loop_mode").and_then(|v| v.as_str())
            == Some("for_each")
            && cfg.get("concurrency").and_then(json_as_u64).unwrap_or(1) > 1;
        if is_concurrent_for_each {
            for body_id in &body_nodes {
                if let Some(body_node) = node_by_id.get(body_id.as_str()) {
                    let cfg_text = serde_json::to_string(&body_node.config).unwrap_or_default();
                    if cfg_text.contains("loop.results") {
                        return Err(AppError::InvalidQuery(format!(
                            "loop 节点 '{loop_id}'（并发 for_each）的循环体节点 '{body_id}' 不可引用 {{{{loop.results}}}}（并发模式下跨轮结果不可见）"
                        )));
                    }
                }
            }
        }

        direct_regions.insert(
            loop_id.to_string(),
            DirectLoopRegion {
                body_entries: body_targets,
                back_source: back_source.clone(),
                body_nodes,
            },
        );
    }

    let mut expanded_regions: HashMap<String, HashSet<String>> = HashMap::new();
    for loop_id in direct_regions.keys() {
        expand_loop_region(
            loop_id,
            &direct_regions,
            &node_by_id,
            &mut HashSet::new(),
            &mut expanded_regions,
        )?;
    }

    // 两个循环区域只能互不相交，或形成严格嵌套；禁止 sibling loop 共享节点。
    let loop_names: Vec<String> = expanded_regions.keys().cloned().collect();
    for i in 0..loop_names.len() {
        for j in (i + 1)..loop_names.len() {
            let a = &loop_names[i];
            let b = &loop_names[j];
            let a_nodes = &expanded_regions[a];
            let b_nodes = &expanded_regions[b];
            if a_nodes.is_disjoint(b_nodes) {
                continue;
            }
            let b_nested_in_a = a_nodes.contains(b) && b_nodes.is_subset(a_nodes);
            let a_nested_in_b = b_nodes.contains(a) && a_nodes.is_subset(b_nodes);
            if !b_nested_in_a && !a_nested_in_b {
                return Err(AppError::InvalidQuery(format!(
                    "loop 节点 '{a}' 与 '{b}' 的循环体存在非嵌套共享节点"
                )));
            }
        }
    }

    let mut plan = LoopPlan::default();
    for (loop_id, direct) in direct_regions {
        let body_nodes = expanded_regions.remove(&loop_id).unwrap_or_default();

        // 区域必须闭合：除当前 loop 的 body 入边与 back 回边外，不允许跨边界。
        for edge in &def.edges {
            if edge.is_loop_back() {
                let from_inside = body_nodes.contains(&edge.from);
                let to_inside = body_nodes.contains(&edge.to);
                let is_own_back = from_inside && edge.to == loop_id;
                let is_nested_back = from_inside && to_inside;
                if !is_own_back && !is_nested_back && (from_inside || to_inside) {
                    return Err(AppError::InvalidQuery(format!(
                        "loop 节点 '{loop_id}' 存在跨区域回边 '{} -> {}'",
                        edge.from, edge.to
                    )));
                }
                continue;
            }
            let from_inside = body_nodes.contains(&edge.from);
            let to_inside = body_nodes.contains(&edge.to);
            if from_inside && !to_inside {
                return Err(AppError::InvalidQuery(format!(
                    "loop 节点 '{loop_id}' 的循环体节点 '{}' 存在越界出边到 '{}'",
                    edge.from, edge.to
                )));
            }
            if !from_inside && to_inside {
                let valid_entry = edge.from == loop_id
                    && edge.to == direct.body_entries[0]
                    && edge.branch.as_deref() == Some(LOOP_BODY_BRANCH);
                if !valid_entry {
                    return Err(AppError::InvalidQuery(format!(
                        "loop 节点 '{loop_id}' 的循环体节点 '{}' 存在外部入边 '{} -> {}'",
                        edge.to, edge.from, edge.to
                    )));
                }
            }
        }

        let body_def = WorkflowDefinition {
            nodes: def
                .nodes
                .iter()
                .filter(|n| body_nodes.contains(&n.id))
                .cloned()
                .collect(),
            edges: def
                .edges
                .iter()
                .filter(|e| body_nodes.contains(&e.from) && body_nodes.contains(&e.to))
                .cloned()
                .collect(),
        };
        plan.owned.extend(body_nodes.iter().cloned());
        plan.regions.insert(
            loop_id,
            LoopRegion {
                body_entries: direct.body_entries,
                back_source: direct.back_source,
                body_nodes,
                body_def,
            },
        );
    }

    Ok(plan)
}

/// 校验 loop 节点 config（模式相关必填项）。
fn validate_loop_config(loop_id: &str, config: &JsonValue) -> Result<()> {
    let mode = config
        .get("loop_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("while");
    match mode {
        "while" | "until" => {
            let expr = config
                .get("expression")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if expr.trim().is_empty() {
                return Err(AppError::InvalidQuery(format!(
                    "loop 节点 '{loop_id}'（{mode} 模式）缺少条件表达式 expression"
                )));
            }
            let max_it = config.get("max_iterations").and_then(json_as_u64);
            if max_it.map(|n| n == 0).unwrap_or(true) {
                return Err(AppError::InvalidQuery(format!(
                    "loop 节点 '{loop_id}'（{mode} 模式）必须设置 max_iterations（>=1）以防死循环"
                )));
            }
            if max_it.unwrap_or(0) > HARD_LOOP_MAX_ITERATIONS {
                return Err(AppError::InvalidQuery(format!(
                    "loop 节点 '{loop_id}' 的 max_iterations 不能超过服务端硬上限 {HARD_LOOP_MAX_ITERATIONS}"
                )));
            }
        }
        "count" => {
            if config.get("count").is_none() {
                return Err(AppError::InvalidQuery(format!(
                    "loop 节点 '{loop_id}'（count 模式）缺少执行次数 count"
                )));
            }
            if let Some(count) = config.get("count").and_then(json_as_u64) {
                if count == 0 || count > HARD_LOOP_MAX_ITERATIONS {
                    return Err(AppError::InvalidQuery(format!(
                        "loop 节点 '{loop_id}' 的 count 必须在 1..={HARD_LOOP_MAX_ITERATIONS} 范围内"
                    )));
                }
            }
        }
        "for_each" => {
            let items = config.get("items").and_then(|v| v.as_str()).unwrap_or("");
            if items.trim().is_empty() {
                return Err(AppError::InvalidQuery(format!(
                    "loop 节点 '{loop_id}'（for_each 模式）缺少遍历数组来源 items"
                )));
            }
            let concurrency = config.get("concurrency").and_then(json_as_u64).unwrap_or(1);
            if concurrency < 1 || concurrency > HARD_LOOP_MAX_CONCURRENCY {
                return Err(AppError::InvalidQuery(format!(
                    "loop 节点 '{loop_id}'（for_each 模式）的 concurrency 必须在 1..={HARD_LOOP_MAX_CONCURRENCY} 范围内（当前 {concurrency}）"
                )));
            }
        }
        other => {
            return Err(AppError::InvalidQuery(format!(
                "loop 节点 '{loop_id}' 的 loop_mode '{other}' 非法（应为 while/until/count/for_each）"
            )));
        }
    }

    // 并发仅 for_each 支持；while/until/count 存在跨轮状态依赖，强制串行。
    if mode != "for_each" && config.get("concurrency").and_then(json_as_u64).unwrap_or(1) != 1 {
        return Err(AppError::InvalidQuery(format!(
            "loop 节点 '{loop_id}'（{mode} 模式）不支持并发，concurrency 只能为 1"
        )));
    }

    Ok(())
}

/// 宽松地把 JSON 值解析成 u64（接受数字或数字字符串）。
fn json_as_u64(v: &JsonValue) -> Option<u64> {
    match v {
        JsonValue::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)),
        JsonValue::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

// ─── DAG 执行引擎 ─────────────────────────────────────────

fn node_type_label(node_type: &NodeType) -> String {
    serde_json::to_value(node_type)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "unknown".to_string())
}

/// 为节点结果记录「入参快照」（模板占位符已解析）。
/// 重点是 http_call：把真正发出的请求（method/url/headers/body/timeout）原样记录，
/// 便于排查到底是「参数问题」还是「对方响应问题」。
/// code 节点的脚本正文较大且不属于「参数」，这里省略，避免快照膨胀。
/// 去掉画布/编辑器元数据字段（`_position` 等以 `_` 开头的键），
/// 只保留真正的运行参数，避免把节点定义里的 UI 字段当成入参展示。
fn strip_canvas_meta(config: &JsonValue) -> JsonValue {
    match config {
        JsonValue::Object(map) => JsonValue::Object(
            map.iter()
                .filter(|(k, _)| !k.starts_with('_'))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// 提炼节点「实际入参」快照用于执行记录展示。
///
/// 注意：必须在节点执行**前**调用——此时 `ctx.node_outputs` 恰好只含上游节点输出，
/// 正好是当前节点运行时能读到的数据；执行后再取会把当前节点自身的输出也算进去。
fn node_input_snapshot(
    node_type: &NodeType,
    config: &JsonValue,
    ctx: &ExecutionContext,
) -> JsonValue {
    match node_type {
        NodeType::HttpCall => {
            let method = config
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("GET")
                .to_uppercase();
            json!({
                "method": method,
                "url": config.get("url").cloned().unwrap_or(JsonValue::Null),
                "headers": config.get("headers").cloned().unwrap_or(JsonValue::Null),
                "body": config.get("body").cloned().unwrap_or(JsonValue::Null),
                "timeout_secs": config
                    .get("timeout_secs")
                    .or_else(|| config.get("timeout"))
                    .cloned()
                    .unwrap_or(JsonValue::Null),
            })
        }
        NodeType::Code => {
            // code 节点的「实际入参」是运行时可读取的数据，而非代码定义本身：
            // Lua 通过 ctx.body 读触发数据、ctx.nodes 读上游节点输出。
            let nodes: JsonValue = ctx.node_outputs.clone().into_iter().collect();
            json!({
                "trigger": ctx.trigger_data.clone(),
                "nodes": nodes,
            })
        }
        _ => strip_canvas_meta(config),
    }
}

// ─── 数据源（wf_datasources）连接解析 ─────────────────────────────────
//
// db 节点可在 config.datasource_id 里显式选择项目内共享的数据源，覆盖默认的
// workflow.database_id。为避免与 tenant_databases.id 的池缓存键冲突，数据源池
// 用一个大偏移量做命名空间隔离（tenant_databases.id 远不会到 10 亿）。

/// 数据源在 POOL_MANAGER 里的缓存键（与 tenant_databases.id 隔离）。
pub fn datasource_pool_key(ds_id: i32) -> i32 {
    const DATASOURCE_POOL_KEY_OFFSET: i32 = 1_000_000_000;
    DATASOURCE_POOL_KEY_OFFSET.saturating_add(ds_id)
}

/// 从节点 config 里解析出有效的 datasource_id（覆盖默认库）。
///
/// 兼容前端把值存成数字或字符串两种形态；空串 / null / 0 / 非法值一律视为
/// 「未选择」→ 返回 None → 执行走 workflow.database_id 默认路径（老数据即如此）。
pub fn extract_datasource_id(config: &JsonValue) -> Option<i32> {
    let v = config.get("datasource_id")?;
    let id = match v {
        JsonValue::Number(n) => n.as_i64().map(|x| x as i32),
        JsonValue::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                t.parse::<i32>().ok()
            }
        }
        _ => None,
    };
    id.filter(|x| *x > 0)
}

/// 节点实际会用到的 POOL_MANAGER 缓存键 —— 与 `workflow_db_conn` 的解析顺序一致：
/// 显式 `datasource_id` 优先，否则回退 `workflow.database_id`。
///
/// 只用于 acquire 超时的归因埋点：让监控页能说出「是哪个库的池打满了」，而不是只给
/// 一个全局总数。两者都缺失时返回 `None`（该节点本来也会执行失败）。
fn node_pool_key(config: &JsonValue, ctx: &ExecutionContext) -> Option<i32> {
    extract_datasource_id(config)
        .map(datasource_pool_key)
        .or(ctx.database_id)
}

/// MySQL 数据源连接池缓存（按 datasource_pool_key 命名空间隔离；与 POOL_MANAGER 的
/// PgPool 缓存分开，两者键空间一致但类型不同）。
static MYSQL_DATASOURCE_POOLS: once_cell::sync::Lazy<
    dashmap::DashMap<i32, sqlx::mysql::MySqlPool>,
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// 已解析的数据源连接：按数据源类型分流到不同驱动。
#[derive(Clone)]
pub enum DatasourceConn {
    Pg(PgPool),
    MySql(sqlx::mysql::MySqlPool),
}

/// 数据源的连接元信息（解密后，短暂驻留）。
struct DatasourceMeta {
    ds_type: String,
    host: String,
    port: Option<i32>,
    database: String,
    username: String,
    password: String,
}

/// 从管理库读取数据源 + 凭证，做归属校验与必填校验。
async fn load_datasource_meta(
    mgmt_pool: &PgPool,
    tenant_id: Option<i32>,
    ds_id: i32,
) -> Result<DatasourceMeta> {
    use sqlx::Row;

    let row = sqlx::query(
        r#"
        SELECT d.ds_type, d.host, d.port, d.database,
               c.username AS cred_username, c.secret_encrypted AS cred_secret
        FROM management.wf_datasources d
        LEFT JOIN management.wf_credentials c ON c.id = d.credential_id
        WHERE d.id = $1 AND d.is_active = true
          AND ($2::int IS NULL OR d.tenant_id = $2)
        "#,
    )
    .bind(ds_id)
    .bind(tenant_id)
    .fetch_optional(mgmt_pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("数据源 {} 不存在或已禁用", ds_id)))?;

    let ds_type: String = row.get("ds_type");
    let host: String = row.get("host");
    let port: Option<i32> = row.get("port");
    let database: Option<String> = row.get("database");
    let username: Option<String> = row.get("cred_username");
    let secret_enc: Option<String> = row.get("cred_secret");

    if host.trim().is_empty() {
        return Err(AppError::InvalidQuery(format!(
            "数据源 {} 缺少主机地址",
            ds_id
        )));
    }
    let database = database
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::InvalidQuery(format!("数据源 {} 缺少库名（database）", ds_id)))?;
    let username = username
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::InvalidQuery(format!("数据源 {} 未绑定带用户名的凭证", ds_id)))?;
    let password = secret_enc
        .map(|e| crate::crypto::decrypt_secret_lossy(&e))
        .unwrap_or_default();

    Ok(DatasourceMeta {
        ds_type,
        host,
        port,
        database,
        username,
        password,
    })
}

/// 解析数据源为可用连接（带缓存）。支持 postgresql / mysql；其它类型报错。
///
/// `mgmt_pool` 为管理库连接；`tenant_id` 存在时强制数据源归属校验，防越权引用别项目的源。
pub async fn resolve_datasource_conn(
    mgmt_pool: &PgPool,
    tenant_id: Option<i32>,
    ds_id: i32,
) -> Result<DatasourceConn> {
    use crate::pool_manager::{DatabaseConfig, POOL_MANAGER};

    let key = datasource_pool_key(ds_id);

    // 命中缓存（两种驱动分别查）。
    if let Some(pool) = POOL_MANAGER.get_write_pool(key) {
        return Ok(DatasourceConn::Pg(pool));
    }
    if let Some(pool) = MYSQL_DATASOURCE_POOLS.get(&key).map(|p| p.clone()) {
        return Ok(DatasourceConn::MySql(pool));
    }

    let meta = load_datasource_meta(mgmt_pool, tenant_id, ds_id).await?;

    match meta.ds_type.as_str() {
        "postgresql" => {
            let config = DatabaseConfig {
                id: key,
                host: meta.host,
                port: meta.port.unwrap_or(5432),
                database: meta.database,
                username: meta.username,
                password: meta.password,
                max_connections: crate::pool_manager::DEFAULT_TENANT_MAX_CONNECTIONS,
                connection_timeout: crate::pool_manager::DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS,
            };
            Ok(DatasourceConn::Pg(
                POOL_MANAGER.get_or_create_pool(config).await?,
            ))
        }
        "mysql" => {
            use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
            // 用 ConnectOptions 而非 URL：既避免用户名/密码里特殊字符破坏连接串，又能关掉
            // 下面两个默认开关。sqlx 默认建连时会跑 `SET sql_mode=CONCAT(@@sql_mode, ...)`
            // （非常量表达式）来追加 PIPES_AS_CONCAT / NO_ENGINE_SUBSTITUTION；Apache Doris /
            // StarRocks / OceanBase 等 MySQL 协议兼容引擎会拒绝，报
            // "Set statement doesn't support non-constant expr"。关掉即跳过该语句。
            let opts = MySqlConnectOptions::new()
                .host(&meta.host)
                .port(meta.port.unwrap_or(3306) as u16)
                .username(&meta.username)
                .password(&meta.password)
                .database(&meta.database)
                .pipes_as_concat(false)
                // 注意：sqlx 0.7 该方法名有拼写错误（少一个 t），保持与库一致。
                .no_engine_subsitution(false);
            let pool = MySqlPoolOptions::new()
                .max_connections(10)
                .acquire_timeout(std::time::Duration::from_secs(30))
                .connect_with(opts)
                .await
                .map_err(|e| AppError::Internal(format!("连接 MySQL 数据源失败: {}", e)))?;
            MYSQL_DATASOURCE_POOLS.insert(key, pool.clone());
            Ok(DatasourceConn::MySql(pool))
        }
        other => Err(AppError::InvalidQuery(format!(
            "数据源类型 {} 暂不支持在数据库节点中执行 SQL（当前支持 postgresql / mysql）",
            other
        ))),
    }
}

/// 淘汰某数据源的内存连接池（PG 与 MySQL 两处缓存都清）。数据源/凭证变更时调用。
pub async fn evict_datasource_pool(ds_id: i32) {
    let key = datasource_pool_key(ds_id);
    crate::pool_manager::POOL_MANAGER.remove_pool(key).await;
    if let Some((_, pool)) = MYSQL_DATASOURCE_POOLS.remove(&key) {
        tokio::spawn(async move { pool.close().await });
    }
}

/// 测试数据源连通性（postgresql / mysql）：解析连接并 `SELECT 1`。
pub async fn probe_datasource_connection(
    mgmt_pool: &PgPool,
    tenant_id: Option<i32>,
    ds_id: i32,
) -> Result<()> {
    match resolve_datasource_conn(mgmt_pool, tenant_id, ds_id).await? {
        DatasourceConn::Pg(pool) => {
            sqlx::query("SELECT 1").execute(&pool).await?;
        }
        DatasourceConn::MySql(pool) => {
            // 文本协议（raw_sql）：避免预编译，兼容 Doris/StarRocks。
            sqlx::raw_sql("SELECT 1").execute(&pool).await?;
        }
    }
    Ok(())
}

fn should_record_subworkflow_run(ctx: &ExecutionContext) -> bool {
    !ctx.dry_run && ctx.run_id > 0 && ctx.workflow_id > 0
}

struct SubworkflowRunSummary {
    status: &'static str,
    index_status: &'static str,
    error_message: Option<String>,
    final_output: JsonValue,
}

fn summarize_subworkflow_run(
    results: &[NodeExecutionResult],
    returned_output: JsonValue,
) -> SubworkflowRunSummary {
    let failed = results.iter().find(|r| r.status == NodeStatus::Failed);
    if failed.is_some() {
        SubworkflowRunSummary {
            status: "failed",
            index_status: "failed",
            error_message: failed.and_then(|r| r.error.clone()),
            final_output: returned_output,
        }
    } else {
        SubworkflowRunSummary {
            status: "completed",
            index_status: "success",
            error_message: None,
            final_output: returned_output,
        }
    }
}

async fn begin_subworkflow_run(
    pool: &PgPool,
    workflow_id: i32,
    tenant_id: Option<i32>,
    trigger_data: &JsonValue,
    user_id: Option<i32>,
    name: Option<&str>,
) -> Option<(i64, Option<i64>)> {
    use sqlx::Row;
    let trace_id = crate::execution_log::new_trace_id();
    let row = sqlx::query(
        r#"INSERT INTO management.workflow_runs
           (workflow_id, tenant_id, trigger_type, trigger_data, status, trace_id)
           VALUES ($1, $2, 'subworkflow', $3, 'running', $4)
           RETURNING id"#,
    )
    .bind(workflow_id)
    .bind(tenant_id)
    .bind(trigger_data)
    .bind(&trace_id)
    .fetch_one(pool)
    .await;
    let run_id = match row {
        Ok(r) => r.get::<i64, _>("id"),
        Err(e) => {
            tracing::warn!(workflow_id, "子工作流 run 写入失败: {}", e);
            return None;
        }
    };
    let index_id = crate::execution_log::begin_index(
        pool,
        &trace_id,
        "workflow",
        Some("workflow_runs"),
        Some(run_id),
        tenant_id,
        user_id,
        name,
    )
    .await;
    Some((run_id, index_id))
}

async fn finish_subworkflow_run(
    pool: &PgPool,
    run_id: i64,
    index_id: Option<i64>,
    env_vars: &HashMap<String, String>,
    results: &[NodeExecutionResult],
    returned_output: &JsonValue,
    engine_error: Option<&str>,
    elapsed_ms: i64,
) {
    let mut summary = summarize_subworkflow_run(results, returned_output.clone());
    if let Some(msg) = engine_error {
        summary.status = "failed";
        summary.index_status = "failed";
        if summary.error_message.is_none() {
            summary.error_message = Some(msg.to_string());
        }
    }
    let masked_node_results = mask_env_values(&json!(results), env_vars);
    let masked_final_output = mask_env_values(&summary.final_output, env_vars);
    let masked_error = summary.error_message.as_ref().map(|m| {
        mask_env_values(&json!(m), env_vars)
            .as_str()
            .unwrap_or(m)
            .to_string()
    });
    if let Err(e) = sqlx::query(
        r#"UPDATE management.workflow_runs
           SET status = $2, node_results = $3, final_output = $4,
               error_message = $5, elapsed_ms = $6, completed_at = NOW()
           WHERE id = $1"#,
    )
    .bind(run_id)
    .bind(summary.status)
    .bind(masked_node_results)
    .bind(masked_final_output)
    .bind(&masked_error)
    .bind(elapsed_ms)
    .execute(pool)
    .await
    {
        tracing::warn!(run_id, "子工作流 run 收口失败: {}", e);
    }
    crate::execution_log::finish_index(
        pool,
        index_id,
        summary.index_status,
        Some(elapsed_ms),
        masked_error.as_deref(),
    )
    .await;
}

struct SubworkflowRunGuard {
    pool: PgPool,
    run_id: i64,
    index_id: Option<i64>,
    started: Instant,
    finalized: Arc<AtomicBool>,
}

impl SubworkflowRunGuard {
    fn new(pool: PgPool, run_id: i64, index_id: Option<i64>) -> Self {
        Self {
            pool,
            run_id,
            index_id,
            started: Instant::now(),
            finalized: Arc::new(AtomicBool::new(false)),
        }
    }

    fn mark_finalized(&self) {
        self.finalized.store(true, Ordering::SeqCst);
    }
}

impl Drop for SubworkflowRunGuard {
    fn drop(&mut self) {
        if self.finalized.load(Ordering::SeqCst) {
            return;
        }
        let pool = self.pool.clone();
        let run_id = self.run_id;
        let index_id = self.index_id;
        let elapsed_ms = self.started.elapsed().as_millis() as i64;
        let msg = "子工作流执行被中断（父工作流超时或任务取消，未正常收口）".to_string();
        tracing::warn!(
            target: "workflow",
            run_id,
            elapsed_ms,
            "SubworkflowRunGuard：子工作流 run 在收口前被 drop"
        );
        tokio::spawn(async move {
            let _ = sqlx::query(
                r#"UPDATE management.workflow_runs
                   SET status = 'failed', error_message = $2, elapsed_ms = $3, completed_at = NOW()
                   WHERE id = $1 AND status = 'running'"#,
            )
            .bind(run_id)
            .bind(&msg)
            .bind(elapsed_ms)
            .execute(&pool)
            .await;
            crate::execution_log::finish_index(
                &pool,
                index_id,
                "failed",
                Some(elapsed_ms),
                Some(&msg),
            )
            .await;
        });
    }
}

/// 工作流 DAG 引擎：按拓扑顺序调度各节点
pub struct DagEngine {
    pool: PgPool,
}

impl DagEngine {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// 执行整个工作流 DAG（顶层入口；子工作流递归从空调用栈开始）。
    pub async fn execute(
        &self,
        def: &WorkflowDefinition,
        ctx: &mut ExecutionContext,
    ) -> Result<Vec<NodeExecutionResult>> {
        self.execute_dag(def, ctx, Vec::new()).await
    }

    /// DAG 执行核心。`call_stack` 记录从顶层到当前的工作流 id 链路，用于子工作流
    /// 递归调用时检测环 / 限制层级。因为 `exec_call_workflow_node` 会再次调用本方法，
    /// 形成 async 自递归，必须 `Box::pin` 装箱以打破无限大小的 future 类型。
    fn execute_dag<'a>(
        &'a self,
        def: &'a WorkflowDefinition,
        ctx: &'a mut ExecutionContext,
        call_stack: Vec<i32>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<NodeExecutionResult>>> + Send + 'a>,
    > {
        Box::pin(async move {
            let sorted = topological_sort(def)?;
            // 解析循环规划：哪些节点属于某个 loop 的循环体（owned），由 run_loop 驱动，
            // 顶层不逐节点执行；每个 loop 的循环体子图供 run_loop 反复执行。
            let loop_plan = plan_loops(def)?;
            let node_map: HashMap<&str, &WorkflowNode> =
                def.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

            let workflow_start = Instant::now();
            tracing::info!(
                target: "workflow",
                workflow_id = ctx.workflow_id,
                run_id = ctx.run_id,
                node_count = sorted.len(),
                "工作流开始执行"
            );

            let mut results: Vec<NodeExecutionResult> = Vec::new();
            let mut skipped: HashSet<String> = HashSet::new();
            let mut success_count: usize = 0;
            let mut failed_count: usize = 0;
            let mut skipped_count: usize = 0;

            for node_id in &sorted {
                // 循环体节点由其所属 loop 在 run_loop 内反复执行，顶层不再单独执行，
                // 也不产出顶层结果（逐轮结果嵌套在 loop 节点输出的 _iterations 里）。
                if loop_plan.owned.contains(node_id.as_str()) {
                    continue;
                }

                // 跳过被 condition 排除的分支节点
                if skipped.contains(node_id.as_str()) {
                    tracing::debug!(
                        target: "workflow",
                        workflow_id = ctx.workflow_id,
                        node_id = %node_id,
                        "节点被条件分支跳过"
                    );
                    skipped_count += 1;
                    results.push(NodeExecutionResult {
                        node_id: node_id.clone(),
                        node_type: node_map
                            .get(node_id.as_str())
                            .map(|n| node_type_label(&n.node_type)),
                        status: NodeStatus::Skipped,
                        input: JsonValue::Null,
                        output: JsonValue::Null,
                        elapsed_ms: 0,
                        error: None,
                        branch: None,
                    });
                    continue;
                }

                let node = match node_map.get(node_id.as_str()) {
                    Some(n) => *n,
                    None => continue,
                };

                // DB 节点的 SQL、code 节点的脚本、call_workflow.input 保持原样（含 {{}}），
                // 其余字段正常解析。code 若走字符串替换，Lua 嵌套表 `{{ ... }}` 会被掏空。
                let config = resolve_node_config(&node.node_type, &node.config, ctx);
                // 入参快照须在执行前抓取：此刻 ctx.node_outputs 仅含上游输出，
                // 正是当前节点运行时真正能读到的数据（执行后会混入自身输出）。
                // loop 节点用**原始** config 快照（保留 {{loop.*}} 字面量，避免此刻误解析为空）。
                let input_snapshot = if node.node_type == NodeType::Loop {
                    node_input_snapshot(&node.node_type, &node.config, ctx)
                } else {
                    node_input_snapshot(&node.node_type, &config, ctx)
                };
                let start = Instant::now();

                tracing::debug!(
                    target: "workflow",
                    workflow_id = ctx.workflow_id,
                    node_id = %node_id,
                    node_type = ?node.node_type,
                    "执行节点"
                );

                // loop 节点走独立子解释器（需要循环体子图，逐轮 clone ctx 注入 {{loop.*}}），
                // 其余节点走通用逐节点 dispatch。两条路径共用下面统一的成功/失败/容错处理。
                let exec_result = if node.node_type == NodeType::Loop {
                    match loop_plan.regions.get(node_id.as_str()) {
                        Some(region) => self.run_loop(node, region, ctx, &call_stack).await,
                        None => Err(AppError::InvalidQuery(format!(
                        "loop 节点 '{node_id}' 未接线（缺少 body 出口或 loop_back 回边），无法执行"
                    ))),
                    }
                } else {
                    self.execute_node(node, &config, ctx, &call_stack).await
                };
                let elapsed_ms = start.elapsed().as_millis() as u64;

                match exec_result {
                    Ok((output, branch)) => {
                        success_count += 1;
                        tracing::debug!(
                            target: "workflow",
                            workflow_id = ctx.workflow_id,
                            node_id = %node_id,
                            node_type = ?node.node_type,
                            elapsed_ms = elapsed_ms,
                            "节点执行成功"
                        );
                        ctx.node_outputs.insert(node_id.clone(), output.clone());

                        // condition 节点：根据选中分支标记需要跳过的路径
                        if node.node_type == NodeType::Condition {
                            if let Some(ref chosen_branch) = branch {
                                let allowed = get_branch_successors(def, node_id, chosen_branch);
                                let allowed_reachable = collect_reachable(def, &allowed);
                                let all_successors: HashSet<String> = def
                                    .edges
                                    .iter()
                                    .filter(|e| e.from == *node_id && e.branch.is_some())
                                    .map(|e| e.to.clone())
                                    .collect();
                                let rejected_starts: HashSet<String> =
                                    all_successors.difference(&allowed).cloned().collect();
                                let rejected_reachable = collect_reachable(def, &rejected_starts);
                                // 只跳过「仅能从未选分支到达」的节点；两条分支共同可达的
                                // merge 节点继续执行，避免 diamond 汇合点被误杀。
                                for node_id in rejected_reachable.difference(&allowed_reachable) {
                                    skipped.insert(node_id.clone());
                                }
                            }
                        }

                        results.push(NodeExecutionResult {
                            node_id: node_id.clone(),
                            node_type: Some(node_type_label(&node.node_type)),
                            status: NodeStatus::Success,
                            input: input_snapshot,
                            output,
                            elapsed_ms,
                            error: None,
                            branch,
                        });
                    }
                    Err(e) => {
                        let err_msg = e.to_string();
                        // 容错节点（allow_failure: true）：捕获**所有**节点级错误，
                        // 不区分错误来源（HTTP 4xx/5xx、超时、连接失败、URL 构建失败、
                        // 内网拦截、参数缺失等都在覆盖范围内），记录失败后继续执行后续节点。
                        //
                        // 唯一例外是只读 API Key 护栏：它是权限拒绝，不是"这次调用不巧失败了"。
                        // 若让 allow_failure 吞掉，工作流会带着"写被拒绝"继续跑完下游并对外
                        // 返回成功，只读 key 的约束就成了摆设——所以强制不可容错。
                        let allow_failure = config_allow_failure(&config)
                            && !is_api_key_readonly_block_message(&err_msg);
                        if allow_failure {
                            failed_count += 1;
                            tracing::warn!(
                                target: "workflow",
                                workflow_id = ctx.workflow_id,
                                run_id = ctx.run_id,
                                node_id = %node_id,
                                node_type = ?node.node_type,
                                elapsed_ms = elapsed_ms,
                                err = %err_msg,
                                "节点执行失败，但 allow_failure=true，已容错并继续"
                            );
                            // 把错误以结构化对象写入上下文，便于下游通过
                            // `{{node_id.error}}` / `{{node_id.failed}}` 引用并做条件分支。
                            let err_output = json!({
                                "error": err_msg.clone(),
                                "failed": true,
                                "allow_failure": true,
                            });
                            ctx.node_outputs.insert(node_id.clone(), err_output.clone());
                            results.push(NodeExecutionResult {
                                node_id: node_id.clone(),
                                node_type: Some(node_type_label(&node.node_type)),
                                status: NodeStatus::FailedAllowed,
                                input: input_snapshot,
                                output: err_output,
                                elapsed_ms,
                                error: Some(err_msg),
                                branch: None,
                            });
                            continue;
                        }

                        failed_count += 1;
                        tracing::error!(
                            target: "workflow",
                            workflow_id = ctx.workflow_id,
                            run_id = ctx.run_id,
                            node_id = %node_id,
                            node_type = ?node.node_type,
                            elapsed_ms = elapsed_ms,
                            err = %err_msg,
                            "节点执行失败"
                        );
                        results.push(NodeExecutionResult {
                            node_id: node_id.clone(),
                            node_type: Some(node_type_label(&node.node_type)),
                            status: NodeStatus::Failed,
                            input: input_snapshot,
                            output: JsonValue::Null,
                            elapsed_ms,
                            error: Some(err_msg.clone()),
                            branch: None,
                        });

                        // response 节点失败不中断（只是最终响应丢失）
                        if node.node_type != NodeType::Response {
                            tracing::warn!(
                                target: "workflow",
                                workflow_id = ctx.workflow_id,
                                run_id = ctx.run_id,
                                failed_node = %node_id,
                                success_count = success_count,
                                failed_count = failed_count,
                                skipped_count = skipped_count,
                                elapsed_ms = workflow_start.elapsed().as_millis() as u64,
                                "工作流因节点失败而中断"
                            );
                            return Ok(results);
                        }
                    }
                }
            }

            tracing::info!(
                target: "workflow",
                workflow_id = ctx.workflow_id,
                run_id = ctx.run_id,
                success_count = success_count,
                failed_count = failed_count,
                skipped_count = skipped_count,
                elapsed_ms = workflow_start.elapsed().as_millis() as u64,
                "工作流执行完成"
            );

            Ok(results)
        })
    }

    /// 执行单个节点，返回 (output, optional_branch)
    async fn execute_node(
        &self,
        node: &WorkflowNode,
        config: &JsonValue,
        ctx: &ExecutionContext,
        call_stack: &[i32],
    ) -> Result<(JsonValue, Option<String>)> {
        // 副作用拦截（dry_run 与生产只读护栏共用同一收口）：跳过有副作用的节点返回 mock，
        // 避免真实写库/请求/发信。condition / transform / response / db_query / code 仍真实
        // 执行——它们或无副作用、或决定流程走向，跳过会让调试失去意义。
        // 两种拦截的差异仅在 mock 的标记：dry_run 标 "dry_run":true；生产只读标
        // "blocked_by":"production_readonly"（db_query 走 READ ONLY 事务、Lua http 被禁，
        // 由各 exec_* 自行兜底，不在此拦截）。
        if ctx.dry_run || ctx.prod_readonly {
            if let Some(mock) = side_effect_mock(&node.node_type, ctx.prod_readonly && !ctx.dry_run)
            {
                return Ok((mock, None));
            }
        }

        // 网关只读 API Key 护栏（DB-only）：与 dry_run/prod_readonly 分开收口——本护栏**只**
        // 拦 DB 写，不动 http/email/sse，故不能复用 side_effect_mock（那会误伤后三者）。
        // 覆盖两类写：
        //   1. 显式写节点 db_execute / db_transaction / foreach（is_db_write_node）；
        //   2. db_query 里伪装成读的数据修改型 CTE（WITH x AS (INSERT/UPDATE/DELETE ...)）。
        // 两类统一在此记日志 + 拦截，保证 log_only 观察到的命中集合与 enforce 会拦的完全一致。
        // log_only 档只记日志不拦；enforce 档直接让节点失败（硬失败语义见 api_key_readonly_block_error）。
        if ctx.should_log_db_write() {
            let write_kind = if is_db_write_node(&node.node_type) {
                Some("db_write_node")
            } else if matches!(node.node_type, NodeType::DbQuery)
                && db_query_has_data_modifying_cte(config)
            {
                Some("data_modifying_cte")
            } else {
                None
            };
            if let Some(kind) = write_kind {
                tracing::warn!(
                    target: "authz",
                    event = "wf_apikey_readonly_block",
                    workflow_id = ctx.workflow_id,
                    run_id = ctx.run_id,
                    node_id = %node.id,
                    node_type = ?node.node_type,
                    detected_by = kind,
                    database_id = ?ctx.database_id,
                    mode = ctx.apikey_write_guard.as_str(),
                    blocked = ctx.should_block_db_write(),
                    "只读网关 API Key 触发的工作流命中 DB 写操作"
                );
                if ctx.should_block_db_write() {
                    return Err(api_key_readonly_block_error(
                        &node.id,
                        &node_type_label(&node.node_type),
                    ));
                }
            }
        }

        match node.node_type {
            NodeType::Code => self.exec_code_node(config, ctx).await,
            NodeType::DbQuery => self.exec_db_query_node(config, ctx).await,
            NodeType::DbExecute => self.exec_db_execute_node(config, ctx).await,
            NodeType::HttpCall => self.exec_http_call_node(config).await,
            NodeType::EmailSend => self.exec_email_send_node(config).await,
            NodeType::Condition => self.exec_condition_node(config, ctx).await,
            NodeType::Transform => self.exec_transform_node(config, ctx).await,
            NodeType::Response => self.exec_response_node(config, ctx).await,
            NodeType::SsePublish => self.exec_sse_publish_node(config, ctx).await,
            NodeType::DbTransaction => self.exec_db_transaction_node(config, ctx).await,
            NodeType::ForEach => self.exec_foreach_node(config, ctx).await,
            NodeType::CallWorkflow => self.exec_call_workflow_node(config, ctx, call_stack).await,
            NodeType::Redis => self.exec_redis_node(config, ctx).await,
            NodeType::Kafka => self.exec_kafka_node(config, ctx).await,
            NodeType::ObjectStorage => self.exec_object_storage_node(config, ctx).await,
            // loop 节点由 execute_dag 特殊分发（run_loop），需要访问整图以界定循环体，
            // 不经此逐节点 dispatch。走到这里说明循环体识别有误（如循环体内又嵌了未被
            // 拥有的 loop），属于内部不变量被破坏，直接报错而非静默。
            NodeType::Loop => Err(AppError::InvalidQuery(
                "loop 节点不应经 execute_node 分发（应由 execute_dag 的 run_loop 处理）"
                    .to_string(),
            )),
        }
    }

    // ─── Loop 节点（循环子解释器） ─────────────────────────────
    //
    // 设计：loop 节点在主 DAG 里是单个节点；到达它时反复执行「循环体子图」
    // （region.body_def，已在 plan_loops 里剔除回边、保证无环），直到按模式退出，
    // 再返回 branch=Some("done") 让主引擎走 done 出口继续。
    //
    // 迭代隔离与作用域变量：每轮 clone 一份 iter_ctx，注入假节点 `loop`（使
    // {{loop.index}}/{{loop.count}}/{{loop.item}}/{{loop.results}} 可解析，复用 foreach 的
    // item_var 思路）；循环体各节点输出并回 carry_ctx，供 while/until 条件求值与下一轮
    // 模板引用「上一轮结果」（轮询场景的核心）。递归调用 execute_dag 天然支持嵌套 loop。
    async fn run_loop(
        &self,
        node: &WorkflowNode,
        region: &LoopRegion,
        ctx: &ExecutionContext,
        call_stack: &[i32],
    ) -> Result<(JsonValue, Option<String>)> {
        let config = &node.config;
        let loop_id = node.id.as_str();

        let mode = config
            .get("loop_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("while")
            .to_string();
        let allow_failure = config_allow_failure(config);
        let delay_ms = config.get("delay_ms").and_then(json_as_u64).unwrap_or(0);
        let configured_max = config.get("max_iterations").and_then(json_as_u64);

        // carry_ctx：跨轮累积循环体输出（供 while/until 条件与模板引用上一轮结果）。
        // 以当前 ctx 为基线（含上游节点输出与 trigger_data）。
        let mut carry_ctx = ctx.clone();

        // for_each：预解析数组。
        let items: Vec<JsonValue> = if mode == "for_each" {
            let items_expr = config.get("items").and_then(|v| v.as_str()).unwrap_or("");
            match resolve_template(&json!(items_expr), &carry_ctx) {
                JsonValue::Array(arr) => arr,
                // Lua 空表会被序列化成 `{}`（见 lua_engine::lua_to_json），语义上等价空数组；
                // 空数组来源节点（如 code 节点产出的空 items）应视为「0 次迭代」而非报错。
                JsonValue::Object(m) if m.is_empty() => Vec::new(),
                _ => {
                    return Err(AppError::InvalidQuery(format!(
                        "loop '{loop_id}' for_each 的 items '{items_expr}' 解析结果不是数组"
                    )))
                }
            }
        } else {
            Vec::new()
        };
        if items.len() as u64 > HARD_LOOP_MAX_ITERATIONS {
            return Err(AppError::InvalidQuery(format!(
                "loop '{loop_id}' for_each 数组长度 {} 超过服务端硬上限 {HARD_LOOP_MAX_ITERATIONS}",
                items.len()
            )));
        }

        // count：解析目标次数（支持模板）。
        let count_target: u64 = if mode == "count" {
            let raw = config.get("count").cloned().unwrap_or(JsonValue::Null);
            let resolved = resolve_template(&raw, &carry_ctx);
            json_as_u64(&resolved).ok_or_else(|| {
                AppError::InvalidQuery(format!(
                    "loop '{loop_id}' count 模式的 count 解析结果不是正整数"
                ))
            })?
        } else {
            0
        };
        if mode == "count" && (count_target == 0 || count_target > HARD_LOOP_MAX_ITERATIONS) {
            return Err(AppError::InvalidQuery(format!(
                "loop '{loop_id}' count 必须在 1..={HARD_LOOP_MAX_ITERATIONS} 范围内"
            )));
        }

        // 所有模式均受不可绕过的服务端硬上限约束；count/for_each 若额外配置
        // max_iterations，则允许提前截断并通过 reached_max 明确暴露。
        let max_iterations: u64 = match mode.as_str() {
            "while" | "until" => configured_max
                .unwrap_or(DEFAULT_LOOP_MAX_ITERATIONS)
                .min(HARD_LOOP_MAX_ITERATIONS),
            "count" => configured_max
                .unwrap_or(count_target)
                .min(count_target)
                .min(HARD_LOOP_MAX_ITERATIONS),
            "for_each" => configured_max
                .unwrap_or(items.len() as u64)
                .min(items.len() as u64)
                .min(HARD_LOOP_MAX_ITERATIONS),
            _ => configured_max
                .unwrap_or(DEFAULT_LOOP_MAX_ITERATIONS)
                .min(HARD_LOOP_MAX_ITERATIONS),
        };

        let mut results_acc: Vec<JsonValue> = Vec::new(); // {{loop.results}}
        let mut iteration_reports: Vec<JsonValue> = Vec::new(); // output._iterations
        let mut index: u64 = 0; // 当前轮索引（从 0），也是「已完成轮次」计数
        let mut reached_max = false;
        let mut last_item: Option<JsonValue> = None;
        let mut had_failures = false;
        let mut last_error: Option<String> = None;

        // concurrency：仅 for_each 生效（校验层已保证其余模式为 1）；clamp 到硬上限兜底。
        let concurrency = config
            .get("concurrency")
            .and_then(json_as_u64)
            .unwrap_or(1)
            .clamp(1, HARD_LOOP_MAX_CONCURRENCY);

        if mode == "for_each" && concurrency > 1 {
            use futures::StreamExt;

            // 单轮并发执行的产出。body_results 为空且 failed=true 表示 execute_dag 本身报错。
            struct IterOutcome {
                index: u64,
                item: JsonValue,
                body_results: Vec<NodeExecutionResult>,
                last_out: Option<JsonValue>,
                failed: bool,
                error: Option<String>,
            }

            // 每个 item 一个独立 future：clone 进入 loop 前的基线 ctx，注入 {{loop.*}}
            // （index/count/item，**不含 results**），执行循环体子图。
            let futs = (0..max_iterations as usize).map(|i| {
                let cur_item = items[i].clone();
                let base_ctx = ctx.clone();
                let stack = call_stack.to_vec();
                async move {
                    let mut iter_ctx = base_ctx;
                    let mut loop_vars = serde_json::Map::new();
                    loop_vars.insert("index".to_string(), json!(i as u64));
                    loop_vars.insert("count".to_string(), json!(i as u64 + 1));
                    loop_vars.insert("reached_max".to_string(), json!(false));
                    loop_vars.insert("item".to_string(), cur_item.clone());
                    iter_ctx
                        .node_outputs
                        .insert("loop".to_string(), JsonValue::Object(loop_vars));
                    let res = self
                        .execute_dag(&region.body_def, &mut iter_ctx, stack)
                        .await;
                    let last_out = iter_ctx.node_outputs.get(&region.back_source).cloned();
                    (i as u64, cur_item, res, last_out)
                }
            });

            let mut stream = futures::stream::iter(futs).buffer_unordered(concurrency as usize);
            let mut outcomes: Vec<IterOutcome> = Vec::new();

            while let Some((idx, item, res, last_out)) = stream.next().await {
                match res {
                    Err(e) => {
                        // execute_dag 自身报错（非节点级失败）。
                        if !allow_failure {
                            return Err(e);
                        }
                        had_failures = true;
                        last_error = Some(e.to_string());
                        outcomes.push(IterOutcome {
                            index: idx,
                            item,
                            body_results: Vec::new(),
                            last_out: None,
                            failed: true,
                            error: Some(e.to_string()),
                        });
                    }
                    Ok(body_results) => {
                        if let Some(failed) =
                            body_results.iter().find(|r| r.status == NodeStatus::Failed)
                        {
                            if !allow_failure {
                                return Err(AppError::InvalidQuery(format!(
                                    "loop '{loop_id}' 循环体节点 '{}' 失败: {}",
                                    failed.node_id,
                                    failed.error.clone().unwrap_or_default()
                                )));
                            }
                            had_failures = true;
                            last_error = failed.error.clone();
                            let err = failed.error.clone();
                            outcomes.push(IterOutcome {
                                index: idx,
                                item,
                                body_results,
                                last_out: None,
                                failed: true,
                                error: err,
                            });
                        } else if last_out.is_none() {
                            // 回边源节点未产出——与串行分支同样视为结构错误。
                            let msg = format!(
                                "loop '{loop_id}' 本轮未执行回边源节点 '{}'",
                                region.back_source
                            );
                            if !allow_failure {
                                return Err(AppError::InvalidQuery(msg));
                            }
                            had_failures = true;
                            last_error = Some(msg.clone());
                            outcomes.push(IterOutcome {
                                index: idx,
                                item,
                                body_results,
                                last_out: None,
                                failed: true,
                                error: Some(msg),
                            });
                        } else {
                            outcomes.push(IterOutcome {
                                index: idx,
                                item,
                                body_results,
                                last_out,
                                failed: false,
                                error: None,
                            });
                        }
                    }
                }
            }

            // 乱序完成后按 item 原序重组 results / _iterations。
            outcomes.sort_by_key(|o| o.index);
            for o in &outcomes {
                if !o.failed {
                    if let Some(ref out) = o.last_out {
                        results_acc.push(out.clone());
                    }
                }
                if iteration_reports.len() < MAX_LOOP_ITERATION_REPORTS {
                    if o.failed {
                        iteration_reports.push(json!({
                            "index": o.index,
                            "failed": true,
                            "error": o.error,
                            "item": o.item,
                            "nodes": o.body_results,
                        }));
                    } else {
                        iteration_reports.push(json!({
                            "index": o.index,
                            "item": o.item,
                            "nodes": o.body_results,
                        }));
                    }
                }
            }
            index = outcomes.len() as u64;
            last_item = outcomes.last().map(|o| o.item.clone());
            // 处理了前 max_iterations 个 item；若数组更长则截断，reached_max 暴露。
            reached_max = max_iterations < items.len() as u64;
        } else {
            loop {
                // 安全上限兜底（所有模式）：达到上限即置 reached_max 强制退出，防死循环。
                if index >= max_iterations {
                    reached_max = match mode.as_str() {
                        "count" => index < count_target,
                        "for_each" => index < items.len() as u64,
                        _ => true,
                    };
                    break;
                }

                // 不依赖 loop 变量的结构性退出（count/for_each）。
                if mode == "count" && index >= count_target {
                    break;
                }
                if mode == "for_each" && index as usize >= items.len() {
                    break;
                }

                // 组装本轮 loop 作用域变量，注入 carry_ctx（假节点 id = "loop"），
                // 使 while 条件与循环体模板都能读到 {{loop.*}}。
                let cur_item = if mode == "for_each" {
                    items.get(index as usize).cloned()
                } else {
                    None
                };
                let mut loop_vars = serde_json::Map::new();
                loop_vars.insert("index".to_string(), json!(index));
                loop_vars.insert("count".to_string(), json!(index + 1));
                loop_vars.insert("reached_max".to_string(), json!(false));
                loop_vars.insert("results".to_string(), json!(results_acc));
                if let Some(ref it) = cur_item {
                    loop_vars.insert("item".to_string(), it.clone());
                    last_item = Some(it.clone());
                }
                carry_ctx
                    .node_outputs
                    .insert("loop".to_string(), JsonValue::Object(loop_vars));

                // while：进体前评估条件，假则退出。
                if mode == "while" {
                    let expr = config
                        .get("expression")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !evaluate_expression(expr, &carry_ctx) {
                        break;
                    }
                }

                // 执行循环体子图（递归；iter_ctx 隔离本轮，含 loop 作用域变量）。
                let mut iter_ctx = carry_ctx.clone();
                let body_results = self
                    .execute_dag(&region.body_def, &mut iter_ctx, call_stack.to_vec())
                    .await?;

                // 循环体硬失败：allow_failure 则记录后续跑，否则中断整个工作流。
                if let Some(failed) = body_results.iter().find(|r| r.status == NodeStatus::Failed) {
                    had_failures = true;
                    last_error = failed.error.clone();
                    if !allow_failure {
                        return Err(AppError::InvalidQuery(format!(
                            "loop '{loop_id}' 循环体节点 '{}' 失败: {}",
                            failed.node_id,
                            failed.error.clone().unwrap_or_default()
                        )));
                    }
                    if iteration_reports.len() < MAX_LOOP_ITERATION_REPORTS {
                        iteration_reports.push(json!({
                            "index": index,
                            "failed": true,
                            "error": failed.error.clone(),
                            "item": cur_item,
                            "nodes": body_results,
                        }));
                    }
                    index += 1;
                    let has_next = index < max_iterations
                        && match mode.as_str() {
                            "count" => index < count_target,
                            "for_each" => index < items.len() as u64,
                            _ => true,
                        };
                    if delay_ms > 0 && has_next {
                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    }
                    continue;
                }

                // 把循环体各节点输出并回 carry_ctx（供 until 条件与下一轮引用），但不覆盖 loop 变量。
                for (k, v) in &iter_ctx.node_outputs {
                    if k == "loop" {
                        continue;
                    }
                    carry_ctx.node_outputs.insert(k.clone(), v.clone());
                }

                // 收集本轮「末节点（回边源）」输出进 {{loop.results}}。
                let last_out = iter_ctx
                    .node_outputs
                    .get(&region.back_source)
                    .cloned()
                    .ok_or_else(|| {
                        AppError::InvalidQuery(format!(
                            "loop '{loop_id}' 本轮未执行回边源节点 '{}'",
                            region.back_source
                        ))
                    })?;
                results_acc.push(last_out);
                if iteration_reports.len() < MAX_LOOP_ITERATION_REPORTS {
                    iteration_reports.push(json!({
                        "index": index,
                        "item": cur_item,
                        "nodes": body_results,
                    }));
                }
                index += 1;

                // until：执行体后评估条件，真则退出（至少执行一次）。
                if mode == "until" {
                    let expr = config
                        .get("expression")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    // until 条件需读到本轮循环体输出：carry_ctx 已并入。
                    if evaluate_expression(expr, &carry_ctx) {
                        break;
                    }
                }

                // 迭代间延迟（轮询场景避免高频打下游）。
                let has_next = index < max_iterations
                    && match mode.as_str() {
                        "count" => index < count_target,
                        "for_each" => index < items.len() as u64,
                        _ => true,
                    };
                if delay_ms > 0 && has_next {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
            }
        }

        let output = json!({
            "loop_mode": mode,
            "iterations": index,
            "index": index.saturating_sub(1),
            "count": index,
            "reached_max": reached_max,
            "results": results_acc,
            "item": last_item,
            "had_failures": had_failures,
            "error": last_error,
            "_iterations": iteration_reports,
            "_iterations_truncated": index as usize > MAX_LOOP_ITERATION_REPORTS,
        });

        tracing::info!(
            target: "workflow",
            workflow_id = ctx.workflow_id,
            run_id = ctx.run_id,
            loop_id = %loop_id,
            mode = %mode,
            iterations = index,
            reached_max = reached_max,
            "loop 节点执行完成"
        );

        // 走 done 出口继续主流程。
        Ok((output, Some(LOOP_DONE_BRANCH.to_string())))
    }

    // ─── CallWorkflow 节点（同步调用子工作流） ─────────────────────────────
    //
    // 子工作流在同进程内内联执行（保持 call_stack 环检测）。真实父 run 下会为子工作流
    // 另写 workflow_runs + execution_index，打开被调用工作流也能看到执行记录。
    // debug / dry_run 不落库。返回值优先取子工作流 response 节点输出，缺省则给出全部
    // 节点输出。dry_run / 生产只读标志透传，子流程副作用照样被拦截。
    //
    // 安全：只在**同租户**内按 slug 解析目标（优先同库），杜绝跨租户取数；通过 call_stack
    // 检测环（A→B→A）与限制层级（≤5），防止递归爆栈 / 死循环。
    async fn exec_call_workflow_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
        call_stack: &[i32],
    ) -> Result<(JsonValue, Option<String>)> {
        use sqlx::Row;

        const MAX_CALL_DEPTH: usize = 5;

        let target_slug = config
            .get("workflow")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AppError::InvalidQuery(
                    "call_workflow 节点缺少 workflow（子工作流 slug）".to_string(),
                )
            })?;

        if call_stack.len() >= MAX_CALL_DEPTH {
            return Err(AppError::InvalidQuery(format!(
                "子工作流调用层级超过上限 {MAX_CALL_DEPTH}（调用链：{call_stack:?}）"
            )));
        }

        // 同租户内按 slug 解析，优先与父节点同库；只取启用中的工作流。
        let row = sqlx::query(
            "SELECT id, tenant_id, database_id, name, nodes, edges, dependencies \
             FROM management.workflows \
             WHERE slug = $1 AND tenant_id IS NOT DISTINCT FROM $2 AND is_enabled = true \
             ORDER BY (database_id IS NOT DISTINCT FROM $3) DESC, id ASC \
             LIMIT 1",
        )
        .bind(target_slug)
        .bind(ctx.tenant_id)
        .bind(ctx.database_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "子工作流 '{target_slug}' 不存在或未启用（同租户内）"
            ))
        })?;

        let target_id: i32 = row.get("id");
        let target_name: String = row.get("name");

        // 环检测：目标是当前工作流自身、或已在调用链上 ⇒ 拒绝。
        if target_id == ctx.workflow_id || call_stack.contains(&target_id) {
            return Err(AppError::InvalidQuery(format!(
                "检测到工作流递归调用：'{target_slug}'(id={target_id}) 已在调用链 {call_stack:?} 中"
            )));
        }

        let target_tenant: Option<i32> = row.get("tenant_id");
        let target_db: Option<i32> = row.get("database_id");
        let nodes: JsonValue = row.get("nodes");
        let edges: JsonValue = row.get("edges");
        let workflow_dependencies: JsonValue = row.get("dependencies");

        let nodes_vec: Vec<WorkflowNode> = serde_json::from_value(nodes).map_err(|e| {
            AppError::InvalidQuery(format!("子工作流 '{target_slug}' 节点解析失败: {e}"))
        })?;
        let edges_vec: Vec<WorkflowEdge> = serde_json::from_value(edges).map_err(|e| {
            AppError::InvalidQuery(format!("子工作流 '{target_slug}' 连线解析失败: {e}"))
        })?;
        let sub_def = WorkflowDefinition {
            nodes: nodes_vec,
            edges: edges_vec,
        };

        // input 作为子工作流 trigger_data。编辑器里以 JSON 字符串保存，这里先解析成对象，
        // 再逐字段 resolve_template（占位符按字段独立替换，杜绝引号破坏 JSON）。
        let input_obj = match config.get("input") {
            Some(v) => parse_json_object_field("call_workflow.input", v)?,
            None => json!({}),
        };
        let input = resolve_template(&input_obj, ctx);

        let started = Instant::now();
        let recorded = if should_record_subworkflow_run(ctx) {
            begin_subworkflow_run(
                &self.pool,
                target_id,
                target_tenant,
                &input,
                ctx.user_id,
                Some(target_name.as_str()),
            )
            .await
        } else {
            None
        };
        let child_run_id = recorded.as_ref().map(|(id, _)| *id).unwrap_or(ctx.run_id);
        let _guard = recorded.as_ref().map(|(run_id, index_id)| {
            SubworkflowRunGuard::new(self.pool.clone(), *run_id, *index_id)
        });

        let mut sub_ctx = ExecutionContext {
            workflow_id: target_id,
            run_id: child_run_id,
            trigger_type: "subworkflow".to_string(),
            trigger_data: input,
            user_id: ctx.user_id,
            tenant_id: target_tenant,
            database_id: target_db.or(ctx.database_id),
            node_outputs: HashMap::new(),
            // 同租户 ⇒ 项目级环境变量一致，直接继承父级，省一次解密查询。
            env_vars: ctx.env_vars.clone(),
            workflow_dependencies,
            dry_run: ctx.dry_run,
            prod_readonly: ctx.prod_readonly,
            // 子流程沿用父级只读护栏（与 dry_run/prod_readonly 一致），使只读 key 的写拦截穿透到 call_workflow。
            apikey_write_guard: ctx.apikey_write_guard,
        };

        // 把"当前工作流"压入调用链后传给子流程，供更深层继续检测环。
        let mut new_stack = call_stack.to_vec();
        new_stack.push(ctx.workflow_id);

        let sub_results = self.execute_dag(&sub_def, &mut sub_ctx, new_stack).await;

        let elapsed_ms = started.elapsed().as_millis() as i64;
        let sub_results = match sub_results {
            Ok(results) => results,
            Err(e) => {
                let msg = e.to_string();
                if let Some((run_id, index_id)) = recorded {
                    finish_subworkflow_run(
                        &self.pool,
                        run_id,
                        index_id,
                        &sub_ctx.env_vars,
                        &[],
                        &JsonValue::Null,
                        Some(&msg),
                        elapsed_ms,
                    )
                    .await;
                    if let Some(g) = &_guard {
                        g.mark_finalized();
                    }
                }
                return Err(e);
            }
        };

        // 返回值：取「实际执行过的」response 节点输出。node_outputs 仅含已执行节点
        // （被跳过分支上的 response 不会写入输出），因此 find_map 会按数组顺序取到
        // 首个真正执行到的 response。这样当子工作流含多个 response（如成功/校验失败各一，
        // 且成功分支的 response 并非数组首个）时，不会误取未执行的 response 而退化成
        // 返回整棵 nodes map（那会让调用方 {{node.body.x}} 静默取到 null）。
        // 只有在没有任何 response 被执行到时，才回退给出全部节点输出。
        let response_output = sub_def
            .nodes
            .iter()
            .filter(|n| n.node_type == NodeType::Response)
            .find_map(|n| sub_ctx.node_outputs.get(&n.id).cloned());

        let output = match response_output {
            Some(v) => v,
            None => json!({ "nodes": sub_ctx.node_outputs }),
        };

        if let Some((run_id, index_id)) = recorded {
            finish_subworkflow_run(
                &self.pool,
                run_id,
                index_id,
                &sub_ctx.env_vars,
                &sub_results,
                &output,
                None,
                elapsed_ms,
            )
            .await;
            if let Some(g) = &_guard {
                g.mark_finalized();
            }
        }

        // 子流程任一节点硬失败 ⇒ 让父节点也失败（父节点可用 allow_failure 容错）。
        if let Some(failed) = sub_results.iter().find(|r| r.status == NodeStatus::Failed) {
            return Err(AppError::InvalidQuery(format!(
                "子工作流 '{}' 节点 '{}' 失败: {}",
                target_slug,
                failed.node_id,
                failed.error.clone().unwrap_or_default()
            )));
        }

        Ok((output, None))
    }

    // ─── SSE 推送节点 ─────────────────────────────────────────

    /// 推送 SSE 消息。`topic` 支持 `{database_id}` 等占位符；`user:{{trigger.ids}}:notify` 或
    /// `user_ids` 字段可展开为多条 `user:{id}:*` 推送，列表较大时按 `batch_size` 分批。
    async fn exec_sse_publish_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        let topic_tpl = config
            .get("topic")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::InvalidQuery("sse_publish 节点缺少 topic 字段".to_string()))?;
        if topic_tpl.trim().is_empty() {
            return Err(AppError::InvalidQuery(
                "sse_publish 节点 topic 不能为空".to_string(),
            ));
        }

        let event = config
            .get("event")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("message")
            .to_string();

        // data：前端用文本框填 JSON 字符串。空串 → 退回本次触发数据；非空且能解析 → 解析后的 JSON；
        // 解析失败 → 当作纯字符串；非字符串值 → 原样。
        let data = match config.get("data") {
            Some(JsonValue::String(s)) if !s.trim().is_empty() => {
                serde_json::from_str(s).unwrap_or_else(|_| JsonValue::String(s.clone()))
            }
            Some(JsonValue::String(_)) | None => ctx.trigger_data.clone(),
            Some(v) => v.clone(),
        };

        if let Some(recipients) = resolve_sse_user_id_list(topic_tpl, config.get("user_ids"), ctx)?
        {
            let settings = crate::sse_batch_config::sse_batch_settings();
            let max_recipients = effective_max_recipients(config, settings);
            if max_recipients > 0 && recipients.len() > max_recipients {
                return Err(AppError::InvalidQuery(format!(
                    "recipient 数量 ({}) 超过上限 ({})",
                    recipients.len(),
                    max_recipients
                )));
            }

            let batch_size = effective_sse_batch_size(config, settings);
            let topics = expand_user_topics(topic_tpl, &recipients, ctx)?;

            if recipients.len() == 1 {
                let topic = topics
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| resolve_sse_topic(topic_tpl, ctx));
                let delivered = crate::sse_publisher::publish(topic.clone(), event.clone(), data);
                return Ok((
                    json!({ "topic": topic, "event": event, "delivered": delivered }),
                    None,
                ));
            }

            let dispatch = resolve_sse_dispatch_mode(config, recipients.len(), settings);
            if let SseDispatchMode::Async { auto_async } = dispatch {
                let topics_for_task = topics.clone();
                let event_for_task = event.clone();
                let data_for_task = data.clone();
                let delay_ms = settings.batch_delay_ms;
                tokio::spawn(async move {
                    publish_user_topics_batched(
                        &topics_for_task,
                        &event_for_task,
                        &data_for_task,
                        batch_size,
                        delay_ms,
                    )
                    .await;
                });
                return Ok((
                    json!({
                        "count": recipients.len(),
                        "async": true,
                        "auto_async": auto_async,
                        "batch_size": batch_size,
                        "dispatched": true,
                    }),
                    None,
                ));
            }

            let batches = batch_count(topics.len(), batch_size);
            let delivered = publish_user_topics_batched(
                &topics,
                &event,
                &data,
                batch_size,
                settings.batch_delay_ms,
            )
            .await;
            return Ok((
                json!({
                    "count": recipients.len(),
                    "batches": batches,
                    "batch_size": batch_size,
                    "event": event,
                    "delivered": delivered,
                }),
                None,
            ));
        }

        let topic = resolve_sse_topic(topic_tpl, ctx);
        let delivered = crate::sse_publisher::publish(topic.clone(), event.clone(), data);

        Ok((
            json!({ "topic": topic, "event": event, "delivered": delivered }),
            None,
        ))
    }

    // ─── Code 节点 ─────────────────────────────────────────

    async fn exec_code_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        use crate::lua_engine::{LuaEngine, PluginContext};

        let raw_code = config
            .get("code")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::InvalidQuery("code 节点缺少 code 字段".to_string()))?;
        // 导入时若 JSON 多转义一层，脚本只剩字面 `\n`，lua.load 会把两条语句粘成一行。
        let code = restore_escaped_script_newlines(raw_code);

        let plugin_ctx = PluginContext {
            method: "WORKFLOW".to_string(),
            path: format!("/workflow/{}", ctx.workflow_id),
            schema: None,
            table: None,
            body: Some(ctx.trigger_data.clone()),
            query_params: None,
            headers: None,
            user_id: ctx.user_id,
            tenant_id: ctx.tenant_id,
            database_id: ctx.database_id,
            request_id: Some(format!("wf-run-{}", ctx.run_id)),
            nodes: None,
        };

        let language = config
            .get("language")
            .and_then(|value| value.as_str())
            .unwrap_or("lua");

        // `nodes` is part of the plugin contract for both Lua and JavaScript code nodes.
        let nodes_json: JsonValue = ctx.node_outputs.clone().into_iter().collect();
        if language.eq_ignore_ascii_case("javascript") || language.eq_ignore_ascii_case("js") {
            let output = crate::js_runner::execute_javascript(crate::js_runner::JsExecRequest {
                workflow_id: ctx.workflow_id,
                code: code.to_string(),
                plugin_ctx: PluginContext {
                    nodes: Some(nodes_json),
                    ..plugin_ctx
                },
                env_vars: ctx.env_vars.clone(),
                tenant_id: ctx.tenant_id,
                http_disabled: ctx.prod_readonly,
                timeout_ms: crate::js_runner::js_timeout_ms(),
                js_dependencies: crate::js_deps::parse_javascript_deps(&ctx.workflow_dependencies),
            })
            .await
            .map_err(|error| AppError::Internal(format!("JavaScript 执行失败: {error}")))?;
            return Ok((output, None));
        }

        if language.eq_ignore_ascii_case("python") || language.eq_ignore_ascii_case("py") {
            let output = crate::py_runner::execute_python(crate::py_runner::PyExecRequest {
                workflow_id: ctx.workflow_id,
                code: code.to_string(),
                plugin_ctx: PluginContext {
                    nodes: Some(nodes_json),
                    ..plugin_ctx
                },
                env_vars: ctx.env_vars.clone(),
                tenant_id: ctx.tenant_id,
                http_disabled: ctx.prod_readonly,
                timeout_ms: crate::py_runner::py_timeout_ms(),
                py_dependencies: crate::py_deps::parse_python_deps(&ctx.workflow_dependencies),
            })
            .await
            .map_err(|error| AppError::Internal(format!("Python 执行失败: {error}")))?;
            return Ok((output, None));
        }

        // 将所有上游节点输出注入 ctx.nodes，并将用户代码包裹在 execute(ctx) 中：
        // - 用 IIFE 捕获 return {} 的返回值，写入 ctx.body（供 extract_result 读取）
        // - 用户代码可以直接 return {} 也可以手动 ctx.body = {}，两种写法均兼容
        // - nodes 经 mlua 直接注入 ctx，避免 JSON 嵌入 Lua 单引号字符串时 \n 等被 Lua 展开破坏 JSON
        let wrapped_code = format!(
            r#"
function execute(_ctx)
    local _result = (function()
{}
    end)()
    if _result ~= nil then _ctx.body = _result end
end
"#,
            code
        );

        // 传入项目环境变量，供 Lua env.get 读取（与 {{env.X}} 模板同源）
        let mut engine = LuaEngine::new(1, lua_node_timeout_ms(), 32 * 1024 * 1024)
            .with_env_vars(ctx.env_vars.clone())
            .with_tenant_id(ctx.tenant_id);
        if ctx.prod_readonly {
            // 生产只读护栏：Lua http 是副作用逃生舱，必须一并禁用
            engine = engine.with_http_disabled();
        }
        let result = engine
            .execute_plugin(
                &wrapped_code,
                "execute",
                &PluginContext {
                    nodes: Some(nodes_json),
                    ..plugin_ctx
                },
            )
            .await
            .map_err(|e| AppError::Internal(format!("Lua 执行失败: {}", e)))?;

        let output = result
            .modified_body
            .or(result.response_body)
            .unwrap_or(JsonValue::Null);
        Ok((output, None))
    }

    // ─── DB Query 节点（只读） ─────────────────────────────────────────

    async fn exec_db_query_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        // 动态 SQL 开关（默认关）：开启后整条 sql 视为模板、先解析成文本再原样执行
        // （不参数化）——用于表名/字段等标识符随上游变化、无法用绑定参数的场景。
        // 关闭时保持原状：sql 原文 + {{}} 走参数化绑定，防注入。开关只对能编辑工作流
        // （含 code 节点=任意代码）的作者开放，且作者需自行转义内联到 SQL 里的用户输入。
        let dynamic = config
            .get("dynamic_sql")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let resolved_sql;
        let sql: &str = if dynamic {
            let v = resolve_template(config.get("sql").unwrap_or(&JsonValue::Null), ctx);
            resolved_sql = v.as_str().map(|s| s.to_string()).ok_or_else(|| {
                AppError::InvalidQuery("db_query 动态 SQL 解析结果不是字符串".to_string())
            })?;
            resolved_sql.as_str()
        } else {
            config
                .get("sql")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::InvalidQuery("db_query 节点缺少 sql 字段".to_string()))?
        };

        // 安全检查：只允许 SELECT / WITH（动态模式对解析后的文本同样校验）。
        // 必须先剥注释，否则 `-- 说明\nSELECT ...` 会被当成非法首词 `--`。
        let first_word = sql_leading_keyword(sql);
        if !matches!(first_word.as_str(), "SELECT" | "WITH") {
            return Err(AppError::InvalidQuery(
                "db_query 节点只允许 SELECT/WITH 语句".to_string(),
            ));
        }

        let conn = self.workflow_db_conn(config, ctx, "db_query").await?;

        // 显式 params 数组（PG 手写 $1..$n / MySQL 手写 ?，已在上游解析）先绑定；SQL 里的
        // 内联 {{}} 由参数化改写成占位符并自动绑定——用户输入只走参数绑定，不拼进 SQL 文本，
        // 杜绝注入。动态模式下不参数化（整条 SQL 原样执行）。
        let explicit_params: Vec<JsonValue> = config
            .get("params")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        match conn {
            DatasourceConn::Pg(pool) => {
                let (final_sql, auto_binds): (String, Vec<JsonValue>) = if dynamic {
                    (sql.to_string(), Vec::new())
                } else {
                    parameterize_sql_templates(sql, ctx, explicit_params.len() + 1)
                };
                let mut query = sqlx::query(&final_sql);
                if !dynamic {
                    for p in &explicit_params {
                        query = bind_json_param(query, p);
                    }
                }
                for p in &auto_binds {
                    query = bind_json_param(query, p);
                }

                // statement_timeout 护栏：慢 SQL 不能无限占池连接。
                let mut conn = crate::pool_metrics::acquire_traced(
                    &pool,
                    node_pool_key(config, ctx),
                    "db_query",
                )
                .await
                .map_err(AppError::Database)?;
                let policy = workflow_db_raw_sql_policy();
                crate::raw_sql_guard::apply_session_guards(&mut conn, policy).await?;
                let rows_result = async {
                    // 只读护栏：READ ONLY 事务由 PostgreSQL 拒绝任何写入，防止数据修改型 CTE
                    // （WITH x AS (INSERT ... RETURNING *) SELECT）绕过首词检查。
                    // enforce 下数据修改型 CTE 已在 execute_node 前置识别并 403 短路，正常到不了这里；
                    // 此处 READ ONLY 作为**兜底**：静态正则漏判的 CTE 由 PG 运行时拒绝（报错而非静默写），
                    // 同时覆盖生产只读（prod_readonly）。log_only 档不改行为（只观测，不 READ ONLY）。
                    if ctx.prod_readonly || ctx.should_block_db_write() {
                        use sqlx::Connection;
                        let mut tx = conn.begin().await?;
                        sqlx::query("SET TRANSACTION READ ONLY")
                            .execute(&mut *tx)
                            .await?;
                        let rows = query.fetch_all(&mut *tx).await?;
                        tx.rollback().await?;
                        Ok::<_, AppError>(rows)
                    } else {
                        Ok(query.fetch_all(&mut *conn).await?)
                    }
                }
                .await;
                crate::raw_sql_guard::reset_session_guards(&mut conn).await;
                let rows = rows_result?;
                let results: Vec<JsonValue> = rows.iter().map(pg_row_to_json).collect();
                Ok((json!({ "rows": results, "count": results.len() }), None))
            }
            DatasourceConn::MySql(pool) => {
                // 文本协议（不预编译），兼容 Doris/StarRocks。动态模式原样执行；
                // 否则把 ? 与 {{}} 转义内联进 SQL。
                let final_sql = if dynamic {
                    sql.to_string()
                } else {
                    mysql_inline_sql(sql, ctx, &explicit_params)
                };
                let rows = sqlx::raw_sql(&final_sql).fetch_all(&pool).await?;
                let results: Vec<JsonValue> = rows.iter().map(mysql_row_to_json).collect();
                Ok((json!({ "rows": results, "count": results.len() }), None))
            }
        }
    }

    // ─── DB Execute 节点（写操作） ─────────────────────────────────────────

    async fn exec_db_execute_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        // 动态 SQL 开关（默认关）：见 exec_db_query_node 说明。
        let dynamic = config
            .get("dynamic_sql")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let resolved_sql;
        let sql: &str = if dynamic {
            let v = resolve_template(config.get("sql").unwrap_or(&JsonValue::Null), ctx);
            resolved_sql = v.as_str().map(|s| s.to_string()).ok_or_else(|| {
                AppError::InvalidQuery("db_execute 动态 SQL 解析结果不是字符串".to_string())
            })?;
            resolved_sql.as_str()
        } else {
            config
                .get("sql")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::InvalidQuery("db_execute 节点缺少 sql 字段".to_string()))?
        };

        // DDL 拦截（动态模式对解析后的文本同样校验）
        let first_word = sql_leading_keyword(sql);
        if matches!(first_word.as_str(), "DROP" | "TRUNCATE") {
            return Err(AppError::InvalidQuery(
                "db_execute 节点禁止 DROP/TRUNCATE 操作".to_string(),
            ));
        }

        let conn = self.workflow_db_conn(config, ctx, "db_execute").await?;

        // 同 db_query：显式 params 先绑，SQL 内联 {{}} 自动参数化接在其后，防注入。
        // 动态模式下不参数化（整条 SQL 原样执行）。
        let explicit_params: Vec<JsonValue> = config
            .get("params")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        match conn {
            DatasourceConn::Pg(pool) => {
                let (final_sql, auto_binds): (String, Vec<JsonValue>) = if dynamic {
                    (sql.to_string(), Vec::new())
                } else {
                    parameterize_sql_templates(sql, ctx, explicit_params.len() + 1)
                };
                let mut query = sqlx::query(&final_sql);
                if !dynamic {
                    for p in &explicit_params {
                        query = bind_json_param(query, p);
                    }
                }
                for p in &auto_binds {
                    query = bind_json_param(query, p);
                }
                let mut conn = crate::pool_metrics::acquire_traced(
                    &pool,
                    node_pool_key(config, ctx),
                    "db_execute",
                )
                .await
                .map_err(AppError::Database)?;
                let policy = workflow_db_raw_sql_policy();
                crate::raw_sql_guard::apply_session_guards(&mut conn, policy).await?;
                let result = query.execute(&mut *conn).await;
                crate::raw_sql_guard::reset_session_guards(&mut conn).await;
                let result = result?;
                Ok((json!({ "rows_affected": result.rows_affected() }), None))
            }
            DatasourceConn::MySql(pool) => {
                // 文本协议（不预编译），兼容 Doris/StarRocks。动态模式原样执行；
                // 否则把 ? 与 {{}} 转义内联进 SQL。
                let final_sql = if dynamic {
                    sql.to_string()
                } else {
                    mysql_inline_sql(sql, ctx, &explicit_params)
                };
                let result = sqlx::raw_sql(&final_sql).execute(&pool).await?;
                Ok((json!({ "rows_affected": result.rows_affected() }), None))
            }
        }
    }

    // ─── DbTransaction 节点 ─────────────────────────────────────────

    async fn exec_db_transaction_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        let statements = config
            .get("statements")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                AppError::InvalidQuery("db_transaction 节点缺少 statements 数组".to_string())
            })?;

        let pool = self
            .workflow_database_pool(config, ctx, "db_transaction")
            .await?;
        let mut conn = crate::pool_metrics::acquire_traced(
            &pool,
            node_pool_key(config, ctx),
            "db_transaction",
        )
        .await
        .map_err(AppError::Database)?;
        let policy = workflow_db_raw_sql_policy();
        crate::raw_sql_guard::apply_session_guards(&mut conn, policy).await?;

        let tx_result = async {
            use sqlx::Connection;
            let mut tx = conn.begin().await?;
            let mut total_affected: u64 = 0;

            for stmt in statements {
                let sql = stmt.get("sql").and_then(|v| v.as_str()).ok_or_else(|| {
                    AppError::InvalidQuery("db_transaction statements 缺少 sql 字段".to_string())
                })?;

                let first_word = sql_leading_keyword(sql);
                if matches!(first_word.as_str(), "DROP" | "TRUNCATE") {
                    return Err(AppError::InvalidQuery(
                        "db_transaction 禁止 DROP/TRUNCATE".to_string(),
                    ));
                }

                // stmt.params 已在上游 resolve_template_skip_keys 解析过，这里不再二次解析；
                // SQL 内联 {{}} 由 parameterize_sql_templates 改写成 $N 并自动绑定，防注入。
                let explicit_params: Vec<JsonValue> = stmt
                    .get("params")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let (final_sql, auto_binds) =
                    parameterize_sql_templates(sql, ctx, explicit_params.len() + 1);

                let mut query = sqlx::query(&final_sql);
                for p in &explicit_params {
                    query = bind_json_param(query, p);
                }
                for p in &auto_binds {
                    query = bind_json_param(query, p);
                }
                let result = query.execute(&mut *tx).await?;
                total_affected += result.rows_affected();
            }

            tx.commit().await?;
            Ok::<_, AppError>((
                json!({
                    "rows_affected": total_affected,
                    "statements_count": statements.len()
                }),
                None,
            ))
        }
        .await;

        crate::raw_sql_guard::reset_session_guards(&mut conn).await;
        tx_result
    }

    // ─── ForEach 节点 ─────────────────────────────────────────

    async fn exec_foreach_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        let items_path = config
            .get("items")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::InvalidQuery("foreach 节点缺少 items 字段".to_string()))?;

        // 通过模板解析取出数组
        let template_val = json!(format!("{{{{{}}}}}", items_path));
        let items = match resolve_template(&template_val, ctx) {
            JsonValue::Array(arr) => arr,
            _ => {
                return Err(AppError::InvalidQuery(format!(
                    "foreach items '{}' 解析结果不是数组",
                    items_path
                )))
            }
        };

        let statements = config
            .get("statements")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                AppError::InvalidQuery("foreach 节点缺少 statements 数组".to_string())
            })?;

        let item_var = config
            .get("item_var")
            .and_then(|v| v.as_str())
            .unwrap_or("item");

        let pool = self.workflow_database_pool(config, ctx, "foreach").await?;
        let item_count = items.len();

        let mut conn =
            crate::pool_metrics::acquire_traced(&pool, node_pool_key(config, ctx), "foreach")
                .await
                .map_err(AppError::Database)?;
        let policy = workflow_db_raw_sql_policy();
        crate::raw_sql_guard::apply_session_guards(&mut conn, policy).await?;

        let foreach_result = async {
            use sqlx::Connection;
            let mut total_affected: u64 = 0;

            for item in items {
                let mut item_ctx = ctx.clone();
                item_ctx.node_outputs.insert(item_var.to_string(), item);

                let mut tx = conn.begin().await?;
                for stmt in statements {
                    let sql = stmt.get("sql").and_then(|v| v.as_str()).ok_or_else(|| {
                        AppError::InvalidQuery("foreach statement 缺少 sql 字段".to_string())
                    })?;

                    let first_word = sql_leading_keyword(sql);
                    if matches!(first_word.as_str(), "DROP" | "TRUNCATE") {
                        return Err(AppError::InvalidQuery(
                            "foreach 禁止 DROP/TRUNCATE".to_string(),
                        ));
                    }

                    let raw_params = stmt.get("params").and_then(|v| v.as_array());
                    let resolved_params: Vec<JsonValue> = raw_params
                        .map(|ps| ps.iter().map(|p| resolve_template(p, &item_ctx)).collect())
                        .unwrap_or_default();

                    let mut query = sqlx::query(sql);
                    for p in &resolved_params {
                        query = bind_json_param(query, p);
                    }
                    let result = query.execute(&mut *tx).await?;
                    total_affected += result.rows_affected();
                }
                tx.commit().await?;
            }

            Ok::<_, AppError>((
                json!({ "processed": item_count, "rows_affected": total_affected }),
                None,
            ))
        }
        .await;

        crate::raw_sql_guard::reset_session_guards(&mut conn).await;
        foreach_result
    }

    /// 解析 db 节点应使用的连接（可能是 PG 或 MySQL）。
    ///
    /// - 节点显式选择了数据源（config.datasource_id）→ 覆盖默认库，按其类型分流。
    /// - 未选择（老数据即如此）→ 落到 workflow.database_id 默认路径（恒为 PG 业务库），
    ///   即设计稿的「默认（工作流绑定库）」。默认值在此真实生效，非仅前端展示。
    async fn workflow_db_conn(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
        node_type: &str,
    ) -> Result<DatasourceConn> {
        if let Some(ds_id) = extract_datasource_id(config) {
            return resolve_datasource_conn(&self.pool, ctx.tenant_id, ds_id)
                .await
                .map_err(|e| {
                    AppError::Internal(format!(
                        "{} 节点无法解析数据源 {} 的连接: {}",
                        node_type, ds_id, e
                    ))
                });
        }

        let database_id = ctx.database_id.ok_or_else(|| {
            AppError::InvalidQuery(format!(
                "{} 节点缺少 workflow.database_id，拒绝回退到管理库执行 SQL",
                node_type
            ))
        })?;

        let pool = self
            .ensure_workflow_pool_loaded(database_id)
            .await
            .map_err(|e| {
                AppError::Internal(format!(
                    "{} 节点无法解析 database_id={} 的业务库连接: {}",
                    node_type, database_id, e
                ))
            })?;
        Ok(DatasourceConn::Pg(pool))
    }

    /// 便捷包装：只接受 PG 连接（db_transaction / foreach 等尚未适配 MySQL 的节点用）。
    async fn workflow_database_pool(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
        node_type: &str,
    ) -> Result<PgPool> {
        match self.workflow_db_conn(config, ctx, node_type).await? {
            DatasourceConn::Pg(pool) => Ok(pool),
            DatasourceConn::MySql(_) => Err(AppError::InvalidQuery(format!(
                "{} 节点暂不支持 MySQL 数据源，请改用 PostgreSQL 数据源或默认库",
                node_type
            ))),
        }
    }

    async fn ensure_workflow_pool_loaded(&self, database_id: i32) -> Result<PgPool> {
        use crate::pool_manager::{DatabaseConfig, POOL_MANAGER};
        use sqlx::Row;

        if let Some(pool) = POOL_MANAGER.get_write_pool(database_id) {
            return Ok(pool);
        }

        let row = sqlx::query(
            r#"
            SELECT id, db_host, db_port, db_name, db_user, db_password_encrypted,
                   max_connections, connection_timeout
            FROM management.tenant_databases
            WHERE id = $1 AND is_active = true
            "#,
        )
        .bind(database_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("数据库连接 {} 不存在或已禁用", database_id)))?;

        let encrypted_password: String = row.get("db_password_encrypted");
        let config = DatabaseConfig {
            id: row.get("id"),
            host: row.get("db_host"),
            port: row.get("db_port"),
            database: row.get("db_name"),
            username: row.get("db_user"),
            password: crate::crypto::decrypt_secret_lossy(&encrypted_password).to_string(),
            max_connections: row
                .get::<Option<i32>, _>("max_connections")
                .unwrap_or(crate::pool_manager::DEFAULT_TENANT_MAX_CONNECTIONS as i32)
                as u32,
            connection_timeout: row
                .get::<Option<i32>, _>("connection_timeout")
                .unwrap_or(crate::pool_manager::DEFAULT_TENANT_ACQUIRE_TIMEOUT_SECS as i32)
                as u64,
        };

        POOL_MANAGER.get_or_create_pool(config).await
    }

    // ─── Redis 节点 ─────────────────────────────────────────
    //
    // config: `{ "connection_id": <i64>, "op": "get|set|del|...", ...args... }`
    // 其余字段（key/value/ttl/...）先跑 resolve_template（占位符替换）再交给
    // 精选命令层执行。连接按 ctx.tenant_id 校验，跨租户取数直接拒绝。
    //
    // dry_run / 生产只读：写操作（set/del/...）返回 mock，读操作照常执行——与
    // db_query(读) / db_execute(写) 的护栏语义一致。副作用节点无法只凭 node_type
    // 判断读写，故不走 side_effect_mock，改在此处按 op 拦截。
    async fn exec_redis_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        use crate::redis_ds::{client_cache, commands, fetch_active_for_tenant};

        let connection_id = config
            .get("connection_id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| {
                AppError::InvalidQuery("redis 节点缺少 connection_id（整数）".to_string())
            })?;
        let op = config
            .get("op")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidQuery("redis 节点缺少 op".to_string()))?
            .to_lowercase();

        // 写操作在 dry_run / 生产只读下走 mock，不真正落库。
        if (ctx.dry_run || ctx.prod_readonly) && commands::is_write_op(&op) {
            let mut mock = json!({ "op": op, "result": null });
            if let Some(obj) = mock.as_object_mut() {
                if ctx.prod_readonly && !ctx.dry_run {
                    obj.insert(
                        "blocked_by".to_string(),
                        JsonValue::from("production_readonly"),
                    );
                } else {
                    obj.insert("dry_run".to_string(), JsonValue::Bool(true));
                }
            }
            return Ok((mock, None));
        }

        let tenant_id = ctx.tenant_id.ok_or_else(|| {
            AppError::InvalidQuery("redis 节点需要 workflow.tenant_id 才能解析连接".to_string())
        })?;

        // args = config 去掉 connection_id / op 后的其余字段。占位符（{{...}}）已由
        // 调度器在 execute_node 前统一 resolve_template 过（见 run() 里的 `_` 分支），
        // 此处不再重复替换。
        let mut args = config.clone();
        if let Some(obj) = args.as_object_mut() {
            obj.remove("connection_id");
            obj.remove("op");
        }

        let conn = fetch_active_for_tenant(&self.pool, connection_id, tenant_id).await?;
        let manager = client_cache::get_or_create(&conn).await?;
        let result = commands::execute(&manager, &op, &args).await?;

        Ok((json!({ "op": op, "result": result }), None))
    }

    // ─── Kafka 节点 ─────────────────────────────────────────
    //
    // config: `{ "connection_id": <i64>, "op": "produce|list_topics", ...args... }`
    // 其余字段（topic/key/value/headers/...）先跑 resolve_template 再交给命令层。
    // 连接按 ctx.tenant_id 校验，跨租户取数直接拒绝。
    //
    // dry_run / 生产只读：写操作（produce）返回 mock，读操作照常执行。
    async fn exec_kafka_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        use crate::kafka_ds::{client_cache, commands, fetch_active_for_tenant};

        let connection_id = config
            .get("connection_id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| {
                AppError::InvalidQuery("kafka 节点缺少 connection_id（整数）".to_string())
            })?;
        let op = config
            .get("op")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidQuery("kafka 节点缺少 op".to_string()))?
            .to_lowercase();

        if (ctx.dry_run || ctx.prod_readonly) && commands::is_write_op(&op) {
            let mut mock = json!({ "op": op, "result": null });
            if let Some(obj) = mock.as_object_mut() {
                if ctx.prod_readonly && !ctx.dry_run {
                    obj.insert(
                        "blocked_by".to_string(),
                        JsonValue::from("production_readonly"),
                    );
                } else {
                    obj.insert("dry_run".to_string(), JsonValue::Bool(true));
                }
            }
            return Ok((mock, None));
        }

        let tenant_id = ctx.tenant_id.ok_or_else(|| {
            AppError::InvalidQuery("kafka 节点需要 workflow.tenant_id 才能解析连接".to_string())
        })?;

        let mut args = config.clone();
        if let Some(obj) = args.as_object_mut() {
            obj.remove("connection_id");
            obj.remove("op");
        }

        let conn = fetch_active_for_tenant(&self.pool, connection_id, tenant_id).await?;
        let producer = client_cache::get_or_create(&conn).await?;
        let result = commands::execute(&producer, &op, &args).await?;

        Ok((json!({ "op": op, "result": result }), None))
    }

    // ─── 对象存储节点 ─────────────────────────────────────────
    //
    // config: `{ "connection_id": <i64>, "op": "put|get|delete|list|presign", ...args... }`
    // 其余字段先经 resolve_template，再交给 commands::execute。
    // dry_run / 生产只读：写操作（put/delete/presign PUT）返回 mock。
    async fn exec_object_storage_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        use crate::object_storage_ds::{client_cache, commands, fetch_active_for_tenant};

        let connection_id = config
            .get("connection_id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| {
                AppError::InvalidQuery("object_storage 节点缺少 connection_id（整数）".to_string())
            })?;
        let op = config
            .get("op")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidQuery("object_storage 节点缺少 op".to_string()))?
            .to_lowercase();

        let mut args = config.clone();
        if let Some(obj) = args.as_object_mut() {
            obj.remove("connection_id");
            obj.remove("op");
        }

        if (ctx.dry_run || ctx.prod_readonly) && commands::is_write_op(&op, &args) {
            let mut mock = json!({ "op": op, "result": null });
            if let Some(obj) = mock.as_object_mut() {
                if ctx.prod_readonly && !ctx.dry_run {
                    obj.insert(
                        "blocked_by".to_string(),
                        JsonValue::from("production_readonly"),
                    );
                } else {
                    obj.insert("dry_run".to_string(), JsonValue::Bool(true));
                }
            }
            return Ok((mock, None));
        }

        let tenant_id = ctx.tenant_id.ok_or_else(|| {
            AppError::InvalidQuery(
                "object_storage 节点需要 workflow.tenant_id 才能解析连接".to_string(),
            )
        })?;

        let conn = fetch_active_for_tenant(&self.pool, connection_id, tenant_id).await?;
        let handle = client_cache::get_or_create(&conn).await?;
        let result = commands::execute(&handle, &conn.bucket, &op, &args).await?;

        Ok((json!({ "op": op, "result": result }), None))
    }

    // ─── HTTP Call 节点 ─────────────────────────────────────────

    async fn exec_http_call_node(&self, config: &JsonValue) -> Result<(JsonValue, Option<String>)> {
        use crate::http_async_poll::{
            parse_async_poll_config, run_async_poll_loop, HttpExchange, PollRequest,
        };

        let url = config
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::InvalidQuery("http_call 节点缺少 url 字段".to_string()))?;

        let method = config
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_uppercase();

        // 内网黑名单
        if crate::http_async_poll::is_private_url(url) {
            return Err(AppError::InvalidQuery(
                "http_call 不允许访问内网地址".to_string(),
            ));
        }

        // 超时可由节点配置 timeout_secs（兼容 timeout）指定，单位秒；配置为 0 表示不限制
        // （由 workflow.timeout_ms 兜底）。未显式配置时取 http_default_timeout_secs()
        // （环境变量 WORKFLOW_HTTP_DEFAULT_TIMEOUT_SECS，缺省 120；全局关闭超时时为 0）。
        // 权威边界用 tokio::time::timeout 包裹整次请求（含读 body），避免 reqwest client
        // timeout 在 TCP 半开/慢速保活场景下无法及时中止；connect_timeout 仅约束握手阶段。
        let timeout_secs = config
            .get("timeout_secs")
            .or_else(|| config.get("timeout"))
            .and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_i64().filter(|n| *n >= 0).map(|n| n as u64))
                    .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
            })
            .unwrap_or_else(http_default_timeout_secs);

        let headers = match config.get("headers") {
            Some(v) => Some(parse_json_object_field("http_call.headers", v)?),
            None => None,
        };
        let auth_headers: HashMap<String, String> = headers
            .as_ref()
            .and_then(JsonValue::as_object)
            .map(|headers| {
                headers
                    .iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|value| (key.clone(), value.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let body_config = match config.get("body") {
            Some(v) => parse_json_field("http_call.body", v)?,
            None => None,
        };
        let url = url.to_string();

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| AppError::Internal(format!("HTTP 客户端创建失败: {}", e)))?;

        let initial_client = client.clone();
        let initial_url = url.clone();
        let execute = async move {
            let mut req = match method.as_str() {
                "POST" => initial_client.post(&initial_url),
                "PUT" => initial_client.put(&initial_url),
                "PATCH" => initial_client.patch(&initial_url),
                "DELETE" => initial_client.delete(&initial_url),
                _ => initial_client.get(&initial_url),
            };

            if let Some(headers) = headers.as_ref().and_then(|v| v.as_object()) {
                for (k, v) in headers {
                    if let Some(val) = v.as_str() {
                        req = req.header(k.as_str(), val);
                    }
                }
            }

            if let Some(body) = &body_config {
                req = req.json(body);
            }

            let resp = req
                .send()
                .await
                .map_err(|e| AppError::Internal(format!("HTTP 请求失败: {}", e)))?;

            let status = resp.status().as_u16();
            let resp_headers: HashMap<String, String> = resp
                .headers()
                .iter()
                .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
                .collect();

            let body_text = resp
                .text()
                .await
                .map_err(|e| AppError::Internal(format!("读取响应失败: {}", e)))?;

            let body_json: JsonValue = serde_json::from_str(&body_text).unwrap_or(json!(body_text));

            Ok::<JsonValue, AppError>(json!({
                "status": status,
                "headers": resp_headers,
                "body": body_json,
            }))
        };

        let output = if timeout_secs > 0 {
            tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), execute)
                .await
                .map_err(|_| {
                    AppError::Internal(format!("HTTP 请求超时（超过 {} 秒未响应）", timeout_secs))
                })??
        } else {
            execute.await?
        };

        let poll_cfg = parse_async_poll_config(config);
        if !poll_cfg.enabled {
            return Ok((output, None));
        }
        let poll_client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| AppError::Internal(format!("HTTP 轮询客户端创建失败: {}", e)))?;

        let status = output["status"].as_u64().unwrap_or(0) as u16;
        let headers: HashMap<String, String> = output["headers"]
            .as_object()
            .map(|headers| {
                headers
                    .iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|value| (key.clone(), value.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let body = output["body"].clone();
        let initial = HttpExchange {
            status,
            headers,
            body: body.clone(),
            body_text: serde_json::to_string(&body).unwrap_or_default(),
        };
        let url_for_poll = url.clone();
        let (final_exchange, meta) = run_async_poll_loop(
            &poll_cfg,
            &url_for_poll,
            initial,
            &auth_headers,
            |request: PollRequest| {
                let client = poll_client.clone();
                async move {
                    let mut request_builder = match request.method.as_str() {
                        "POST" => client.post(&request.url),
                        "PUT" => client.put(&request.url),
                        "PATCH" => client.patch(&request.url),
                        "DELETE" => client.delete(&request.url),
                        _ => client.get(&request.url),
                    };
                    for (key, value) in request.headers {
                        request_builder = request_builder.header(key, value);
                    }
                    if let Some(body) = request.json_body {
                        request_builder = request_builder.json(&body);
                    }

                    let execute = async {
                        let response = request_builder
                            .send()
                            .await
                            .map_err(|error| format!("HTTP 请求失败: {}", error))?;
                        let status = response.status().as_u16();
                        let headers = response
                            .headers()
                            .iter()
                            .filter_map(|(key, value)| {
                                Some((key.to_string(), value.to_str().ok()?.to_string()))
                            })
                            .collect();
                        let body_text = response
                            .text()
                            .await
                            .map_err(|error| format!("读取响应失败: {}", error))?;
                        let body = serde_json::from_str(&body_text).unwrap_or(json!(body_text));
                        Ok::<HttpExchange, String>(HttpExchange {
                            status,
                            headers,
                            body,
                            body_text,
                        })
                    };

                    if timeout_secs > 0 {
                        tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), execute)
                            .await
                            .map_err(|_| {
                                format!("HTTP 请求超时（超过 {} 秒未响应）", timeout_secs)
                            })?
                    } else {
                        execute.await
                    }
                }
            },
        )
        .await
        .map_err(AppError::Internal)?;

        Ok((
            json!({
                "status": final_exchange.status,
                "headers": final_exchange.headers,
                "body": final_exchange.body,
                "async_poll": meta,
            }),
            None,
        ))
    }

    // ─── Email Send 节点 ─────────────────────────────────────────

    async fn exec_email_send_node(
        &self,
        config: &JsonValue,
    ) -> Result<(JsonValue, Option<String>)> {
        let config = EmailSendConfig::from_json(config)?;
        let accepted = config.to.len() + config.cc.len() + config.bcc.len();
        let subject = config.subject.clone();
        send_email(config).await?;

        Ok((
            json!({
                "sent": true,
                "accepted": accepted,
                "subject": subject,
            }),
            None,
        ))
    }

    // ─── Condition 节点 ─────────────────────────────────────────

    async fn exec_condition_node(
        &self,
        config: &JsonValue,
        ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        // 形态 A（多分支）：config.conditions = [{ branch, expression }, ...]，按序取首个命中分支，
        // 未命中走 default_branch。程序化创建工作流推荐用这种显式结构。
        if let Some(conditions) = config.get("conditions").and_then(|v| v.as_array()) {
            for cond in conditions {
                let branch = cond
                    .get("branch")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");
                let expr = cond.get("expression").unwrap_or(&JsonValue::Null);

                if condition_expression_matches(expr, ctx) {
                    return Ok((
                        json!({ "matched_branch": branch }),
                        Some(branch.to_string()),
                    ));
                }
            }

            let default_branch = config
                .get("default_branch")
                .and_then(|v| v.as_str())
                .unwrap_or("default");

            return Ok((
                json!({ "matched_branch": default_branch }),
                Some(default_branch.to_string()),
            ));
        }

        // 形态 B（单表达式）：config.expression = "..."，命中走 "true" 边、否则走 "false" 边。
        // 这是前端画布（NodeConfigPanel / WorkflowCanvas 用 true/false sourceHandle）保存的结构，
        // 引擎需要兼容，否则 UI 里画出来的条件节点跑不起来。
        if let Some(expr) = config.get("expression") {
            let branch = if condition_expression_matches(expr, ctx) {
                "true"
            } else {
                "false"
            };
            return Ok((
                json!({ "matched_branch": branch }),
                Some(branch.to_string()),
            ));
        }

        Err(AppError::InvalidQuery(
            "condition 节点需要 conditions 数组或 expression 字段".to_string(),
        ))
    }

    // ─── Transform 节点 ─────────────────────────────────────────

    async fn exec_transform_node(
        &self,
        config: &JsonValue,
        _ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        // transform 节点的 config 就是输出模板，模板变量在外层 resolve_template 已处理
        let output = config
            .get("output")
            .cloned()
            .unwrap_or_else(|| config.clone());
        Ok((output, None))
    }

    // ─── Response 节点 ─────────────────────────────────────────

    async fn exec_response_node(
        &self,
        config: &JsonValue,
        _ctx: &ExecutionContext,
    ) -> Result<(JsonValue, Option<String>)> {
        let status_code = config
            .get("status_code")
            .and_then(|v| v.as_u64())
            .unwrap_or(200) as u16;

        let body = match config.get("body") {
            Some(v) => parse_json_field("response.body", v)?.unwrap_or(JsonValue::Null),
            None => JsonValue::Null,
        };
        let headers = match config.get("headers") {
            Some(v) => parse_json_object_field("response.headers", v)?,
            None => json!({}),
        };

        Ok((
            json!({
                "status_code": status_code,
                "body": body,
                "headers": headers,
            }),
            None,
        ))
    }
}

// ─── 辅助函数 ─────────────────────────────────────────

/// 为有副作用的节点返回 mock 输出（不真正执行）。返回 `None` 表示该节点类型
/// 仍需真实执行（无副作用或决定流程走向）。
/// `prod_readonly=true` 时标记 `blocked_by:production_readonly`，否则标 `dry_run:true`——
/// 单一构造点，新增副作用节点类型只需改这一处，两种拦截语义自动一致。
///
/// 覆盖 db_execute / db_transaction / foreach / http_call / email_send / sse_publish。
/// 其中 db_transaction / foreach 此前遗漏——dry_run 调试 / prod_readonly 只读下会真写库，
/// 这里补齐（与 db_execute 同语义），杜绝干跑时穿透写库。
fn side_effect_mock(node_type: &NodeType, prod_readonly: bool) -> Option<JsonValue> {
    let base = match node_type {
        NodeType::DbExecute => json!({ "rows_affected": 0 }),
        NodeType::DbTransaction => json!({ "rows_affected": 0, "statements_count": 0 }),
        NodeType::ForEach => json!({ "processed": 0, "rows_affected": 0 }),
        NodeType::HttpCall => json!({ "status": 0, "headers": {}, "body": null }),
        NodeType::EmailSend => json!({ "sent": false, "accepted": 0 }),
        NodeType::SsePublish => json!({ "delivered": 0 }),
        _ => return None,
    };
    let mut mock = base;
    if let Some(obj) = mock.as_object_mut() {
        if prod_readonly {
            obj.insert(
                "blocked_by".to_string(),
                JsonValue::String("production_readonly".to_string()),
            );
        } else {
            obj.insert("dry_run".to_string(), JsonValue::Bool(true));
        }
    }
    Some(mock)
}

/// 是否为「数据库写」节点——受网关只读 API Key 护栏（DB-only）约束的节点集合。
fn is_db_write_node(node_type: &NodeType) -> bool {
    matches!(
        node_type,
        NodeType::DbExecute | NodeType::DbTransaction | NodeType::ForEach
    )
}

/// 数据修改型 CTE 探测：`db_query` 首词被限定为 SELECT/WITH，真正的写只能藏在 CTE 体里
/// （`WITH x AS (INSERT/UPDATE/DELETE/MERGE ...)`）——这类「伪装成读的写」不属于
/// [`is_db_write_node`]，需单独识别后同样纳入只读护栏。
///
/// 只匹配 `AS (` 后紧跟写语句的形态，因此：
/// - `SELECT ... FOR UPDATE`（只读行锁）不会被误判——它不以 `AS (` 引出；
/// - `WITH x AS (SELECT ...) SELECT`（只读 CTE）不匹配；
/// - 关键字藏在注释或字符串字面量里的先被 [`strip_sql_literals_and_comments`] 剥掉，不误判。
static DATA_MODIFYING_CTE_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(
    || {
        regex::Regex::new(
            r"(?i)\bas\s*(?:not\s+materialized\s+|materialized\s+)?\(\s*(?:insert|update|delete|merge)\b",
        )
        .expect("数据修改型 CTE 正则应当合法")
    },
);

/// 剥掉 `--` / `/* */` 注释后的首个 SQL 关键字（大写）。
///
/// `db_query` 用它判断是不是 SELECT/WITH。若只 `trim().split_whitespace()`，
/// `-- 注释\nSELECT ...` 的首词会变成 `--`，动态 SQL 节点会误拒。
fn sql_leading_keyword(sql: &str) -> String {
    crate::raw_sql_guard::strip_sql_comments(sql)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_uppercase()
}

/// 剥掉 SQL 里的块注释 / 行注释 / 单引号字符串字面量（含 `''` 转义），
/// 避免写关键字藏在注释或字面量里造成误判。替换成空格以保持词边界。
fn strip_sql_literals_and_comments(sql: &str) -> String {
    static NOISE_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(r"(?s)/\*.*?\*/|--[^\n]*|'(?:[^']|'')*'")
            .expect("SQL 噪音剥离正则应当合法")
    });
    NOISE_RE.replace_all(sql, " ").into_owned()
}

/// 该 `db_query` 节点的 SQL 是否为数据修改型 CTE（伪装成读的写）。
/// 动态 SQL 场景下对**未渲染的模板**做检测：写关键字通常是模板里的字面量，
/// 检测意图足够；万一被 `{{}}` 完全动态拼出而漏判，`exec_db_query_node` 的
/// READ ONLY 事务在 enforce 下仍会兜底由 PostgreSQL 拒绝。
fn db_query_has_data_modifying_cte(config: &JsonValue) -> bool {
    let Some(sql) = config.get("sql").and_then(|v| v.as_str()) else {
        return false;
    };
    let cleaned = strip_sql_literals_and_comments(sql);
    DATA_MODIFYING_CTE_RE.is_match(&cleaned)
}

/// 只读护栏拦截错误的稳定标识。嵌在错误文案里跨层传递：`execute_dag` 据此拒绝容错，
/// HTTP 层据此把节点失败映射成 403。做成常量而非匹配中文文案，避免改文案就失效。
pub const API_KEY_READONLY_BLOCK_CODE: &str = "api_key_readonly_write_blocked";

/// 只读 key 命中 DB 写节点时抛的硬失败。
///
/// 这里刻意**不**返回 mock 成功：写节点被静默跳过时，依赖它输出的下游节点会拿着
/// 「0 行受影响」继续跑，把一次本该被拒绝的调用变成看起来成功、实则数据不一致的
/// 结果。宁可整条工作流以 403 中断，也不制造这种静默错误。
pub fn api_key_readonly_block_error(node_id: &str, node_type: &str) -> AppError {
    AppError::Forbidden(format!(
        "{}: 只读 API Key 不允许执行数据库写操作，节点 '{}'（{}）已被拒绝",
        API_KEY_READONLY_BLOCK_CODE, node_id, node_type
    ))
}

/// 错误是否由只读护栏抛出（`execute_dag` / HTTP 层共用的判定）。
pub fn is_api_key_readonly_block_message(message: &str) -> bool {
    message.contains(API_KEY_READONLY_BLOCK_CODE)
}

/// 批量推送派发模式。
enum SseDispatchMode {
    Sync,
    Async { auto_async: bool },
}

fn normalize_dispatch_flag(config: &JsonValue) -> Option<&str> {
    config
        .get("dispatch")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn resolve_sse_dispatch_mode(
    config: &JsonValue,
    recipient_count: usize,
    settings: &crate::sse_batch_config::SseBatchSettings,
) -> SseDispatchMode {
    // 多 recipient 强制 async：推送在 tokio::spawn 中执行，workflow 超时不会中途取消。
    if recipient_count > 1 {
        return SseDispatchMode::Async { auto_async: true };
    }

    match normalize_dispatch_flag(config) {
        Some("sync") => SseDispatchMode::Sync,
        Some("async") => SseDispatchMode::Async { auto_async: false },
        Some(other) => {
            tracing::warn!(
                dispatch = other,
                "sse_publish 未知 dispatch 值，按 sync 处理"
            );
            SseDispatchMode::Sync
        }
        None if settings.async_threshold > 0 && recipient_count > settings.async_threshold => {
            SseDispatchMode::Async { auto_async: true }
        }
        None => SseDispatchMode::Sync,
    }
}

fn effective_max_recipients(
    config: &JsonValue,
    settings: &crate::sse_batch_config::SseBatchSettings,
) -> usize {
    let node_cap = config
        .get("max_recipients")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize);

    match (node_cap, settings.max_recipients) {
        (Some(0), _) | (None, 0) => 0,
        (Some(n), 0) => n,
        (Some(n), cap) => n.clamp(1, cap),
        (None, cap) => cap,
    }
}

fn effective_sse_batch_size(
    config: &JsonValue,
    settings: &crate::sse_batch_config::SseBatchSettings,
) -> usize {
    config
        .get("batch_size")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(settings.default_chunk_size)
        .clamp(1, settings.max_chunk_size)
}

fn batch_count(total: usize, chunk_size: usize) -> usize {
    if total == 0 {
        0
    } else {
        total.div_ceil(chunk_size.max(1))
    }
}

fn parse_one_recipient(val: &JsonValue) -> Option<String> {
    match val {
        JsonValue::Number(n) => n
            .as_i64()
            .and_then(|v| i32::try_from(v).ok())
            .map(|v| v.to_string()),
        JsonValue::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        }
        _ => None,
    }
}

fn validate_recipient_segment(recipient: &str) -> Result<()> {
    if recipient.is_empty() {
        return Err(AppError::InvalidQuery("recipient 不能为空".to_string()));
    }
    if recipient.contains(':') || recipient.contains('*') {
        return Err(AppError::InvalidQuery(format!(
            "recipient 不能包含 ':' 或 '*'：{}",
            recipient
        )));
    }
    Ok(())
}

/// 从 JSON 值解析 recipient 列表（数组 / 逗号串 / 单值），支持数字 uid 与 wayUid 等字符串。
fn parse_recipient_list(val: &JsonValue) -> Result<Vec<String>> {
    let mut recipients: Vec<String> = match val {
        JsonValue::Array(arr) => arr.iter().filter_map(parse_one_recipient).collect(),
        JsonValue::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                Vec::new()
            } else if s.starts_with('[') {
                let parsed: Vec<JsonValue> = serde_json::from_str(s).map_err(|e| {
                    AppError::InvalidQuery(format!("recipient 列表 JSON 无效: {}", e))
                })?;
                parsed.iter().filter_map(parse_one_recipient).collect()
            } else {
                s.split(',')
                    .filter_map(|part| {
                        parse_one_recipient(&JsonValue::String(part.trim().to_string()))
                    })
                    .collect()
            }
        }
        other => parse_one_recipient(other).into_iter().collect(),
    };

    if recipients.is_empty() {
        return Err(AppError::InvalidQuery("recipient 列表不能为空".to_string()));
    }

    for r in &recipients {
        validate_recipient_segment(r)?;
    }

    let mut seen = std::collections::HashSet::new();
    recipients.retain(|r| seen.insert(r.clone()));
    Ok(recipients)
}

fn extract_template_path(segment: &str) -> Option<&str> {
    let trimmed = segment.trim();
    if trimmed.starts_with("{{") && trimmed.ends_with("}}") {
        Some(trimmed[2..trimmed.len() - 2].trim())
    } else {
        None
    }
}

/// 从 `user_ids` 字段或 topic 模板中的 `user:{{...}}:suffix` 解析 recipient 列表。
fn resolve_sse_user_id_list(
    topic_tpl: &str,
    user_ids_config: Option<&JsonValue>,
    ctx: &ExecutionContext,
) -> Result<Option<Vec<String>>> {
    if let Some(cfg) = user_ids_config {
        let resolved = resolve_template(cfg, ctx);
        return Ok(Some(parse_recipient_list(&resolved)?));
    }

    let template = topic_tpl.trim();
    if !template.starts_with("user:") {
        return Ok(None);
    }
    let rest = &template[5..];
    let Some(second_colon) = rest.find(':') else {
        return Ok(None);
    };
    let segment = &rest[..second_colon];

    if let Some(path) = extract_template_path(segment) {
        let val = resolve_path(path, ctx);
        return Ok(Some(parse_recipient_list(&val)?));
    }

    if segment.contains(',') || (segment.starts_with('[') && segment.ends_with(']')) {
        let ids = parse_recipient_list(&JsonValue::String(segment.to_string()))?;
        if ids.len() > 1 {
            return Ok(Some(ids));
        }
        return Ok(None);
    }

    Ok(None)
}

/// 将 recipient 列表展开为完整 topic（含 `{database_id}` 等静态占位符替换）。
fn expand_user_topics(
    topic_tpl: &str,
    recipients: &[String],
    ctx: &ExecutionContext,
) -> Result<Vec<String>> {
    if topic_tpl.contains("{uid}") {
        return Ok(recipients
            .iter()
            .map(|id| resolve_sse_topic(&topic_tpl.replace("{uid}", id), ctx))
            .collect());
    }

    let template = topic_tpl.trim();
    if !template.starts_with("user:") {
        return Err(AppError::InvalidQuery(
            "user_ids 批量推送要求 topic 为 user:{uid}:... 或 user:...:... 格式".to_string(),
        ));
    }
    let rest = &template[5..];
    let second_colon = rest.find(':').ok_or_else(|| {
        AppError::InvalidQuery(
            "user topic 批量格式应为 user:{ids}:suffix，例如 user:{{trigger.ids}}:notify"
                .to_string(),
        )
    })?;
    let suffix = &rest[second_colon + 1..];

    Ok(recipients
        .iter()
        .map(|id| resolve_sse_topic(&format!("user:{}:{}", id, suffix), ctx))
        .collect())
}

async fn publish_user_topics_batched(
    topics: &[String],
    event: &str,
    data: &JsonValue,
    chunk_size: usize,
    batch_delay_ms: u64,
) -> bool {
    let chunk_size = chunk_size.max(1);
    let event = event.to_string();
    let data = data.clone();
    let mut delivered = false;

    for (batch_idx, chunk) in topics.chunks(chunk_size).enumerate() {
        if batch_idx > 0 {
            tokio::task::yield_now().await;
            if batch_delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(batch_delay_ms)).await;
            }
        }
        for topic in chunk {
            if crate::sse_publisher::publish(topic.clone(), event.clone(), data.clone()) {
                delivered = true;
            }
        }
    }
    delivered
}

/// 用执行上下文替换 SSE topic 模板里的占位符。
fn resolve_sse_topic(template: &str, ctx: &ExecutionContext) -> String {
    let rendered = render_sse_context_template(template, ctx);
    rendered
        .replace(
            "{database_id}",
            &ctx.database_id.map(|x| x.to_string()).unwrap_or_default(),
        )
        .replace(
            "{tenant_id}",
            &ctx.tenant_id.map(|x| x.to_string()).unwrap_or_default(),
        )
        .replace("{workflow_id}", &ctx.workflow_id.to_string())
        .replace("{run_id}", &ctx.run_id.to_string())
}

fn render_sse_context_template(template: &str, ctx: &ExecutionContext) -> String {
    let mut result = template.to_string();
    while let Some(start) = result.find("{{") {
        let Some(end_rel) = result[start + 2..].find("}}") else {
            break;
        };
        let end = start + 2 + end_rel;
        let path = result[start + 2..end].trim();
        let val = resolve_path(path, ctx);
        let replacement = match val {
            JsonValue::String(s) => s,
            JsonValue::Null => String::new(),
            other => other.to_string(),
        };
        result.replace_range(start..end + 2, &replacement);
    }
    result
}

/// 判断 URL 是否指向内网地址
/// 读取节点配置中的 `allow_failure` 容错开关。
///
/// 节点失败时若此开关为真，则记录失败但不中断工作流（见 `execute`）。容忍多种写法：
/// 布尔 `true`、字符串 `"true"`/`"1"`/`"yes"`/`"on"`、数字非零。任何其它取值（含缺省）均视为 false。
fn config_allow_failure(config: &JsonValue) -> bool {
    match config.get("allow_failure") {
        Some(JsonValue::Bool(b)) => *b,
        Some(JsonValue::String(s)) => {
            matches!(
                s.trim().to_ascii_lowercase().as_str(),
                "true" | "1" | "yes" | "on"
            )
        }
        Some(JsonValue::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        _ => false,
    }
}

/// Condition 的 `expression` 在 execute_dag 里会先被 `resolve_template` 整份渲染：
/// 比较式（`{{x}} > 0`）仍是字符串；单个 `{{x}}` 则会被替换成原始 JSON 类型。
/// 字符串继续走表达式求值；数组/对象/数字/布尔直接按 truthy 判断，避免 `as_str()` 丢成空串后恒为 false。
fn condition_expression_matches(expr: &JsonValue, ctx: &ExecutionContext) -> bool {
    match expr {
        JsonValue::String(s) => evaluate_expression(s, ctx),
        other => json_is_truthy(other),
    }
}

/// 简易条件表达式求值
///
/// 支持格式：
/// - `{{nodeA.field}} == "value"`
/// - `{{nodeA.count}} > 0`
/// - `true` / `false`
fn evaluate_expression(expr: &str, ctx: &ExecutionContext) -> bool {
    let expr = expr.trim();

    if expr == "true" || expr == "always" {
        return true;
    }
    if expr == "false" || expr == "never" {
        return false;
    }

    // 解析操作符
    let operators = ["==", "!=", ">=", "<=", ">", "<"];
    for op in &operators {
        if let Some(pos) = expr.find(op) {
            let left_raw = expr[..pos].trim();
            let right_raw = expr[pos + op.len()..].trim();

            let left_val = resolve_expr_value(left_raw, ctx);
            let right_val = resolve_expr_value(right_raw, ctx);

            return match *op {
                "==" => json_eq(&left_val, &right_val),
                "!=" => !json_eq(&left_val, &right_val),
                ">" => json_cmp(&left_val, &right_val) == Some(std::cmp::Ordering::Greater),
                "<" => json_cmp(&left_val, &right_val) == Some(std::cmp::Ordering::Less),
                ">=" => json_cmp(&left_val, &right_val)
                    .map(|o| o != std::cmp::Ordering::Less)
                    .unwrap_or(false),
                "<=" => json_cmp(&left_val, &right_val)
                    .map(|o| o != std::cmp::Ordering::Greater)
                    .unwrap_or(false),
                _ => false,
            };
        }
    }

    // 单值 truthy 判断
    let val = resolve_expr_value(expr, ctx);
    json_is_truthy(&val)
}

fn resolve_expr_value(raw: &str, ctx: &ExecutionContext) -> JsonValue {
    let raw = raw.trim();

    // 模板变量
    if raw.starts_with("{{") && raw.ends_with("}}") {
        let path = raw[2..raw.len() - 2].trim();
        return resolve_path(path, ctx);
    }

    // 字符串字面量
    if (raw.starts_with('"') && raw.ends_with('"'))
        || (raw.starts_with('\'') && raw.ends_with('\''))
    {
        return JsonValue::String(raw[1..raw.len() - 1].to_string());
    }

    // 数字
    if let Ok(n) = raw.parse::<i64>() {
        return json!(n);
    }
    if let Ok(n) = raw.parse::<f64>() {
        return json!(n);
    }

    // 布尔
    if raw == "true" {
        return JsonValue::Bool(true);
    }
    if raw == "false" {
        return JsonValue::Bool(false);
    }
    if raw == "null" || raw == "nil" {
        return JsonValue::Null;
    }

    JsonValue::String(raw.to_string())
}

fn json_eq(a: &JsonValue, b: &JsonValue) -> bool {
    a == b
}

fn json_cmp(a: &JsonValue, b: &JsonValue) -> Option<std::cmp::Ordering> {
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a.partial_cmp(&b),
        _ => None,
    }
}

fn json_is_truthy(val: &JsonValue) -> bool {
    match val {
        JsonValue::Null => false,
        JsonValue::Bool(b) => *b,
        JsonValue::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        JsonValue::String(s) => !s.is_empty(),
        JsonValue::Array(a) => !a.is_empty(),
        JsonValue::Object(_) => true,
    }
}

/// 将 JSON 值绑定到 sqlx 查询参数
fn bind_json_param<'q>(
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    val: &'q JsonValue,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match val {
        JsonValue::Null => query.bind(None::<String>),
        JsonValue::Bool(b) => query.bind(*b),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                query.bind(i)
            } else {
                query.bind(n.as_f64().unwrap_or(0.0))
            }
        }
        JsonValue::String(s) => query.bind(s.as_str()),
        _ => query.bind(val.to_string()),
    }
}

struct EmailSendConfig {
    from: String,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: String,
    text_body: Option<String>,
    html_body: Option<String>,
    smtp_host: String,
    smtp_port: u16,
    smtp_username: Option<String>,
    smtp_password: Option<String>,
    smtp_starttls: bool,
}

impl std::fmt::Debug for EmailSendConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmailSendConfig")
            .field("from", &self.from)
            .field("to", &self.to)
            .field("cc", &self.cc)
            .field("bcc", &self.bcc)
            .field("subject", &self.subject)
            .field("text_body", &self.text_body)
            .field("html_body", &self.html_body)
            .field("smtp_host", &self.smtp_host)
            .field("smtp_port", &self.smtp_port)
            .field("smtp_username", &self.smtp_username)
            .field("smtp_password", &self.smtp_password.as_ref().map(|_| "***"))
            .field("smtp_starttls", &self.smtp_starttls)
            .finish()
    }
}

impl EmailSendConfig {
    fn from_json(config: &JsonValue) -> Result<Self> {
        let from = config_string(config, "from")
            .or_else(|| env_string(&["ONEBASE_SMTP_FROM", "SMTP_FROM"]))
            .ok_or_else(|| AppError::InvalidQuery("email_send 节点缺少发件人 from".to_string()))?;
        let to = recipients_from_config(config, "to");
        if to.is_empty() {
            return Err(AppError::InvalidQuery(
                "email_send 节点至少需要一个收件人 to".to_string(),
            ));
        }

        let subject = config_string(config, "subject").ok_or_else(|| {
            AppError::InvalidQuery("email_send 节点缺少邮件主题 subject".to_string())
        })?;
        let text_body = config_string(config, "text_body");
        let html_body = config_string(config, "html_body");
        if text_body.is_none() && html_body.is_none() {
            return Err(AppError::InvalidQuery(
                "email_send 节点至少需要 text_body 或 html_body".to_string(),
            ));
        }

        let smtp_host = config_string(config, "smtp_host")
            .or_else(|| env_string(&["ONEBASE_SMTP_HOST", "SMTP_HOST"]))
            .ok_or_else(|| AppError::InvalidQuery("email_send 节点缺少 SMTP host".to_string()))?;
        let smtp_port = config_u16(config, "smtp_port")
            .or_else(|| env_u16(&["ONEBASE_SMTP_PORT", "SMTP_PORT"]))
            .unwrap_or(587);
        let smtp_username = config_string(config, "smtp_username")
            .or_else(|| env_string(&["ONEBASE_SMTP_USERNAME", "SMTP_USERNAME"]));
        let smtp_password = config_string(config, "smtp_password")
            .or_else(|| env_string(&["ONEBASE_SMTP_PASSWORD", "SMTP_PASSWORD"]));
        let smtp_starttls = config_bool(config, "smtp_starttls")
            .or_else(|| env_bool(&["ONEBASE_SMTP_STARTTLS", "SMTP_STARTTLS"]))
            .unwrap_or(true);

        Ok(Self {
            from,
            to,
            cc: recipients_from_config(config, "cc"),
            bcc: recipients_from_config(config, "bcc"),
            subject,
            text_body,
            html_body,
            smtp_host,
            smtp_port,
            smtp_username,
            smtp_password,
            smtp_starttls,
        })
    }
}

async fn send_email(config: EmailSendConfig) -> Result<()> {
    use lettre::message::{header::ContentType, Message, MultiPart, SinglePart};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

    let mut builder = Message::builder()
        .from(parse_mailbox(&config.from, "from")?)
        .subject(&config.subject);

    for to in &config.to {
        builder = builder.to(parse_mailbox(to, "to")?);
    }
    for cc in &config.cc {
        builder = builder.cc(parse_mailbox(cc, "cc")?);
    }
    for bcc in &config.bcc {
        builder = builder.bcc(parse_mailbox(bcc, "bcc")?);
    }

    let message = match (&config.text_body, &config.html_body) {
        (Some(text), Some(html)) => builder
            .multipart(
                MultiPart::alternative()
                    .singlepart(SinglePart::plain(text.clone()))
                    .singlepart(
                        SinglePart::builder()
                            .header(ContentType::TEXT_HTML)
                            .body(html.clone()),
                    ),
            )
            .map_err(|e| AppError::Internal(format!("构建邮件失败: {}", e)))?,
        (Some(text), None) => builder
            .singlepart(SinglePart::plain(text.clone()))
            .map_err(|e| AppError::Internal(format!("构建邮件失败: {}", e)))?,
        (None, Some(html)) => builder
            .singlepart(
                SinglePart::builder()
                    .header(ContentType::TEXT_HTML)
                    .body(html.clone()),
            )
            .map_err(|e| AppError::Internal(format!("构建邮件失败: {}", e)))?,
        (None, None) => unreachable!("EmailSendConfig requires a body"),
    };

    // SMTP 连接/读写超时：lettre 会把它应用到 TCP connect、TLS 握手与后续 I/O，
    // 避免像 smtp.exmail.qq.com:465 这样的目标在协议层互等时把节点（乃至 executor）拖死。
    let smtp_timeout = std::time::Duration::from_secs(15);
    let host = config.smtp_host.clone();
    let port = config.smtp_port;

    // 选择 TLS 模式（关键修复）：
    // - 465：隐式 TLS（SMTPS / Wrapper）——连接建立后立即 TLS 握手。之前在 smtp_starttls=false
    //   时错误地走明文 builder_dangerous，明文客户端连 TLS-only 的 465 会互等握手而永久阻塞。
    // - 显式 smtp_starttls 或 587/25：STARTTLS（先明文问候再升级）。
    // - 仅当显式关闭 starttls 且端口非 465 时，才允许明文（本地/内网中继测试）。
    let mut transport_builder = if port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
            .map_err(|e| AppError::Internal(format!("SMTP(隐式 TLS) 初始化失败: {}", e)))?
    } else if config.smtp_starttls {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
            .map_err(|e| AppError::Internal(format!("SMTP(STARTTLS) 初始化失败: {}", e)))?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host)
    }
    .port(port)
    .timeout(Some(smtp_timeout));

    if let (Some(username), Some(password)) = (config.smtp_username, config.smtp_password) {
        transport_builder = transport_builder.credentials(Credentials::new(username, password));
    }

    let transport = transport_builder.build();

    // 双保险：即便底层某段（DNS / connect / 握手）未被 lettre 的 timeout 覆盖，也用墙钟超时硬兜底，
    // 确保单个 email_send 节点绝不可能无限阻塞执行线程。
    let hard_deadline = smtp_timeout + std::time::Duration::from_secs(10);
    match tokio::time::timeout(hard_deadline, transport.send(message)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(AppError::Internal(format!("发送邮件失败: {}", e))),
        Err(_) => Err(AppError::Internal(format!(
            "发送邮件超时：连接 {}:{} 超过 {}s 无响应（请检查 SMTP 主机/端口/TLS 设置，如 465 需隐式 TLS）",
            host,
            port,
            hard_deadline.as_secs()
        ))),
    }
}

fn parse_mailbox(value: &str, field: &str) -> Result<lettre::message::Mailbox> {
    value.parse().map_err(|e| {
        AppError::InvalidQuery(format!("email_send 节点 {} 邮箱格式无效: {}", field, e))
    })
}

fn recipients_from_config(config: &JsonValue, key: &str) -> Vec<String> {
    match config.get(key) {
        Some(JsonValue::Array(values)) => values
            .iter()
            .filter_map(|v| v.as_str())
            .flat_map(split_recipients)
            .collect(),
        Some(JsonValue::String(value)) => split_recipients(value).collect(),
        _ => Vec::new(),
    }
}

fn split_recipients(value: &str) -> impl Iterator<Item = String> + '_ {
    value
        .split(|c| matches!(c, ',' | ';' | '\n'))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn config_string(config: &JsonValue, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn config_u16(config: &JsonValue, key: &str) -> Option<u16> {
    config
        .get(key)
        .and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v).ok())
}

fn config_bool(config: &JsonValue, key: &str) -> Option<bool> {
    config.get(key).and_then(|v| {
        v.as_bool().or_else(|| {
            v.as_str()
                .map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"))
        })
    })
}

fn env_string(keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| env::var(key).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn env_u16(keys: &[&str]) -> Option<u16> {
    keys.iter()
        .find_map(|key| env::var(key).ok())
        .and_then(|s| s.parse::<u16>().ok())
}

fn env_bool(keys: &[&str]) -> Option<bool> {
    keys.iter().find_map(|key| {
        env::var(key)
            .ok()
            .map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"))
    })
}

fn parse_json_field(field: &str, value: &JsonValue) -> Result<Option<JsonValue>> {
    match value {
        JsonValue::Null => Ok(None),
        JsonValue::String(s) => {
            let text = s.trim();
            if text.is_empty() {
                Ok(None)
            } else {
                serde_json::from_str::<JsonValue>(text)
                    .map(Some)
                    .map_err(|e| AppError::InvalidQuery(format!("{field} 不是合法 JSON: {e}")))
            }
        }
        _ => Ok(Some(value.clone())),
    }
}

fn parse_json_object_field(field: &str, value: &JsonValue) -> Result<JsonValue> {
    let parsed = parse_json_field(field, value)?.unwrap_or_else(|| json!({}));
    if parsed.is_object() {
        Ok(parsed)
    } else {
        Err(AppError::InvalidQuery(format!(
            "{field} 必须是 JSON 对象（object/dictionary），当前是 {}",
            json_kind_name(&parsed)
        )))
    }
}

fn json_kind_name(value: &JsonValue) -> &'static str {
    match value {
        JsonValue::Null => "null",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Number(_) => "number",
        JsonValue::String(_) => "string",
        JsonValue::Array(_) => "array",
        JsonValue::Object(_) => "object",
    }
}

/// 将 PgRow 转为 JSON object
fn pg_row_to_json(row: &sqlx::postgres::PgRow) -> JsonValue {
    crate::pg_row_json::pg_row_to_json(row)
}

/// MySQL 行 → JSON。按常见类型逐一尝试解码（sqlx 无统一动态取值 API）。
fn mysql_row_to_json(row: &sqlx::mysql::MySqlRow) -> JsonValue {
    use sqlx::{Column, Row};
    let mut obj = serde_json::Map::new();
    for col in row.columns() {
        let key = col.name().to_string();
        let idx = col.ordinal();
        let val: JsonValue = if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
            v.map(|n| json!(n)).unwrap_or(JsonValue::Null)
        } else if let Ok(v) = row.try_get::<Option<u64>, _>(idx) {
            v.map(|n| json!(n)).unwrap_or(JsonValue::Null)
        } else if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
            v.map(|n| json!(n)).unwrap_or(JsonValue::Null)
        } else if let Ok(v) = row.try_get::<Option<bool>, _>(idx) {
            v.map(JsonValue::Bool).unwrap_or(JsonValue::Null)
        } else if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
            v.map(JsonValue::String).unwrap_or(JsonValue::Null)
        } else if let Ok(v) = row.try_get::<Option<JsonValue>, _>(idx) {
            v.unwrap_or(JsonValue::Null)
        } else if let Ok(v) = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(idx) {
            v.map(|dt| JsonValue::String(dt.to_rfc3339()))
                .unwrap_or(JsonValue::Null)
        } else if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(idx) {
            v.map(|dt| JsonValue::String(dt.format("%Y-%m-%dT%H:%M:%S%.f").to_string()))
                .unwrap_or(JsonValue::Null)
        } else if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(idx) {
            v.map(|d| JsonValue::String(d.to_string()))
                .unwrap_or(JsonValue::Null)
        } else if let Ok(v) = row.try_get::<Option<chrono::NaiveTime>, _>(idx) {
            v.map(|t| JsonValue::String(t.to_string()))
                .unwrap_or(JsonValue::Null)
        } else if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) {
            // BLOB / 二进制：转 base64 字符串，避免非 UTF-8 破坏 JSON。
            v.map(|bytes| {
                use base64::Engine;
                JsonValue::String(base64::engine::general_purpose::STANDARD.encode(bytes))
            })
            .unwrap_or(JsonValue::Null)
        } else {
            JsonValue::Null
        };
        obj.insert(key, val);
    }
    JsonValue::Object(obj)
}

// ─── 验证 ─────────────────────────────────────────

/// 验证 WorkflowDefinition 结构是否合法
pub fn validate_definition(def: &WorkflowDefinition) -> Result<()> {
    if def.nodes.is_empty() {
        return Err(AppError::InvalidQuery("工作流至少需要一个节点".to_string()));
    }

    let node_ids: HashSet<&str> = def.nodes.iter().map(|n| n.id.as_str()).collect();
    if node_ids.len() != def.nodes.len() {
        return Err(AppError::InvalidQuery("工作流节点 ID 存在重复".to_string()));
    }
    if node_ids.contains("loop") {
        return Err(AppError::InvalidQuery(
            "节点 ID 'loop' 为循环作用域变量保留名，请使用其他 ID".to_string(),
        ));
    }

    for edge in &def.edges {
        if !node_ids.contains(edge.from.as_str()) {
            return Err(AppError::InvalidQuery(format!(
                "边引用了不存在的源节点: {}",
                edge.from
            )));
        }
        if !node_ids.contains(edge.to.as_str()) {
            return Err(AppError::InvalidQuery(format!(
                "边引用了不存在的目标节点: {}",
                edge.to
            )));
        }
    }

    // 校验 loop 结构（已接线的 loop：body/回边唯一、回边源在体内、模式必填项），
    // 同时把循环体拓扑解析出来——放在拓扑排序前，让 loop 报错信息更精确。
    plan_loops(def)?;

    // 检测是否有环（loop 回边已在 topological_sort 内被剔除，不会误报）。
    topological_sort(def)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 网关只读 API Key 护栏 ──

    #[test]
    fn parse_apikey_rw_guard_modes() {
        assert_eq!(parse_apikey_rw_guard(None), ApiKeyWriteGuard::LogOnly);
        assert_eq!(parse_apikey_rw_guard(Some("off")), ApiKeyWriteGuard::Off);
        assert_eq!(
            parse_apikey_rw_guard(Some("log_only")),
            ApiKeyWriteGuard::LogOnly
        );
        assert_eq!(
            parse_apikey_rw_guard(Some("  ENFORCE ")),
            ApiKeyWriteGuard::Enforce
        );
        // 脏值回退默认 log_only。
        assert_eq!(
            parse_apikey_rw_guard(Some("garbage")),
            ApiKeyWriteGuard::LogOnly
        );
    }

    #[test]
    fn guard_block_and_log_semantics() {
        assert!(!ApiKeyWriteGuard::Off.should_block_db_write());
        assert!(!ApiKeyWriteGuard::Off.should_log_db_write());
        // log_only：不拦但要记日志。
        assert!(!ApiKeyWriteGuard::LogOnly.should_block_db_write());
        assert!(ApiKeyWriteGuard::LogOnly.should_log_db_write());
        // enforce：既拦又记。
        assert!(ApiKeyWriteGuard::Enforce.should_block_db_write());
        assert!(ApiKeyWriteGuard::Enforce.should_log_db_write());
    }

    #[test]
    fn is_db_write_node_covers_write_nodes_only() {
        assert!(is_db_write_node(&NodeType::DbExecute));
        assert!(is_db_write_node(&NodeType::DbTransaction));
        assert!(is_db_write_node(&NodeType::ForEach));
        // 读 / 无副作用节点不算写。
        assert!(!is_db_write_node(&NodeType::DbQuery));
        assert!(!is_db_write_node(&NodeType::HttpCall));
        assert!(!is_db_write_node(&NodeType::Code));
    }

    #[test]
    fn api_key_readonly_block_error_is_forbidden_and_marked() {
        let err = api_key_readonly_block_error("save_order", "db_execute");
        // 必须是 Forbidden：HTTP 层据此回 403，而不是 5xx。
        assert!(matches!(err, AppError::Forbidden(_)));

        let msg = err.to_string();
        assert!(is_api_key_readonly_block_message(&msg));
        // 文案带上节点身份，排查时不用再翻日志找是哪个节点被拒。
        assert!(msg.contains("save_order"));
        assert!(msg.contains("db_execute"));
    }

    #[test]
    fn readonly_block_marker_does_not_match_unrelated_errors() {
        assert!(!is_api_key_readonly_block_message(""));
        assert!(!is_api_key_readonly_block_message(
            "db_execute 节点执行失败: connection reset by peer"
        ));
        // 近似文案也不能误判——判定只认稳定标识。
        assert!(!is_api_key_readonly_block_message("只读 API Key 不允许写"));
    }

    /// 用不可达连接池（`lazy_engine` 指向 127.0.0.1:1）验证护栏在**触库之前**短路：
    /// 若护栏未生效，同一用例会因连不上库而报连接错误，从而暴露漏拦。
    #[tokio::test]
    async fn enforce_blocks_db_write_nodes_before_touching_database() {
        for node_type in [
            NodeType::DbExecute,
            NodeType::DbTransaction,
            NodeType::ForEach,
        ] {
            let label = node_type_label(&node_type);
            let node = WorkflowNode {
                id: "write_step".to_string(),
                node_type,
                label: None,
                config: json!({ "sql": "INSERT INTO t(a) VALUES (1)" }),
            };
            let ctx = ExecutionContext {
                apikey_write_guard: ApiKeyWriteGuard::Enforce,
                ..exec_ctx()
            };

            let err = lazy_engine()
                .execute_node(&node, &node.config, &ctx, &[])
                .await
                .expect_err("只读 key + enforce 应拒绝 DB 写节点");

            assert!(
                is_api_key_readonly_block_message(&err.to_string()),
                "{label} 未被护栏拦截，实际错误：{err}"
            );
            assert!(matches!(err, AppError::Forbidden(_)));
        }
    }

    #[tokio::test]
    async fn log_only_and_off_do_not_block_db_write_nodes() {
        // 反向断言：不该拦的档位下必须真的走到执行阶段（因连接池不可达而报连接错误），
        // 以此证明护栏没有过度触发、log_only 确实零行为变更。
        //
        // 这里不用 lazy_engine：它沿用默认 acquire 超时（30s），本用例故意让获取连接失败，
        // 会把单测拖到一分钟。改用短超时的专用池，语义相同但秒级返回。
        let fast_fail_engine = || {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .acquire_timeout(std::time::Duration::from_millis(200))
                .connect_lazy("postgresql://onebase:onebase@127.0.0.1:1/onebase")
                .expect("lazy pool should not connect during setup");
            DagEngine::new(pool)
        };

        for guard in [ApiKeyWriteGuard::Off, ApiKeyWriteGuard::LogOnly] {
            let node = WorkflowNode {
                id: "write_step".to_string(),
                node_type: NodeType::DbExecute,
                label: None,
                config: json!({ "sql": "INSERT INTO t(a) VALUES (1)" }),
            };
            let ctx = ExecutionContext {
                apikey_write_guard: guard,
                ..exec_ctx()
            };

            let err = fast_fail_engine()
                .execute_node(&node, &node.config, &ctx, &[])
                .await
                .expect_err("连接池不可达，应以连接错误告终");

            assert!(
                !is_api_key_readonly_block_message(&err.to_string()),
                "{} 档不应拦截，却命中了护栏",
                guard.as_str()
            );
        }
    }

    #[tokio::test]
    async fn enforce_leaves_non_db_write_nodes_alone() {
        // 护栏是 DB-only：transform 这类无副作用节点即便在 enforce 下也照常执行。
        let node = WorkflowNode {
            id: "shape".to_string(),
            node_type: NodeType::Transform,
            label: None,
            config: json!({ "output": { "ok": true } }),
        };
        let ctx = ExecutionContext {
            apikey_write_guard: ApiKeyWriteGuard::Enforce,
            ..exec_ctx()
        };

        let (output, _) = lazy_engine()
            .execute_node(&node, &node.config, &ctx, &[])
            .await
            .expect("transform 节点不受只读护栏影响");
        assert_eq!(output, json!({ "ok": true }));
    }

    #[test]
    fn data_modifying_cte_detection_is_precise() {
        // 命中：写语句藏在 CTE 体里，含 MATERIALIZED / 大小写 / 无空格等变体。
        for sql in [
            "WITH x AS (INSERT INTO t(a) VALUES (1) RETURNING id) SELECT * FROM x",
            "with x as (update t set a=1 where id=2 returning id) select * from x",
            "WITH x AS ( DELETE FROM t WHERE id=1 RETURNING * ) SELECT * FROM x",
            "WITH x AS MATERIALIZED (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x",
            "WITH x AS NOT MATERIALIZED (INSERT INTO t VALUES (1)) SELECT 1",
            "WITH x AS(INSERT INTO t VALUES(1) RETURNING id) SELECT * FROM x",
            "WITH a AS (SELECT 1), b AS (DELETE FROM t RETURNING *) SELECT * FROM b",
        ] {
            assert!(
                db_query_has_data_modifying_cte(&json!({ "sql": sql })),
                "应识别为数据修改型 CTE：{sql}"
            );
        }

        // 不命中：纯读、只读锁、以及关键字仅出现在注释/字符串里的情形。
        for sql in [
            "SELECT * FROM t WHERE a = 1",
            "SELECT * FROM t FOR UPDATE",
            "WITH x AS (SELECT * FROM t) SELECT * FROM x",
            "SELECT * FROM t WHERE note = 'as (insert into evil ...)'",
            "SELECT * FROM t -- as (insert into t values(1))\n WHERE a=1",
            "SELECT * FROM t /* WITH x AS (DELETE FROM t) */ WHERE a=1",
        ] {
            assert!(
                !db_query_has_data_modifying_cte(&json!({ "sql": sql })),
                "不应被误判为写：{sql}"
            );
        }

        // 缺 sql 字段：安全默认为否。
        assert!(!db_query_has_data_modifying_cte(&json!({})));
    }

    #[tokio::test]
    async fn enforce_blocks_data_modifying_cte_in_db_query() {
        // db_query 里的数据修改型 CTE 必须与显式写节点一样在触库前被 enforce 硬失败拦下。
        let node = WorkflowNode {
            id: "cte_write".to_string(),
            node_type: NodeType::DbQuery,
            label: None,
            config: json!({
                "sql": "WITH x AS (INSERT INTO t(a) VALUES (1) RETURNING id) SELECT * FROM x"
            }),
        };
        let ctx = ExecutionContext {
            apikey_write_guard: ApiKeyWriteGuard::Enforce,
            ..exec_ctx()
        };

        let err = lazy_engine()
            .execute_node(&node, &node.config, &ctx, &[])
            .await
            .expect_err("只读 key + enforce 应拒绝数据修改型 CTE");

        assert!(
            is_api_key_readonly_block_message(&err.to_string()),
            "数据修改型 CTE 未被护栏拦截，实际错误：{err}"
        );
        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[tokio::test]
    async fn enforce_allows_plain_select_db_query_through_guard() {
        // 纯读 db_query 不该被护栏短路——它应越过护栏、真正走到执行阶段
        // （因连接池不可达而报连接错误，以此证明护栏没有过度触发）。
        let pool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(200))
            .connect_lazy("postgresql://onebase:onebase@127.0.0.1:1/onebase")
            .expect("lazy pool should not connect during setup");
        let engine = DagEngine::new(pool);

        let node = WorkflowNode {
            id: "read_step".to_string(),
            node_type: NodeType::DbQuery,
            label: None,
            config: json!({ "sql": "SELECT * FROM t WHERE a = 1" }),
        };
        let ctx = ExecutionContext {
            apikey_write_guard: ApiKeyWriteGuard::Enforce,
            ..exec_ctx()
        };

        let err = engine
            .execute_node(&node, &node.config, &ctx, &[])
            .await
            .expect_err("连接池不可达，纯读应以连接错误告终而非护栏拦截");

        assert!(
            !is_api_key_readonly_block_message(&err.to_string()),
            "纯读 db_query 被护栏误拦：{err}"
        );
    }

    #[test]
    fn readonly_block_is_not_swallowed_by_allow_failure() {
        // execute_dag 的容错开关：allow_failure 为真，但只读护栏错误必须强制不可容错，
        // 否则工作流会带着「写被拒绝」跑完下游并对外返回成功。
        let config = json!({ "allow_failure": true });
        let block_msg = api_key_readonly_block_error("save_order", "db_execute").to_string();
        let other_msg = "connection reset by peer".to_string();

        let effective =
            |msg: &str| config_allow_failure(&config) && !is_api_key_readonly_block_message(msg);

        assert!(!effective(&block_msg));
        // 其它错误照旧可被容错，不受影响。
        assert!(effective(&other_msg));
    }

    #[test]
    fn side_effect_mock_now_covers_db_transaction_and_foreach() {
        // 回归：db_transaction / foreach 此前遗漏，现在 dry_run / prod_readonly 下也被拦。
        let m =
            side_effect_mock(&NodeType::DbTransaction, false).expect("db_transaction 应被 mock");
        assert_eq!(m["dry_run"], json!(true));
        let m = side_effect_mock(&NodeType::ForEach, true).expect("foreach 应被 mock");
        assert_eq!(m["blocked_by"], json!("production_readonly"));
        // db_query 仍不在副作用 mock 集合（走 READ ONLY 真执行）。
        assert!(side_effect_mock(&NodeType::DbQuery, true).is_none());
    }

    #[test]
    fn workflow_db_statement_timeout_ms_defaults_and_env() {
        assert_eq!(workflow_db_statement_timeout_ms_from(None), 30_000);
        assert_eq!(
            workflow_db_statement_timeout_ms_from(Some("15000".into())),
            15_000
        );
        assert_eq!(
            workflow_db_statement_timeout_ms_from(Some("0".into())),
            30_000
        );
        assert_eq!(
            workflow_db_statement_timeout_ms_from(Some("abc".into())),
            30_000
        );
    }

    #[test]
    fn test_topological_sort_simple() {
        let def = WorkflowDefinition {
            nodes: vec![
                WorkflowNode {
                    id: "a".into(),
                    node_type: NodeType::Code,
                    label: None,
                    config: json!({}),
                },
                WorkflowNode {
                    id: "b".into(),
                    node_type: NodeType::Code,
                    label: None,
                    config: json!({}),
                },
                WorkflowNode {
                    id: "c".into(),
                    node_type: NodeType::Code,
                    label: None,
                    config: json!({}),
                },
            ],
            edges: vec![
                WorkflowEdge::new("a", "b", None),
                WorkflowEdge::new("b", "c", None),
            ],
        };
        let result = topological_sort(&def).unwrap();
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_topological_sort_cycle_detected() {
        let def = WorkflowDefinition {
            nodes: vec![
                WorkflowNode {
                    id: "a".into(),
                    node_type: NodeType::Code,
                    label: None,
                    config: json!({}),
                },
                WorkflowNode {
                    id: "b".into(),
                    node_type: NodeType::Code,
                    label: None,
                    config: json!({}),
                },
            ],
            edges: vec![
                WorkflowEdge::new("a", "b", None),
                WorkflowEdge::new("b", "a", None),
            ],
        };
        assert!(topological_sort(&def).is_err());
    }

    #[test]
    fn test_template_resolution() {
        let mut ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({"name": "test", "items": [1, 2, 3]}),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };
        ctx.node_outputs
            .insert("fetch".to_string(), json!({"count": 42, "data": {"id": 7}}));

        assert_eq!(
            resolve_template(&json!("{{trigger.name}}"), &ctx),
            json!("test")
        );
        assert_eq!(resolve_template(&json!("{{fetch.count}}"), &ctx), json!(42));
        assert_eq!(
            resolve_template(&json!("{{fetch.data.id}}"), &ctx),
            json!(7)
        );
        assert_eq!(
            resolve_template(&json!("{{trigger.items[1]}}"), &ctx),
            json!(2)
        );
        assert_eq!(
            resolve_template(&json!("Hello {{trigger.name}}!"), &ctx),
            json!("Hello test!")
        );
    }

    #[test]
    fn sql_leading_keyword_skips_comments() {
        assert_eq!(sql_leading_keyword("SELECT 1"), "SELECT");
        assert_eq!(
            sql_leading_keyword("  with x as (select 1) select * from x"),
            "WITH"
        );
        assert_eq!(
            sql_leading_keyword("-- 注释\nSELECT\n all_proj.project AS project"),
            "SELECT"
        );
        assert_eq!(
            sql_leading_keyword("-- lastshelter (UTC+0, +8h)\nSELECT COUNT(*) FROM t"),
            "SELECT"
        );
        assert_eq!(
            sql_leading_keyword("/* block */ -- line\n  SELECT 1"),
            "SELECT"
        );
        assert_eq!(sql_leading_keyword("-- 只有注释"), "");
        assert_eq!(
            sql_leading_keyword("-- no\nINSERT INTO t VALUES (1)"),
            "INSERT"
        );
    }

    #[test]
    fn mysql_inline_sql_escapes_values_and_blocks_injection() {
        // MySQL 走文本协议、内联参数：必须对值做转义，杜绝注入。
        let ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({
                "id": 42,
                "name": "o'brien",
                "q": "foo",
                "evil": "x'; DROP TABLE users; --",
            }),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };

        // 裸数值模板 → 裸字面量
        assert_eq!(
            mysql_inline_sql("SELECT * FROM t WHERE id = {{trigger.id}}", &ctx, &[]),
            "SELECT * FROM t WHERE id = 42"
        );
        // 引号内模板 → 内联并转义单引号
        assert_eq!(
            mysql_inline_sql("SELECT * FROM t WHERE name = '{{trigger.name}}'", &ctx, &[]),
            "SELECT * FROM t WHERE name = 'o\\'brien'"
        );
        // LIKE 通配符：模板在字面量中间
        assert_eq!(
            mysql_inline_sql("SELECT 1 WHERE name LIKE '%{{trigger.q}}%'", &ctx, &[]),
            "SELECT 1 WHERE name LIKE '%foo%'"
        );
        // 显式 ? 参数按序内联（字符串加引号转义，数值裸值）
        assert_eq!(
            mysql_inline_sql(
                "SELECT 1 WHERE a = ? AND b = ?",
                &ctx,
                &[json!("x"), json!(5)]
            ),
            "SELECT 1 WHERE a = 'x' AND b = 5"
        );
        // 注入 payload：单引号被转义为 \'，无法逃逸出字符串字面量
        assert_eq!(
            mysql_inline_sql("SELECT * FROM t WHERE c = {{trigger.evil}}", &ctx, &[]),
            "SELECT * FROM t WHERE c = 'x\\'; DROP TABLE users; --'"
        );
    }

    #[test]
    fn sql_inline_templates_become_bind_params_not_interpolated() {
        // 用户可控输入里塞经典注入 payload。修复后它必须作为绑定值，绝不拼进 SQL 文本。
        let ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({
                "email": "victim@example.com' OR '1'='1",
                "id": 42
            }),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };

        // 既支持裸 {{}}（数值/标识），也支持被单引号包裹的 '{{}}'（字符串）。
        let raw = "SELECT * FROM offers WHERE email = '{{trigger.email}}' AND id = {{trigger.id}}";
        let (sql, binds) = parameterize_sql_templates(raw, &ctx, 1);

        // SQL 文本中不再出现任何注入残留 / 原始模板，只有占位符。
        assert_eq!(sql, "SELECT * FROM offers WHERE email = $1 AND id = $2");
        assert!(!sql.contains("OR '1'='1"));
        assert!(!sql.contains("{{"));

        // 注入字符串原封不动地成为待绑定的值（参数化后由驱动转义，不会被当代码执行）。
        assert_eq!(binds.len(), 2);
        assert_eq!(binds[0], json!("victim@example.com' OR '1'='1"));
        assert_eq!(binds[1], json!(42));
    }

    #[test]
    fn sql_placeholder_numbering_continues_after_explicit_params() {
        // 显式 params（$1）与内联 {{}} 共存时，自动占位符从 explicit+1 起编号，避免冲突。
        let ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({"status": "active"}),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };
        let raw = "SELECT * FROM t WHERE tenant = $1 AND status = {{trigger.status}}";
        let (sql, binds) = parameterize_sql_templates(raw, &ctx, 2);
        assert_eq!(sql, "SELECT * FROM t WHERE tenant = $1 AND status = $2");
        assert_eq!(binds, vec![json!("active")]);
    }

    #[test]
    fn sql_template_embedded_in_string_literal_becomes_concat() {
        // 回归：内联 {{}} 嵌在更大字符串字面量里（LIKE 通配符 / 拼接文本），
        // 必须改写成 `'前缀' || $N || '后缀'` 而非把 $N 塞进字面量内部。
        let ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({"kw": "ab", "name": "Bob"}),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };

        // LIKE 通配符
        let (sql, binds) = parameterize_sql_templates(
            "SELECT * FROM t WHERE name LIKE '%{{trigger.kw}}%'",
            &ctx,
            1,
        );
        assert_eq!(sql, "SELECT * FROM t WHERE name LIKE ('%' || $1 || '%')");
        assert_eq!(binds, vec![json!("ab")]);

        // 字面量内的前后缀文本
        let (sql, binds) = parameterize_sql_templates(
            "INSERT INTO log(msg) VALUES ('Hi {{trigger.name}}, welcome')",
            &ctx,
            1,
        );
        assert_eq!(
            sql,
            "INSERT INTO log(msg) VALUES (('Hi ' || $1 || ', welcome'))"
        );
        assert_eq!(binds, vec![json!("Bob")]);

        // 整段即模板时仍输出裸 $N（保持简洁、与旧行为一致）
        let (sql, binds) =
            parameterize_sql_templates("SELECT * FROM t WHERE name = '{{trigger.name}}'", &ctx, 1);
        assert_eq!(sql, "SELECT * FROM t WHERE name = $1");
        assert_eq!(binds, vec![json!("Bob")]);
    }

    #[test]
    fn sql_bare_template_coerces_numeric_strings_but_keeps_quoted_as_text() {
        // 触发数据里的 id 常以字符串形式到达（如 endpoint 查询参数）。裸 {{}} 语境下必须
        // 还原成数值，否则 `integer = $N`(text) 会报 operator does not exist。
        let ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({
                "id": "42",
                "price": "9.90",
                "status": "active",
                "code": "007"
            }),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };

        // 裸整数字符串 → 数值
        let (sql, binds) =
            parameterize_sql_templates("SELECT * FROM t WHERE id = {{trigger.id}}", &ctx, 1);
        assert_eq!(sql, "SELECT * FROM t WHERE id = $1");
        assert_eq!(binds, vec![json!(42)]);

        // 裸小数字符串 → 浮点数值
        let (_, binds) =
            parameterize_sql_templates("SELECT * FROM t WHERE price > {{trigger.price}}", &ctx, 1);
        assert_eq!(binds, vec![json!(9.9)]);

        // 裸非数字串 → 仍按文本绑定（用于比较文本列）
        let (_, binds) = parameterize_sql_templates(
            "SELECT * FROM t WHERE status = {{trigger.status}}",
            &ctx,
            1,
        );
        assert_eq!(binds, vec![json!("active")]);

        // 被引号包裹且为零填充编码 → 保持文本（作者显式要字符串）
        let (sql, binds) =
            parameterize_sql_templates("SELECT * FROM t WHERE code = '{{trigger.code}}'", &ctx, 1);
        assert_eq!(sql, "SELECT * FROM t WHERE code = $1");
        assert_eq!(binds, vec![json!("007")]);

        // 被引号包裹但处于"比较右侧"且是规范整数（如 a.id = '{{article_id}}'，id 是 integer 列）
        // → 还原成数值，否则 `integer = text` 报错（线上 帖子详情 工作流的根因）。
        let (sql, binds) =
            parameterize_sql_templates("SELECT * FROM t WHERE id = '{{trigger.id}}'", &ctx, 1);
        assert_eq!(sql, "SELECT * FROM t WHERE id = $1");
        assert_eq!(binds, vec![json!(42)]);

        // 关键反例：函数实参位置（NULLIF/CAST）即便是数字串也必须保持文本，
        // 否则 `NULLIF(bigint, '')` 会把 '' 当 bigint → invalid input syntax for type bigint
        // （线上 获取社区详情 工作流的根因）。
        let ctx_pid = ExecutionContext {
            trigger_data: json!({"project_id": "211903"}),
            ..ctx.clone()
        };
        let (sql, binds) = parameterize_sql_templates(
            "SELECT 1 WHERE p.project_id = CAST(NULLIF('{{trigger.project_id}}', '') AS bigint)",
            &ctx_pid,
            1,
        );
        assert_eq!(
            sql,
            "SELECT 1 WHERE p.project_id = CAST(NULLIF($1, '') AS bigint)"
        );
        assert_eq!(binds, vec![json!("211903")]);

        // JSON 取值运算符 ->> 右侧的键必须保持文本（数字串也不还原）。
        let ctx_lang = ExecutionContext {
            trigger_data: json!({"k": "123"}),
            ..ctx.clone()
        };
        let (_, binds) =
            parameterize_sql_templates("SELECT j->>'{{trigger.k}}' FROM t", &ctx_lang, 1);
        assert_eq!(binds, vec![json!("123")]);

        // 被引号包裹的普通文本（如语言码）保持文本。
        let (_, binds) = parameterize_sql_templates(
            "SELECT COALESCE(NULLIF('{{trigger.status}}',''),'en')",
            &ctx,
            1,
        );
        assert_eq!(binds, vec![json!("active")]);

        // 拼接语境（LIKE 通配符）即便值是数字串也必须保持文本（要和字符串 || 拼接）。
        let ctx_num = ExecutionContext {
            trigger_data: json!({"kw": "12345"}),
            ..ctx.clone()
        };
        let (sql, binds) = parameterize_sql_templates(
            "SELECT * FROM t WHERE name LIKE '%{{trigger.kw}}%'",
            &ctx_num,
            1,
        );
        assert_eq!(sql, "SELECT * FROM t WHERE name LIKE ('%' || $1 || '%')");
        assert_eq!(binds, vec![json!("12345")]);
    }

    #[test]
    fn sql_template_preserves_plain_string_literals_and_escapes() {
        let ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({"name": "Bob"}),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };

        // 不含模板的字面量原样保留，包括 '' 转义，不会被误改写。
        let raw = "SELECT * FROM t WHERE note = 'it''s {{ ok' AND name = {{trigger.name}}";
        let (sql, binds) = parameterize_sql_templates(raw, &ctx, 1);
        assert_eq!(
            sql,
            "SELECT * FROM t WHERE note = 'it''s {{ ok' AND name = $1"
        );
        assert_eq!(binds, vec![json!("Bob")]);

        // 含 '' 转义且内部带模板：转义引号保留在文本段里。
        let (sql, binds) =
            parameterize_sql_templates("UPDATE t SET note = 'a''b {{trigger.name}}'", &ctx, 1);
        assert_eq!(sql, "UPDATE t SET note = ('a''b ' || $1)");
        assert_eq!(binds, vec![json!("Bob")]);
    }

    #[test]
    fn restore_escaped_script_newlines_splits_json_escaped_lua_locals() {
        // 导入 JSON 多转义一层后，脚本里只剩字面 `\n`、没有真换行。
        let escaped = "local a = 1\\nlocal b = 2\\nreturn { a = a, b = b }";
        assert!(
            !escaped.contains('\n'),
            "fixture must be a single physical line"
        );
        let restored = restore_escaped_script_newlines(escaped);
        assert!(
            restored.contains('\n'),
            "escaped \\n should become real newlines: {restored:?}"
        );
        assert_eq!(
            restored,
            "local a = 1\nlocal b = 2\nreturn { a = a, b = b }"
        );
    }

    #[test]
    fn restore_escaped_script_newlines_leaves_oneliner_lua_string_escape() {
        // 合法单行脚本：`\n` 在 Lua 字符串里，不能当成「整段被 JSON 转义」。
        let code = r#"ctx.body = { msg = "hello\nworld" }"#;
        assert_eq!(restore_escaped_script_newlines(code), code);
    }

    #[test]
    fn restore_escaped_script_newlines_leaves_real_newlines() {
        let code = "local a = 1\nlocal b = 2\nreturn { a = a, b = b }";
        assert_eq!(restore_escaped_script_newlines(code), code);
    }

    #[test]
    fn resolve_node_config_keeps_lua_nested_table_in_code() {
        // Lua 嵌套表 `{{ x = 1 }}` 含 `{{`，绝不能走字符串模板替换，否则表构造被掏空，
        // 相邻 `local` 还会被粘成一行 → unexpected symbol near 'local'。
        let ctx = exec_ctx();
        let code = "local t = {{ x = 1 }}\nreturn t";
        let config = json!({ "code": code, "language": "lua" });
        let resolved = resolve_node_config(&NodeType::Code, &config, &ctx);
        assert_eq!(resolved["code"], json!(code));
    }

    #[tokio::test]
    async fn lua_code_node_accepts_json_escaped_newlines() {
        let code = "local a = 1\\nlocal b = 2\\nreturn { a = a, b = b }";
        assert!(!code.contains('\n'));
        let (output, _) = lazy_engine()
            .exec_code_node(&json!({ "code": code }), &exec_ctx())
            .await
            .expect("JSON-escaped newlines should be restored before lua.load");
        assert_eq!(output, json!({ "a": 1, "b": 2 }));
    }

    #[test]
    fn restore_script_newlines_in_nodes_fixes_code_field() {
        let escaped = "local a = ctx.nodes.x.matched_branch\\nlocal b = ctx.nodes.y.matched_branch";
        let mut nodes = json!([{
            "id": "build_state",
            "type": "code",
            "config": { "language": "lua", "code": escaped }
        }]);
        restore_script_newlines_in_nodes(&mut nodes);
        let code = nodes[0]["config"]["code"].as_str().unwrap();
        assert!(
            code.contains('\n'),
            "import must restore newlines so the editor/runtime see two statements"
        );
        assert!(!code.contains("branchlocal"));
    }

    #[test]
    fn resolve_template_skip_keys_keeps_sql_raw_but_resolves_params() {
        let ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({"email": "a@b.com"}),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };
        let config = json!({
            "sql": "SELECT * FROM t WHERE email = '{{trigger.email}}'",
            "params": ["{{trigger.email}}"],
        });
        let resolved = resolve_template_skip_keys(&config, &ctx, &["sql"]);
        // sql 原样保留
        assert_eq!(
            resolved["sql"],
            json!("SELECT * FROM t WHERE email = '{{trigger.email}}'")
        );
        // 非 sql 字段照常解析
        assert_eq!(resolved["params"], json!(["a@b.com"]));
    }

    #[tokio::test]
    async fn db_query_requires_workflow_database_id_before_querying() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://onebase:onebase@127.0.0.1:1/onebase")
            .expect("lazy pool should not connect during setup");
        let engine = DagEngine::new(pool);
        let ctx = ExecutionContext {
            workflow_id: 7,
            run_id: 99,
            trigger_type: "endpoint".into(),
            trigger_data: json!({}),
            user_id: Some(1),
            tenant_id: Some(3),
            database_id: None,
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };

        let err = engine
            .exec_db_query_node(&json!({ "sql": "SELECT 1" }), &ctx)
            .await
            .expect_err("db_query should reject workflows without database_id");

        match err {
            AppError::InvalidQuery(message) => {
                assert!(message.contains("database_id"));
            }
            other => panic!("expected InvalidQuery, got {other:?}"),
        }
    }

    #[test]
    fn email_send_config_renders_template_values() {
        let mut ctx = ExecutionContext {
            workflow_id: 7,
            run_id: 99,
            trigger_type: "endpoint".into(),
            trigger_data: json!({
                "candidate_email": "li@example.com",
                "candidate_name": "Li"
            }),
            user_id: Some(1),
            tenant_id: Some(3),
            database_id: Some(2),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };
        ctx.node_outputs.insert(
            "offer".to_string(),
            json!({ "rows": [{ "serial_num": "90951" }] }),
        );

        let raw = json!({
            "from": "HR <hr@example.com>",
            "to": "{{trigger.candidate_email}}",
            "subject": "Offer {{offer.rows[0].serial_num}} for {{trigger.candidate_name}}",
            "text_body": "Hello {{trigger.candidate_name}}, your offer is ready.",
            "smtp_host": "smtp.example.com",
            "smtp_port": 587,
            "smtp_username": "smtp-user",
            "smtp_password": "smtp-pass"
        });
        let rendered = resolve_template(&raw, &ctx);
        let config = EmailSendConfig::from_json(&rendered).expect("config should parse");

        assert_eq!(config.to, vec!["li@example.com"]);
        assert_eq!(config.subject, "Offer 90951 for Li");
        assert_eq!(
            config.text_body.as_deref(),
            Some("Hello Li, your offer is ready.")
        );
    }

    #[test]
    fn email_send_config_requires_recipient() {
        let raw = json!({
            "from": "hr@example.com",
            "subject": "Missing recipient",
            "text_body": "Hello",
            "smtp_host": "smtp.example.com"
        });

        let err = EmailSendConfig::from_json(&raw).expect_err("missing to should fail");

        match err {
            AppError::InvalidQuery(message) => {
                assert!(message.contains("收件人"));
            }
            other => panic!("expected InvalidQuery, got {other:?}"),
        }
    }

    fn lazy_engine() -> DagEngine {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://onebase:onebase@127.0.0.1:1/onebase")
            .expect("lazy pool should not connect during setup");
        DagEngine::new(pool)
    }

    fn exec_ctx() -> ExecutionContext {
        ExecutionContext {
            workflow_id: 64,
            run_id: 27902,
            trigger_type: "endpoint".into(),
            trigger_data: json!({}),
            user_id: Some(1),
            tenant_id: Some(3),
            database_id: Some(2),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        }
    }

    #[tokio::test]
    async fn javascript_code_node_respects_disabled_feature_flag() {
        // Share js_runner's env lock so parallel tests can't flip the flag mid-run.
        let _guard = crate::js_runner::ENV_LOCK.lock().unwrap();
        // Explicitly disable so dispatch reaches js_runner's disabled error (default is on).
        std::env::set_var("WORKFLOW_JS_CODE_ENABLED", "false");
        let err = lazy_engine()
            .exec_code_node(
                &json!({
                    "language": "javascript",
                    "code": "ctx.body = { ok: true };"
                }),
                &exec_ctx(),
            )
            .await
            .expect_err("disabled JavaScript execution should fail");

        std::env::remove_var("WORKFLOW_JS_CODE_ENABLED");
        assert!(
            err.to_string()
                .contains("JavaScript workflow code nodes are disabled"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn code_node_without_language_uses_lua() {
        let (output, _) = lazy_engine()
            .exec_code_node(&json!({ "code": "return { ok = true }" }), &exec_ctx())
            .await
            .expect("missing language should retain Lua execution");

        assert_eq!(output, json!({ "ok": true }));
    }

    #[tokio::test]
    async fn python_code_node_respects_disabled_feature_flag() {
        // Share py_runner's env lock so parallel tests can't flip the flag mid-run.
        let _guard = crate::py_runner::ENV_LOCK.lock().unwrap();
        // Explicitly disable so dispatch reaches py_runner's disabled error (default is on).
        std::env::set_var("WORKFLOW_PY_CODE_ENABLED", "false");
        let err = lazy_engine()
            .exec_code_node(
                &json!({
                    "language": "python",
                    "code": "ctx.body = {'ok': True}"
                }),
                &exec_ctx(),
            )
            .await
            .expect_err("disabled Python execution should fail");

        std::env::remove_var("WORKFLOW_PY_CODE_ENABLED");
        assert!(
            err.to_string()
                .contains("Python workflow code nodes are disabled"),
            "unexpected error: {err}"
        );
    }

    /// 复现反馈场景：http_call 因传输层错误（此处用内网拦截稳定触发，等价于超时 /
    /// builder error）失败，但配置了 allow_failure，工作流应继续执行后续节点。
    #[tokio::test]
    async fn allow_failure_lets_workflow_continue_after_transport_error() {
        let def = WorkflowDefinition {
            nodes: vec![
                WorkflowNode {
                    id: "faq_search".into(),
                    node_type: NodeType::HttpCall,
                    label: None,
                    // 内网地址会在发请求前被拦截返回 Err（传输/构建层错误），
                    // 正是反馈里 allow_failure 此前未覆盖的错误类别。
                    config: json!({
                        "url": "http://127.0.0.1/hybrid_search",
                        "allow_failure": true,
                        "timeout_secs": 10
                    }),
                },
                WorkflowNode {
                    id: "format_context".into(),
                    node_type: NodeType::Transform,
                    label: None,
                    config: json!({ "output": { "ok": true } }),
                },
            ],
            edges: vec![WorkflowEdge::new("faq_search", "format_context", None)],
        };

        let mut ctx = exec_ctx();
        let results = lazy_engine()
            .execute(&def, &mut ctx)
            .await
            .expect("execute should not return Err when allow_failure handles the node");

        assert_eq!(results.len(), 2, "后续节点必须继续执行");
        let faq = &results[0];
        assert_eq!(faq.node_id, "faq_search");
        assert_eq!(faq.status, NodeStatus::FailedAllowed);
        assert!(faq.error.is_some());

        let fmt = &results[1];
        assert_eq!(fmt.node_id, "format_context");
        assert_eq!(fmt.status, NodeStatus::Success);

        // 容错节点的错误以结构化对象写入上下文，供下游引用
        let faq_out = ctx
            .node_outputs
            .get("faq_search")
            .expect("error output recorded");
        assert_eq!(faq_out.get("failed"), Some(&json!(true)));
    }

    /// 反向用例：未配置 allow_failure 时仍保持原有「失败即中断」语义。
    #[tokio::test]
    async fn missing_allow_failure_still_aborts_workflow() {
        let def = WorkflowDefinition {
            nodes: vec![
                WorkflowNode {
                    id: "faq_search".into(),
                    node_type: NodeType::HttpCall,
                    label: None,
                    config: json!({ "url": "http://127.0.0.1/hybrid_search" }),
                },
                WorkflowNode {
                    id: "format_context".into(),
                    node_type: NodeType::Transform,
                    label: None,
                    config: json!({ "output": { "ok": true } }),
                },
            ],
            edges: vec![WorkflowEdge::new("faq_search", "format_context", None)],
        };

        let mut ctx = exec_ctx();
        let results = lazy_engine()
            .execute(&def, &mut ctx)
            .await
            .expect("execute returns Ok with partial results");

        assert_eq!(results.len(), 1, "失败后应中断，后续节点不执行");
        assert_eq!(results[0].status, NodeStatus::Failed);
    }

    #[test]
    fn call_workflow_node_type_wire_format_is_snake_case() {
        let n: WorkflowNode = serde_json::from_value(json!({
            "id": "call_sub",
            "type": "call_workflow",
            "config": { "workflow": "get-detail", "input": "{}" }
        }))
        .expect("call_workflow 应能反序列化");
        assert_eq!(n.node_type, NodeType::CallWorkflow);
    }

    #[test]
    fn call_workflow_skips_input_template_at_config_stage() {
        // input 在 config 阶段保持原文（含 {{}}），由执行器再解析；workflow/slug 正常替换。
        let mut ctx = exec_ctx();
        ctx.trigger_data = json!({ "uid": "u-42" });
        let cfg = resolve_template_skip_keys(
            &json!({ "workflow": "sub-{{trigger.uid}}", "input": "{\"id\": \"{{trigger.uid}}\"}" }),
            &ctx,
            &["input"],
        );
        assert_eq!(
            cfg.get("workflow").and_then(|v| v.as_str()),
            Some("sub-u-42")
        );
        assert_eq!(
            cfg.get("input").and_then(|v| v.as_str()),
            Some("{\"id\": \"{{trigger.uid}}\"}"),
            "input 应保持原文不被字符串替换"
        );
    }

    #[test]
    fn subworkflow_run_is_recorded_only_for_real_parent_runs() {
        let mut ctx = exec_ctx();
        assert!(should_record_subworkflow_run(&ctx));

        ctx.dry_run = true;
        assert!(!should_record_subworkflow_run(&ctx));

        ctx.dry_run = false;
        ctx.run_id = 0;
        assert!(
            !should_record_subworkflow_run(&ctx),
            "debug 路径 run_id=0 不应落子工作流 run"
        );

        ctx.run_id = 10;
        ctx.workflow_id = 0;
        assert!(!should_record_subworkflow_run(&ctx));
    }

    #[test]
    fn summarize_subworkflow_run_uses_failed_node_and_response_output() {
        let results = vec![
            NodeExecutionResult {
                node_id: "a".into(),
                node_type: Some("code".into()),
                status: NodeStatus::Success,
                input: JsonValue::Null,
                output: json!({"ok": true}),
                elapsed_ms: 1,
                error: None,
                branch: None,
            },
            NodeExecutionResult {
                node_id: "b".into(),
                node_type: Some("code".into()),
                status: NodeStatus::Failed,
                input: JsonValue::Null,
                output: JsonValue::Null,
                elapsed_ms: 2,
                error: Some("boom".into()),
                branch: None,
            },
        ];
        let summary = summarize_subworkflow_run(&results, json!({"from": "response"}));
        assert_eq!(summary.status, "failed");
        assert_eq!(summary.index_status, "failed");
        assert_eq!(summary.error_message.as_deref(), Some("boom"));
        assert_eq!(summary.final_output, json!({"from": "response"}));
    }

    #[test]
    fn summarize_subworkflow_run_completed_when_no_hard_failure() {
        let results = vec![NodeExecutionResult {
            node_id: "a".into(),
            node_type: Some("response".into()),
            status: NodeStatus::Success,
            input: JsonValue::Null,
            output: json!(1),
            elapsed_ms: 1,
            error: None,
            branch: None,
        }];
        let summary = summarize_subworkflow_run(&results, json!(1));
        assert_eq!(summary.status, "completed");
        assert_eq!(summary.index_status, "success");
        assert!(summary.error_message.is_none());
    }

    #[test]
    fn parse_json_object_field_accepts_json_object_string() {
        let parsed =
            parse_json_object_field("http_call.body", &json!("{\"agent_id\":\"cs-executor\"}"))
                .expect("should parse object string");
        assert_eq!(
            parsed,
            json!({
                "agent_id": "cs-executor"
            })
        );
    }

    #[test]
    fn parse_json_object_field_rejects_non_object_json_string() {
        let err = parse_json_object_field("call_workflow.input", &json!("[1,2,3]"))
            .expect_err("array string should be rejected");
        assert!(
            err.to_string().contains("必须是 JSON 对象"),
            "error should clearly explain object requirement"
        );
    }

    #[test]
    fn config_allow_failure_accepts_common_truthy_forms() {
        assert!(config_allow_failure(&json!({ "allow_failure": true })));
        assert!(config_allow_failure(&json!({ "allow_failure": "true" })));
        assert!(config_allow_failure(&json!({ "allow_failure": "YES" })));
        assert!(config_allow_failure(&json!({ "allow_failure": 1 })));
        assert!(!config_allow_failure(&json!({ "allow_failure": false })));
        assert!(!config_allow_failure(&json!({ "allow_failure": "no" })));
        assert!(!config_allow_failure(&json!({})));
    }

    #[test]
    fn test_resolve_sse_topic_placeholders() {
        let ctx = ExecutionContext {
            workflow_id: 7,
            run_id: 99,
            trigger_type: "endpoint".into(),
            trigger_data: json!({}),
            user_id: Some(1),
            tenant_id: Some(3),
            database_id: Some(2),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };
        assert_eq!(
            resolve_sse_topic("db:{database_id}:workflow:{workflow_id}:run:{run_id}", &ctx),
            "db:2:workflow:7:run:99"
        );
        assert_eq!(
            resolve_sse_topic("tenant:{tenant_id}:notify", &ctx),
            "tenant:3:notify"
        );
        // 无占位符原样返回
        assert_eq!(resolve_sse_topic("sys:broadcast", &ctx), "sys:broadcast");
    }

    fn sample_ctx_with_trigger(trigger_data: JsonValue) -> ExecutionContext {
        ExecutionContext {
            workflow_id: 7,
            run_id: 99,
            trigger_type: "notify".into(),
            trigger_data,
            user_id: Some(1),
            tenant_id: Some(3),
            database_id: Some(2),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        }
    }

    #[test]
    fn parse_recipient_list_accepts_array_and_dedups() {
        let ids = parse_recipient_list(&json!([5, 6, 5, "7"])).unwrap();
        assert_eq!(ids, vec!["5", "6", "7"]);
    }

    #[test]
    fn parse_recipient_list_accepts_way_uid_strings() {
        let ids =
            parse_recipient_list(&json!(["adosp9duiiysjbwzetodwomnie", "otherwayuid123"])).unwrap();
        assert_eq!(ids, vec!["adosp9duiiysjbwzetodwomnie", "otherwayuid123"]);
    }

    #[test]
    fn parse_recipient_list_accepts_comma_string() {
        let ids = parse_recipient_list(&json!("5,6,7")).unwrap();
        assert_eq!(ids, vec!["5", "6", "7"]);
    }

    #[test]
    fn parse_recipient_list_rejects_empty() {
        assert!(parse_recipient_list(&json!([])).is_err());
        assert!(parse_recipient_list(&json!("")).is_err());
    }

    #[test]
    fn parse_recipient_list_rejects_colon_in_segment() {
        assert!(parse_recipient_list(&json!(["bad:uid"])).is_err());
    }

    #[test]
    fn resolve_sse_user_id_list_from_topic_template() {
        let ctx = sample_ctx_with_trigger(json!({ "recipient_ids": [5, 6, 7] }));
        let ids = resolve_sse_user_id_list("user:{{trigger.recipient_ids}}:notify", None, &ctx)
            .unwrap()
            .unwrap();
        assert_eq!(ids, vec!["5", "6", "7"]);
    }

    #[test]
    fn resolve_sse_user_id_list_from_way_uid_template() {
        let ctx = sample_ctx_with_trigger(json!({
            "recipient_ids": ["adosp9duiiysjbwzetodwomnie", "otherwayuid123"]
        }));
        let ids = resolve_sse_user_id_list("user:{{trigger.recipient_ids}}:notify", None, &ctx)
            .unwrap()
            .unwrap();
        assert_eq!(ids, vec!["adosp9duiiysjbwzetodwomnie", "otherwayuid123"]);
    }

    #[test]
    fn resolve_sse_user_id_list_from_user_ids_field() {
        let ctx = sample_ctx_with_trigger(json!({ "recipient_ids": [1, 2] }));
        let ids = resolve_sse_user_id_list(
            "user:{uid}:alert",
            Some(&json!("{{trigger.recipient_ids}}")),
            &ctx,
        )
        .unwrap()
        .unwrap();
        assert_eq!(ids, vec!["1", "2"]);
    }

    #[test]
    fn expand_user_topics_builds_per_user_topics() {
        let ctx = sample_ctx_with_trigger(json!({}));
        let topics = expand_user_topics(
            "user:{{trigger.ids}}:notify",
            &["5".to_string(), "6".to_string()],
            &ctx,
        )
        .unwrap();
        assert_eq!(topics, vec!["user:5:notify", "user:6:notify"]);
    }

    #[test]
    fn expand_user_topics_with_way_uid() {
        let ctx = sample_ctx_with_trigger(json!({}));
        let topics = expand_user_topics(
            "user:{uid}:notify",
            &["adosp9duiiysjbwzetodwomnie".to_string()],
            &ctx,
        )
        .unwrap();
        assert_eq!(topics, vec!["user:adosp9duiiysjbwzetodwomnie:notify"]);
    }

    #[test]
    fn expand_user_topics_with_uid_placeholder() {
        let ctx = sample_ctx_with_trigger(json!({}));
        let topics = expand_user_topics(
            "user:{uid}:workflow:{workflow_id}",
            &["9".to_string()],
            &ctx,
        )
        .unwrap();
        assert_eq!(topics, vec!["user:9:workflow:7"]);
    }

    #[test]
    fn batch_count_splits_into_chunks() {
        assert_eq!(batch_count(250, 100), 3);
        assert_eq!(batch_count(100, 100), 1);
        assert_eq!(batch_count(1, 100), 1);
    }

    #[test]
    fn resolve_sse_user_id_list_single_id_still_parsed() {
        let ctx = sample_ctx_with_trigger(json!({ "recipient_ids": [5] }));
        let ids = resolve_sse_user_id_list("user:{{trigger.recipient_ids}}:notify", None, &ctx)
            .unwrap()
            .unwrap();
        assert_eq!(ids, vec!["5"]);
    }

    #[test]
    fn effective_sse_batch_size_clamps_config() {
        let settings = crate::sse_batch_config::SseBatchSettings::default();
        assert_eq!(
            effective_sse_batch_size(&json!({ "batch_size": 9999 }), &settings),
            settings.max_chunk_size
        );
        assert_eq!(
            effective_sse_batch_size(&json!({}), &settings),
            settings.default_chunk_size
        );
    }

    #[test]
    fn effective_max_recipients_unlimited_by_default() {
        let settings = crate::sse_batch_config::SseBatchSettings::default();
        assert_eq!(effective_max_recipients(&json!({}), &settings), 0);
        assert_eq!(
            effective_max_recipients(&json!({ "max_recipients": 999_999 }), &settings),
            999_999
        );
        assert_eq!(
            effective_max_recipients(&json!({ "max_recipients": 100 }), &settings),
            100
        );
    }

    #[test]
    fn effective_max_recipients_clamps_to_settings_cap() {
        let settings = crate::sse_batch_config::SseBatchSettings {
            max_recipients: 50_000,
            ..Default::default()
        };
        assert_eq!(
            effective_max_recipients(&json!({ "max_recipients": 999_999 }), &settings),
            50_000
        );
        assert_eq!(
            effective_max_recipients(&json!({ "max_recipients": 100 }), &settings),
            100
        );
    }

    #[test]
    fn resolve_sse_dispatch_mode_auto_async_above_threshold() {
        let settings = crate::sse_batch_config::SseBatchSettings {
            async_threshold: 1000,
            ..Default::default()
        };
        assert!(matches!(
            resolve_sse_dispatch_mode(&json!({}), 1500, &settings),
            SseDispatchMode::Async { auto_async: true }
        ));
    }

    #[test]
    fn resolve_sse_dispatch_mode_batch_always_async() {
        let settings = crate::sse_batch_config::SseBatchSettings::default();
        assert!(matches!(
            resolve_sse_dispatch_mode(&json!({}), 500, &settings),
            SseDispatchMode::Async { auto_async: true }
        ));
        assert!(matches!(
            resolve_sse_dispatch_mode(&json!({ "dispatch": "sync" }), 5000, &settings),
            SseDispatchMode::Async { auto_async: true }
        ));
    }

    #[test]
    fn resolve_sse_dispatch_mode_single_recipient_can_sync() {
        let settings = crate::sse_batch_config::SseBatchSettings::default();
        assert!(matches!(
            resolve_sse_dispatch_mode(&json!({}), 1, &settings),
            SseDispatchMode::Sync
        ));
    }

    #[test]
    fn resolve_sse_dispatch_mode_explicit_async() {
        let settings = crate::sse_batch_config::SseBatchSettings::default();
        assert!(matches!(
            resolve_sse_dispatch_mode(&json!({ "dispatch": "async" }), 1, &settings),
            SseDispatchMode::Async { auto_async: false }
        ));
    }

    #[test]
    fn sse_batch_settings_default_unlimited() {
        let settings = crate::sse_batch_config::SseBatchSettings::default();
        assert_eq!(settings.max_recipients, 0);
        assert_eq!(settings.default_chunk_size, 500);
        assert_eq!(settings.async_threshold, 1);
    }

    #[test]
    fn test_env_template_resolution() {
        let mut ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({"action": "create"}),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };
        ctx.env_vars.insert(
            "PLUGIN_STRIPE_SECRET_KEY".to_string(),
            "sk_live_abcdef".to_string(),
        );

        // {{env.X}} 单表达式：返回变量值字符串
        assert_eq!(
            resolve_template(&json!("{{env.PLUGIN_STRIPE_SECRET_KEY}}"), &ctx),
            json!("sk_live_abcdef")
        );
        // 混合模式：嵌入变量后整体为字符串
        assert_eq!(
            resolve_template(&json!("Bearer {{env.PLUGIN_STRIPE_SECRET_KEY}}"), &ctx),
            json!("Bearer sk_live_abcdef")
        );
        // 未定义变量渲染为空串（不报错）
        assert_eq!(resolve_template(&json!("{{env.NOT_SET}}"), &ctx), json!(""));
        // condition 表达式路径同样汇入 resolve_path → env. 命名空间自动生效
        assert!(evaluate_expression(
            "{{env.PLUGIN_STRIPE_SECRET_KEY}} == \"sk_live_abcdef\"",
            &ctx
        ));
    }

    #[test]
    fn test_mask_env_values() {
        let mut env_vars = HashMap::new();
        env_vars.insert("SECRET".to_string(), "sk_live_abcdef".to_string());
        env_vars.insert("SHORT".to_string(), "ok".to_string()); // 长度 < 4，应跳过

        // 嵌套结构里的长变量值被替换为 ***
        let value = json!({
            "header": "Bearer sk_live_abcdef",
            "nested": { "key": "sk_live_abcdef" },
            "note": "status ok"
        });
        let masked = mask_env_values(&value, &env_vars);
        assert_eq!(masked["header"], json!("Bearer ***"));
        assert_eq!(masked["nested"]["key"], json!("***"));
        // 长度 < 4 的值（"ok"）不参与掩码，原文保留
        assert_eq!(masked["note"], json!("status ok"));

        // 无可掩内容时原样返回
        let empty: HashMap<String, String> = HashMap::new();
        assert_eq!(mask_env_values(&value, &empty), value);
    }

    #[test]
    fn test_mask_env_values_substring_ordering() {
        // 短密钥是长密钥的子串：必须先掩长值，否则长值会被打成 ***_2024 泄漏后缀
        let mut env_vars = HashMap::new();
        env_vars.insert("KEY".to_string(), "sk_live".to_string());
        env_vars.insert("KEY_FULL".to_string(), "sk_live_2024".to_string());
        let value = json!({ "a": "sk_live", "b": "sk_live_2024" });
        let masked = mask_env_values(&value, &env_vars);
        assert_eq!(masked["a"], json!("***"));
        assert_eq!(masked["b"], json!("***")); // 不是 "***_2024"
    }

    #[test]
    fn test_mask_env_values_json_special_chars() {
        // 值含引号/反斜杠：树遍历对反转义后的原始字符串匹配，不受 JSON 转义影响
        let mut env_vars = HashMap::new();
        env_vars.insert("SECRET".to_string(), r#"a"b\c_secret"#.to_string());
        let value = json!({ "h": r#"prefix a"b\c_secret suffix"# });
        let masked = mask_env_values(&value, &env_vars);
        assert_eq!(masked["h"], json!("prefix *** suffix"));
    }

    #[test]
    fn test_condition_evaluation() {
        let mut ctx = ExecutionContext {
            workflow_id: 1,
            run_id: 1,
            trigger_type: "endpoint".into(),
            trigger_data: json!({"action": "create"}),
            user_id: Some(1),
            tenant_id: Some(1),
            database_id: Some(1),
            node_outputs: HashMap::new(),
            env_vars: HashMap::new(),
            workflow_dependencies: json!({}),
            dry_run: false,
            prod_readonly: false,
            apikey_write_guard: ApiKeyWriteGuard::Off,
        };
        ctx.node_outputs
            .insert("check".to_string(), json!({"count": 5}));

        assert!(evaluate_expression(
            "{{trigger.action}} == \"create\"",
            &ctx
        ));
        assert!(!evaluate_expression(
            "{{trigger.action}} == \"delete\"",
            &ctx
        ));
        assert!(evaluate_expression("{{check.count}} > 0", &ctx));
        assert!(!evaluate_expression("{{check.count}} > 10", &ctx));
        assert!(evaluate_expression("true", &ctx));
        assert!(!evaluate_expression("false", &ctx));
    }

    // ─── loop 循环节点测试 ─────────────────────────────────────
    //
    // 循环体用 transform 节点（无副作用、不连 DB，lazy pool 下安全），
    // body 节点经 loop_back 回边连回 loop，done 出口接后续节点。

    fn loop_node(id: &str, config: JsonValue) -> WorkflowNode {
        WorkflowNode {
            id: id.into(),
            node_type: NodeType::Loop,
            label: None,
            config,
        }
    }

    fn transform_node(id: &str, output: JsonValue) -> WorkflowNode {
        WorkflowNode {
            id: id.into(),
            node_type: NodeType::Transform,
            label: None,
            config: json!({ "output": output }),
        }
    }

    fn body_branch(from: &str, to: &str) -> WorkflowEdge {
        WorkflowEdge::new(from, to, Some(LOOP_BODY_BRANCH.to_string()))
    }
    fn done_branch(from: &str, to: &str) -> WorkflowEdge {
        WorkflowEdge::new(from, to, Some(LOOP_DONE_BRANCH.to_string()))
    }

    /// count 模式：跑固定次数；{{loop.index}} 从 0 递增；done 出口后续节点执行；
    /// 循环体节点不作为顶层结果出现。
    #[tokio::test]
    async fn loop_count_mode_runs_fixed_times() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node("lp", json!({ "loop_mode": "count", "count": 3 })),
                transform_node("t", json!("{{loop.index}}")),
                transform_node("d", json!("finished")),
            ],
            edges: vec![
                body_branch("lp", "t"),
                WorkflowEdge::loop_back("t", "lp"),
                done_branch("lp", "d"),
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();

        // 顶层结果只应有 loop + done，循环体节点 t 不出现在顶层。
        assert_eq!(results.len(), 2, "顶层结果应为 loop + done");
        assert!(
            results.iter().all(|r| r.node_id != "t"),
            "循环体节点不应出现在顶层结果"
        );

        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(lp.status, NodeStatus::Success);
        assert_eq!(lp.output["iterations"], json!(3));
        assert_eq!(lp.output["results"], json!([0, 1, 2]));
        assert_eq!(lp.output["reached_max"], json!(false));
        assert_eq!(lp.branch.as_deref(), Some("done"));

        let d = results.iter().find(|r| r.node_id == "d").unwrap();
        assert_eq!(d.status, NodeStatus::Success);
        assert_eq!(d.output, json!("finished"));

        // loop 输出对下游可见。
        assert_eq!(ctx.node_outputs["lp"]["iterations"], json!(3));
    }

    /// while 模式：进体前判断，条件用 {{loop.index}}。
    #[tokio::test]
    async fn loop_while_mode_evaluates_before_body() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "while", "expression": "{{loop.index}} < 3", "max_iterations": 10 }),
                ),
                transform_node("t", json!("{{loop.index}}")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(lp.output["iterations"], json!(3));
        assert_eq!(lp.output["results"], json!([0, 1, 2]));
        assert_eq!(lp.output["reached_max"], json!(false));
    }

    /// until 模式：执行体后判断，条件读循环体输出（至少执行一次）。
    #[tokio::test]
    async fn loop_until_mode_evaluates_after_body() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "until", "expression": "{{t}} >= 2", "max_iterations": 10 }),
                ),
                // t 输出 = 当前已执行次数（1,2,...）
                transform_node("t", json!("{{loop.count}}")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(
            lp.output["iterations"],
            json!(2),
            "until 至少执行一次，第2轮命中退出"
        );
        assert_eq!(lp.output["results"], json!([1, 2]));
    }

    /// for_each 模式：遍历数组，{{loop.item}} 为当前元素。
    #[tokio::test]
    async fn loop_for_each_mode_iterates_items() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "for_each", "items": "{{trigger.items}}" }),
                ),
                transform_node("t", json!("{{loop.item}}")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        let mut ctx = exec_ctx();
        ctx.trigger_data = json!({ "items": [10, 20, 30] });
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(lp.output["iterations"], json!(3));
        assert_eq!(lp.output["results"], json!([10, 20, 30]));
        assert_eq!(lp.output["item"], json!(30));
    }

    /// for_each 并发：concurrency>1 时所有 item 都执行，且 results 仍按 item 原序。
    /// items 数量 > concurrency，触发分批消费；顺序由 sort_by_key(index) 保证。
    #[tokio::test]
    async fn loop_for_each_concurrent_preserves_order() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "for_each", "items": "{{trigger.items}}", "concurrency": 3 }),
                ),
                transform_node("t", json!("{{loop.item}}")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        let mut ctx = exec_ctx();
        ctx.trigger_data = json!({ "items": [1, 2, 3, 4, 5, 6, 7] });
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(lp.output["iterations"], json!(7));
        assert_eq!(lp.output["results"], json!([1, 2, 3, 4, 5, 6, 7]));
        assert_eq!(
            lp.output["item"],
            json!(7),
            "last_item 取最高 index 的元素（确定性）"
        );
        assert_eq!(lp.output["reached_max"], json!(false));
        // _iterations 也应按 index 原序。
        let iters = lp.output["_iterations"].as_array().unwrap();
        let idxs: Vec<u64> = iters
            .iter()
            .map(|it| it["index"].as_u64().unwrap())
            .collect();
        assert_eq!(idxs, vec![0, 1, 2, 3, 4, 5, 6]);
    }

    /// for_each items 解析为空对象 `{}`（Lua 空表序列化结果）→ 视为空数组，0 次迭代不报错。
    #[tokio::test]
    async fn loop_for_each_empty_object_items_runs_zero_times() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "for_each", "items": "{{trigger.items}}" }),
                ),
                transform_node("t", json!("{{loop.item}}")),
                transform_node("d", json!("finished")),
            ],
            edges: vec![
                body_branch("lp", "t"),
                WorkflowEdge::loop_back("t", "lp"),
                done_branch("lp", "d"),
            ],
        };
        let mut ctx = exec_ctx();
        ctx.trigger_data = json!({ "items": {} });
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(lp.status, NodeStatus::Success);
        assert_eq!(lp.output["iterations"], json!(0));
        assert_eq!(lp.output["results"], json!([]));
        // done 出口后续节点仍应执行。
        assert!(results.iter().any(|r| r.node_id == "d"));
    }

    /// for_each concurrency=1 显式配置 → 与串行完全一致（回归）。
    #[tokio::test]
    async fn loop_for_each_concurrency_one_matches_sequential() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "for_each", "items": "{{trigger.items}}", "concurrency": 1 }),
                ),
                transform_node("t", json!("{{loop.item}}")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        let mut ctx = exec_ctx();
        ctx.trigger_data = json!({ "items": [10, 20, 30] });
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(lp.output["results"], json!([10, 20, 30]));
        assert_eq!(lp.output["item"], json!(30));
    }

    /// for_each 并发 + allow_failure：部分轮失败不中断，成功轮仍进 results，had_failures=true。
    #[tokio::test]
    async fn loop_for_each_concurrent_allow_failure_continues() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "for_each", "items": "{{trigger.items}}", "concurrency": 2, "allow_failure": true }),
                ),
                // 内网地址在发请求前被拦截 → 每轮循环体硬失败
                WorkflowNode {
                    id: "h".into(),
                    node_type: NodeType::HttpCall,
                    label: None,
                    config: json!({ "url": "http://127.0.0.1/x", "timeout_secs": 5 }),
                },
            ],
            edges: vec![body_branch("lp", "h"), WorkflowEdge::loop_back("h", "lp")],
        };
        let mut ctx = exec_ctx();
        ctx.trigger_data = json!({ "items": [1, 2, 3] });
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(
            lp.status,
            NodeStatus::Success,
            "allow_failure 下 loop 整体成功"
        );
        assert_eq!(lp.output["had_failures"], json!(true));
        assert_eq!(
            lp.output["iterations"],
            json!(3),
            "三轮都跑到（失败也计数）"
        );
    }

    /// for_each 并发 + 无 allow_failure：任一轮失败中断整个工作流。
    #[tokio::test]
    async fn loop_for_each_concurrent_aborts_without_allow_failure() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "for_each", "items": "{{trigger.items}}", "concurrency": 2 }),
                ),
                WorkflowNode {
                    id: "h".into(),
                    node_type: NodeType::HttpCall,
                    label: None,
                    config: json!({ "url": "http://127.0.0.1/x", "timeout_secs": 5 }),
                },
                transform_node("d", json!("finished")),
            ],
            edges: vec![
                body_branch("lp", "h"),
                WorkflowEdge::loop_back("h", "lp"),
                done_branch("lp", "d"),
            ],
        };
        let mut ctx = exec_ctx();
        ctx.trigger_data = json!({ "items": [1, 2, 3] });
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(lp.status, NodeStatus::Failed);
        assert!(
            results.iter().all(|r| r.node_id != "d"),
            "loop 失败后 done 出口不应执行"
        );
    }

    /// 校验：for_each concurrency 超过服务端硬上限 → 报错。
    #[test]
    fn loop_rejects_concurrency_over_hard_cap() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "for_each", "items": "{{trigger.items}}", "concurrency": 99 }),
                ),
                transform_node("t", json!("{{loop.item}}")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        assert!(
            validate_definition(&def).is_err(),
            "concurrency 超上限应报错"
        );
    }

    /// 校验：非 for_each 模式不支持并发。
    #[test]
    fn loop_rejects_concurrency_on_non_for_each() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "count", "count": 2, "concurrency": 2 }),
                ),
                transform_node("t", json!("x")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        assert!(validate_definition(&def).is_err(), "count 模式并发应报错");
    }

    /// 校验：并发 for_each 循环体引用 {{loop.results}} → 报错。
    #[test]
    fn loop_concurrent_for_each_rejects_loop_results_reference() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "for_each", "items": "{{trigger.items}}", "concurrency": 2 }),
                ),
                transform_node("t", json!("{{loop.results}}")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        assert!(
            validate_definition(&def).is_err(),
            "并发 for_each 引用 {{loop.results}} 应报错"
        );
        // 串行（默认 concurrency=1）时引用 {{loop.results}} 仍应允许。
        let seq = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "for_each", "items": "{{trigger.items}}" }),
                ),
                transform_node("t", json!("{{loop.results}}")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        assert!(
            validate_definition(&seq).is_ok(),
            "串行 for_each 引用 results 应允许"
        );
    }

    /// max_iterations 兜底：while 条件恒真时被安全上限截断，reached_max=true。
    #[tokio::test]
    async fn loop_while_capped_by_max_iterations() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "while", "expression": "true", "max_iterations": 5 }),
                ),
                transform_node("t", json!("x")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(lp.output["iterations"], json!(5));
        assert_eq!(lp.output["reached_max"], json!(true));
    }

    /// allow_failure=true：循环体节点报错不中断，记录失败后继续下一轮。
    #[tokio::test]
    async fn loop_allow_failure_continues_on_body_error() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "count", "count": 2, "allow_failure": true }),
                ),
                // 内网地址在发请求前被拦截 → 循环体硬失败
                WorkflowNode {
                    id: "h".into(),
                    node_type: NodeType::HttpCall,
                    label: None,
                    config: json!({ "url": "http://127.0.0.1/x", "timeout_secs": 5 }),
                },
            ],
            edges: vec![body_branch("lp", "h"), WorkflowEdge::loop_back("h", "lp")],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(
            lp.status,
            NodeStatus::Success,
            "allow_failure 下 loop 整体成功"
        );
        assert_eq!(lp.output["had_failures"], json!(true));
        assert_eq!(
            lp.output["iterations"],
            json!(2),
            "两轮都跑到（失败也计数）"
        );
    }

    /// 不配 allow_failure：循环体硬失败应中断整个工作流。
    #[tokio::test]
    async fn loop_body_failure_aborts_without_allow_failure() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node("lp", json!({ "loop_mode": "count", "count": 2 })),
                WorkflowNode {
                    id: "h".into(),
                    node_type: NodeType::HttpCall,
                    label: None,
                    config: json!({ "url": "http://127.0.0.1/x", "timeout_secs": 5 }),
                },
                transform_node("d", json!("finished")),
            ],
            edges: vec![
                body_branch("lp", "h"),
                WorkflowEdge::loop_back("h", "lp"),
                done_branch("lp", "d"),
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(lp.status, NodeStatus::Failed);
        assert!(
            results.iter().all(|r| r.node_id != "d"),
            "loop 失败后 done 出口不应执行"
        );
    }

    /// 嵌套 loop：外层每轮驱动内层循环，均正确计数。
    #[tokio::test]
    async fn loop_nested_executes_inner_per_outer_iteration() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node("o", json!({ "loop_mode": "count", "count": 2 })),
                loop_node("i", json!({ "loop_mode": "count", "count": 2 })),
                transform_node("it", json!("{{loop.index}}")),
            ],
            edges: vec![
                body_branch("o", "i"),              // 外层体入口 = 内层 loop
                body_branch("i", "it"),             // 内层体入口 = transform
                WorkflowEdge::loop_back("it", "i"), // 内层回边
                WorkflowEdge::loop_back("i", "o"),  // 外层回边（内层 loop 是外层体末节点）
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let o = results.iter().find(|r| r.node_id == "o").unwrap();
        assert_eq!(o.status, NodeStatus::Success);
        assert_eq!(o.output["iterations"], json!(2), "外层跑 2 轮");
        // 外层每轮收集内层 loop 的汇总输出；内层各跑 2 轮。
        assert_eq!(o.output["results"][0]["iterations"], json!(2));
        assert_eq!(o.output["results"][1]["iterations"], json!(2));
    }

    /// 校验：含 loop_back 回边的工作流不再被误判为「循环依赖」。
    #[test]
    fn loop_back_edge_not_rejected_as_cycle() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node("lp", json!({ "loop_mode": "count", "count": 1 })),
                transform_node("t", json!("x")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        assert!(
            validate_definition(&def).is_ok(),
            "loop_back 回边不应触发环检测"
        );
        // 但真实的非回边环仍应被拒。
        let cyclic = WorkflowDefinition {
            nodes: vec![
                transform_node("a", json!("x")),
                transform_node("b", json!("y")),
            ],
            edges: vec![
                WorkflowEdge::new("a", "b", None),
                WorkflowEdge::new("b", "a", None),
            ],
        };
        assert!(validate_definition(&cyclic).is_err(), "普通环仍应被检测");
    }

    /// 校验：接线的 loop 缺回边应报错；while 缺 max_iterations 应报错。
    #[test]
    fn loop_structural_validation_rejects_malformed() {
        // 有 body 无回边
        let no_back = WorkflowDefinition {
            nodes: vec![
                loop_node("lp", json!({ "loop_mode": "count", "count": 1 })),
                transform_node("t", json!("x")),
            ],
            edges: vec![body_branch("lp", "t")],
        };
        assert!(validate_definition(&no_back).is_err(), "缺回边应报错");

        // while 缺 max_iterations
        let no_max = WorkflowDefinition {
            nodes: vec![
                loop_node("lp", json!({ "loop_mode": "while", "expression": "true" })),
                transform_node("t", json!("x")),
            ],
            edges: vec![body_branch("lp", "t"), WorkflowEdge::loop_back("t", "lp")],
        };
        assert!(
            validate_definition(&no_max).is_err(),
            "while 缺 max_iterations 应报错"
        );
    }

    /// 完全未接线的 loop 节点（草稿态）应允许保存（校验通过），仅执行时报错。
    #[test]
    fn loop_unwired_draft_passes_validation() {
        let def = WorkflowDefinition {
            nodes: vec![loop_node("lp", json!({ "loop_mode": "count", "count": 1 }))],
            edges: vec![],
        };
        assert!(
            validate_definition(&def).is_ok(),
            "未接线 loop 草稿应可保存"
        );
    }

    #[test]
    fn loop_rejects_body_edge_leaking_outside_closed_region() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node("lp", json!({ "loop_mode": "count", "count": 1 })),
                transform_node("body", json!("body")),
                transform_node("outside", json!("outside")),
            ],
            edges: vec![
                body_branch("lp", "body"),
                WorkflowEdge::loop_back("body", "lp"),
                WorkflowEdge::new("body", "outside", None),
            ],
        };
        assert!(validate_definition(&def).is_err());
    }

    #[test]
    fn loop_rejects_done_target_shared_with_body() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node("lp", json!({ "loop_mode": "count", "count": 1 })),
                transform_node("body", json!("body")),
                transform_node("shared", json!("shared")),
            ],
            edges: vec![
                body_branch("lp", "body"),
                WorkflowEdge::new("body", "shared", None),
                WorkflowEdge::loop_back("shared", "lp"),
                done_branch("lp", "shared"),
            ],
        };
        assert!(validate_definition(&def).is_err());
    }

    #[test]
    fn loop_rejects_sibling_regions_sharing_node() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node("a", json!({ "loop_mode": "count", "count": 1 })),
                loop_node("b", json!({ "loop_mode": "count", "count": 1 })),
                transform_node("shared", json!("shared")),
            ],
            edges: vec![
                body_branch("a", "shared"),
                body_branch("b", "shared"),
                WorkflowEdge::loop_back("shared", "a"),
                WorkflowEdge::loop_back("shared", "b"),
            ],
        };
        assert!(validate_definition(&def).is_err());
    }

    #[test]
    fn loop_rejects_back_marker_targeting_non_loop_or_partial_marker() {
        let nodes = vec![
            transform_node("a", json!("a")),
            transform_node("b", json!("b")),
        ];
        let wrong_target = WorkflowDefinition {
            nodes: nodes.clone(),
            edges: vec![WorkflowEdge::loop_back("a", "b")],
        };
        assert!(validate_definition(&wrong_target).is_err());

        let partial = WorkflowDefinition {
            nodes,
            edges: vec![WorkflowEdge {
                from: "a".into(),
                to: "b".into(),
                branch: None,
                edge_type: Some(LOOP_BACK_EDGE_TYPE.to_string()),
                target_handle: None,
            }],
        };
        assert!(validate_definition(&partial).is_err());
    }

    #[test]
    fn workflow_edge_old_json_remains_compatible() {
        let edge: WorkflowEdge = serde_json::from_value(json!({ "from": "a", "to": "b" })).unwrap();
        assert_eq!(edge.from, "a");
        assert_eq!(edge.to, "b");
        assert!(edge.branch.is_none());
        assert!(edge.edge_type.is_none());
        assert!(edge.target_handle.is_none());

        let camel_case: WorkflowEdge = serde_json::from_value(json!({
            "from": "body",
            "to": "lp",
            "edgeType": "loop_back",
            "targetHandle": "back"
        }))
        .unwrap();
        assert!(camel_case.is_loop_back());
    }

    fn condition_node(id: &str, config: JsonValue) -> WorkflowNode {
        WorkflowNode {
            id: id.into(),
            node_type: NodeType::Condition,
            label: None,
            config,
        }
    }

    fn node_result<'a>(results: &'a [NodeExecutionResult], id: &str) -> &'a NodeExecutionResult {
        results
            .iter()
            .find(|r| r.node_id == id)
            .unwrap_or_else(|| panic!("missing node result {id}"))
    }

    /// 形态 A：`expression` 为单个 `{{node.path}}`，解析结果是非空数组时应命中分支。
    /// 复现 wf40 `check_notify_open_id_found`：Mind records 非空却 matched_branch=false。
    #[tokio::test]
    async fn condition_form_a_nonempty_array_template_matches() {
        let def = WorkflowDefinition {
            nodes: vec![
                transform_node(
                    "src",
                    json!({ "body": { "data": { "records": [{ "open_id": "ou_1" }] } } }),
                ),
                condition_node(
                    "check",
                    json!({
                        "conditions": [{
                            "branch": "found",
                            "expression": "{{src.body.data.records}}"
                        }],
                        "default_branch": "false"
                    }),
                ),
                transform_node("notify", json!("sent")),
                transform_node("skip", json!("skipped")),
            ],
            edges: vec![
                WorkflowEdge::new("src", "check", None),
                WorkflowEdge::new("check", "notify", Some("found".into())),
                WorkflowEdge::new("check", "skip", Some("false".into())),
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        assert_eq!(
            node_result(&results, "check").output["matched_branch"],
            json!("found")
        );
        assert_eq!(node_result(&results, "notify").status, NodeStatus::Success);
        assert_eq!(node_result(&results, "skip").status, NodeStatus::Skipped);
    }

    #[tokio::test]
    async fn condition_form_a_empty_array_template_is_falsy() {
        let def = WorkflowDefinition {
            nodes: vec![
                transform_node("src", json!({ "records": [] })),
                condition_node(
                    "check",
                    json!({
                        "conditions": [{
                            "branch": "found",
                            "expression": "{{src.records}}"
                        }],
                        "default_branch": "false"
                    }),
                ),
                transform_node("notify", json!("sent")),
                transform_node("skip", json!("skipped")),
            ],
            edges: vec![
                WorkflowEdge::new("src", "check", None),
                WorkflowEdge::new("check", "notify", Some("found".into())),
                WorkflowEdge::new("check", "skip", Some("false".into())),
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        assert_eq!(
            node_result(&results, "check").output["matched_branch"],
            json!("false")
        );
        assert_eq!(node_result(&results, "notify").status, NodeStatus::Skipped);
        assert_eq!(node_result(&results, "skip").status, NodeStatus::Success);
    }

    /// 形态 B：单模板解析成数组后仍应走 true/false 边，不能因 as_str 失败而报错。
    #[tokio::test]
    async fn condition_form_b_nonempty_array_template_matches() {
        let def = WorkflowDefinition {
            nodes: vec![
                transform_node("src", json!({ "records": [{ "open_id": "ou_1" }] })),
                condition_node("check", json!({ "expression": "{{src.records}}" })),
                transform_node("notify", json!("sent")),
                transform_node("skip", json!("skipped")),
            ],
            edges: vec![
                WorkflowEdge::new("src", "check", None),
                WorkflowEdge::new("check", "notify", Some("true".into())),
                WorkflowEdge::new("check", "skip", Some("false".into())),
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        assert_eq!(node_result(&results, "check").status, NodeStatus::Success);
        assert_eq!(
            node_result(&results, "check").output["matched_branch"],
            json!("true")
        );
        assert_eq!(node_result(&results, "notify").status, NodeStatus::Success);
        assert_eq!(node_result(&results, "skip").status, NodeStatus::Skipped);
    }

    #[tokio::test]
    async fn condition_form_a_number_and_bool_templates_are_truthy() {
        let def = WorkflowDefinition {
            nodes: vec![
                transform_node("src", json!({ "count": 5, "ok": true })),
                condition_node(
                    "check_count",
                    json!({
                        "conditions": [{ "branch": "yes", "expression": "{{src.count}}" }],
                        "default_branch": "no"
                    }),
                ),
                condition_node(
                    "check_ok",
                    json!({
                        "conditions": [{ "branch": "yes", "expression": "{{src.ok}}" }],
                        "default_branch": "no"
                    }),
                ),
                transform_node("after_count", json!("ok")),
                transform_node("after_ok", json!("ok")),
            ],
            edges: vec![
                WorkflowEdge::new("src", "check_count", None),
                WorkflowEdge::new("check_count", "after_count", Some("yes".into())),
                WorkflowEdge::new("after_count", "check_ok", None),
                WorkflowEdge::new("check_ok", "after_ok", Some("yes".into())),
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        assert_eq!(
            node_result(&results, "check_count").output["matched_branch"],
            json!("yes")
        );
        assert_eq!(
            node_result(&results, "check_ok").output["matched_branch"],
            json!("yes")
        );
        assert_eq!(
            node_result(&results, "after_ok").status,
            NodeStatus::Success
        );
    }

    #[tokio::test]
    async fn condition_form_a_comparison_expression_still_works() {
        let def = WorkflowDefinition {
            nodes: vec![
                transform_node("src", json!({ "count": 5 })),
                condition_node(
                    "check",
                    json!({
                        "conditions": [{
                            "branch": "found",
                            "expression": "{{src.count}} > 0"
                        }],
                        "default_branch": "false"
                    }),
                ),
                transform_node("notify", json!("sent")),
                transform_node("skip", json!("skipped")),
            ],
            edges: vec![
                WorkflowEdge::new("src", "check", None),
                WorkflowEdge::new("check", "notify", Some("found".into())),
                WorkflowEdge::new("check", "skip", Some("false".into())),
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        assert_eq!(
            node_result(&results, "check").output["matched_branch"],
            json!("found")
        );
        assert_eq!(node_result(&results, "notify").status, NodeStatus::Success);
    }

    #[tokio::test]
    async fn condition_diamond_keeps_shared_merge_node() {
        let condition = WorkflowNode {
            id: "c".into(),
            node_type: NodeType::Condition,
            label: None,
            config: json!({ "expression": "true" }),
        };
        let def = WorkflowDefinition {
            nodes: vec![
                condition,
                transform_node("yes", json!("yes")),
                transform_node("no", json!("no")),
                transform_node("merge", json!("merged")),
            ],
            edges: vec![
                WorkflowEdge::new("c", "yes", Some("true".into())),
                WorkflowEdge::new("c", "no", Some("false".into())),
                WorkflowEdge::new("yes", "merge", None),
                WorkflowEdge::new("no", "merge", None),
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        assert_eq!(
            results
                .iter()
                .find(|r| r.node_id == "merge")
                .unwrap()
                .status,
            NodeStatus::Success
        );
    }

    #[tokio::test]
    async fn loop_condition_diamond_executes_back_source() {
        let condition = WorkflowNode {
            id: "c".into(),
            node_type: NodeType::Condition,
            label: None,
            config: json!({ "expression": "true" }),
        };
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node("lp", json!({ "loop_mode": "count", "count": 1 })),
                condition,
                transform_node("yes", json!("yes")),
                transform_node("no", json!("no")),
                transform_node("merge", json!("merged")),
            ],
            edges: vec![
                body_branch("lp", "c"),
                WorkflowEdge::new("c", "yes", Some("true".into())),
                WorkflowEdge::new("c", "no", Some("false".into())),
                WorkflowEdge::new("yes", "merge", None),
                WorkflowEdge::new("no", "merge", None),
                WorkflowEdge::loop_back("merge", "lp"),
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let lp = results.iter().find(|r| r.node_id == "lp").unwrap();
        assert_eq!(lp.status, NodeStatus::Success);
        assert_eq!(lp.output["results"], json!(["merged"]));
    }

    #[tokio::test]
    async fn loop_runtime_count_hard_limit_cannot_be_bypassed_by_template() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node(
                    "lp",
                    json!({ "loop_mode": "count", "count": "{{trigger.count}}" }),
                ),
                transform_node("body", json!("body")),
            ],
            edges: vec![
                body_branch("lp", "body"),
                WorkflowEdge::loop_back("body", "lp"),
            ],
        };
        let mut ctx = exec_ctx();
        ctx.trigger_data = json!({ "count": HARD_LOOP_MAX_ITERATIONS + 1 });
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        assert_eq!(results[0].status, NodeStatus::Failed);
    }

    #[tokio::test]
    async fn loop_iteration_reports_are_bounded() {
        let def = WorkflowDefinition {
            nodes: vec![
                loop_node("lp", json!({ "loop_mode": "count", "count": 101 })),
                transform_node("body", json!("{{loop.index}}")),
            ],
            edges: vec![
                body_branch("lp", "body"),
                WorkflowEdge::loop_back("body", "lp"),
            ],
        };
        let mut ctx = exec_ctx();
        let results = lazy_engine().execute(&def, &mut ctx).await.unwrap();
        let output = &results[0].output;
        assert_eq!(output["iterations"], json!(101));
        assert_eq!(
            output["_iterations"].as_array().unwrap().len(),
            MAX_LOOP_ITERATION_REPORTS
        );
        assert_eq!(output["_iterations_truncated"], json!(true));
    }

    #[test]
    fn loop_scope_name_is_reserved() {
        let def = WorkflowDefinition {
            nodes: vec![transform_node("loop", json!("collision"))],
            edges: vec![],
        };
        assert!(validate_definition(&def).is_err());
    }

    #[tokio::test]
    async fn exec_http_call_runs_async_poll_when_enabled() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("[::1]:0").await.unwrap();
        let url = format!("http://[::1]:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            first.read(&mut request).await.unwrap();
            first
                .write_all(
                    b"HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: 54\r\nConnection: close\r\n\r\n{\"status\":\"pending\",\"job_id\":\"j1\",\"poll_after_secs\":1}",
                )
                .await
                .unwrap();

            let (mut second, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            second.read(&mut request).await.unwrap();
            second
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 34\r\nConnection: close\r\n\r\n{\"status\":\"completed\",\"result\":42}",
                )
                .await
                .unwrap();
        });

        let engine = DagEngine::new(
            sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/onebase")
                .unwrap(),
        );
        let (output, _) = engine
            .exec_http_call_node(&json!({
                "url": url,
                "async_poll": true,
                "poll_interval_secs": 1,
                "poll_max_secs": 5,
            }))
            .await
            .unwrap();

        assert_eq!(output["status"], 200);
        assert_eq!(output["body"]["result"], 42);
        assert_eq!(output["async_poll"]["enabled"], true);
        assert_eq!(output["async_poll"]["attempts"], 1);
    }
}
