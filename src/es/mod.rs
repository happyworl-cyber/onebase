//! Elasticsearch 反向代理模块
//!
//! 业务端连"平台代理 URL"而不是 ES 直连：
//!   - `/api/admin/es-connections/*`     管理 ES 集群连接配置（含加密的 ApiKey）
//!   - `/api/admin/es-connections/:id/tokens/*`  管理代理 token（业务端持有的凭据）
//!   - `/api/es/*es_path` 或 `/api/v1/:database_slug/es/*`  业务侧透传代理
//!   - `/api/es-app/*` 或 `/api/v1/:database_slug/es-app/*`  高层应用 API
//!
//! 子模块分工：
//!   - `models`           PG 行映射（EsConnection / EsAccessToken）
//!   - `auth`             token 生成 / hash / 解析 + method/index/path 三层访问控制
//!   - `admin_handlers`   CRUD（连接 + token）+ /:id/health
//!   - `proxy_common`     token → connection 解析 / reqwest client / 上游 URL / usage 统计
//!   - `proxy_handler`    `/api/es/*es_path` 流式透传，头部白名单，status 透传
//!   - `app_handlers`     `/api/es-app/*` 高层 HTTP API（业务无需写 ES DSL / 引 SDK）

pub mod admin_handlers;
pub mod app_handlers;
pub mod auth;
pub mod models;
pub mod proxy_common;
pub mod proxy_handler;
