use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// 租户信息
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Tenant {
    pub id: i32,
    pub name: String,
    pub slug: String,
    pub status: String,
    pub contact_email: Option<String>,
}

/// 租户数据库连接配置
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TenantDatabase {
    pub id: i32,
    pub tenant_id: i32,
    pub connection_name: String,
    pub slug: Option<String>,
    pub db_host: String,
    pub db_port: i32,
    pub db_name: String,
    pub db_user: String,
    pub db_password_encrypted: String,
    pub is_primary: bool,
    pub is_active: bool,
    pub max_connections: Option<i32>,
    pub connection_timeout: Option<i32>,
}

/// 租户业务 Schema
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TenantSchema {
    pub id: i32,
    pub tenant_id: i32,
    pub database_id: i32,
    pub schema_name: String,
    pub business_type: String,
    pub display_name: String,
    pub description: Option<String>,
    pub is_active: bool,
}

/// 用户可访问的连接信息
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserConnection {
    pub user_id: i32,
    pub username: String,
    pub tenant_id: i32,
    pub tenant_name: String,
    pub database_id: i32,
    pub database_slug: Option<String>,
    pub connection_name: String,
    pub db_host: String,
    pub db_port: i32,
    pub db_name: String,
    pub is_primary: bool,
    pub user_role: String,
    #[serde(default)]
    #[sqlx(default)]
    pub max_connections: Option<i32>,
    #[serde(default)]
    #[sqlx(default)]
    pub connection_timeout: Option<i32>,
}

/// 测试连接请求
#[derive(Debug, Deserialize)]
pub struct TestConnectionRequest {
    pub host: String,
    pub port: i32,
    pub database: String,
    pub username: String,
    pub password: String,
}

/// 测试连接响应
#[derive(Debug, Serialize)]
pub struct TestConnectionResponse {
    pub success: bool,
    pub message: String,
    pub server_version: Option<String>,
}

/// 创建租户数据库连接请求
#[derive(Debug, Deserialize)]
pub struct CreateDatabaseConnectionRequest {
    pub tenant_id: i32,
    pub connection_name: String,
    pub slug: Option<String>,
    pub db_host: String,
    pub db_port: i32,
    pub db_name: String,
    pub db_user: String,
    pub db_password: String,
    pub is_primary: bool,
    pub max_connections: Option<i32>,
    pub connection_timeout: Option<i32>,
}

/// 更新租户数据库连接请求
///
/// 除名称 / slug / 连接池参数外，也允许项目 owner/admin 改实际连接目标
/// （host / port / db / user / password）。所有字段 `Option`，缺省即不改；
/// `db_password` 传空串同样视为"不修改密码"（与超管侧 `update_tenant` 一致）。
#[derive(Debug, Deserialize)]
pub struct UpdateDatabaseConnectionRequest {
    pub connection_name: Option<String>,
    pub slug: Option<String>,
    pub db_host: Option<String>,
    pub db_port: Option<i32>,
    pub db_name: Option<String>,
    pub db_user: Option<String>,
    pub db_password: Option<String>,
    pub max_connections: Option<i32>,
    pub connection_timeout: Option<i32>,
}

/// 切换连接请求
#[derive(Debug, Deserialize)]
pub struct SwitchConnectionRequest {
    pub database_id: i32,
}

/// 调整连接顺序请求：按 `ordered_ids` 顺序写回 sort_order。
#[derive(Debug, Deserialize)]
pub struct ReorderConnectionsRequest {
    pub tenant_id: i32,
    pub ordered_ids: Vec<i32>,
}

/// 切换连接响应
#[derive(Debug, Serialize)]
pub struct SwitchConnectionResponse {
    pub success: bool,
    pub database_id: i32,
    pub connection_name: String,
    pub message: String,
}
