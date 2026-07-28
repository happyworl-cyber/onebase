//! Handler 鉴权矩阵占位测试。
//!
//! `scheduler_handlers::validate_can_manage` 是 module-private 函数，且 handler 又
//! 依赖 axum 的 State/Extension 注入与活的 PG 连接，单测桩出来成本不划算（会等价于
//! 复制 handler 内部逻辑）。完整鉴权矩阵覆盖留给 e2e/HTTP-level 测试在联调环境跑。
//!
//! 本文件保留为已编译的 placeholder：
//! - 给 phase 3 的 commit 留下"此处计划过 handler authz 测试"的痕迹
//! - 保证 `cargo test --test scheduler_handlers_authz` 始终能命中、不缺路径
//! - 等 e2e fixture 落地后在这里追加 `oneshot::ServiceExt` 的真实 HTTP 测试

use onebase::auth::Claims;

#[test]
fn claims_struct_is_constructible() {
    let claims = Claims {
        sub: 1,
        email: "admin@example.com".into(),
        role: "super_admin".into(),
        is_superadmin: true,
        jti: String::new(),
        exp: chrono::Utc::now().timestamp() + 3600,
        iat: chrono::Utc::now().timestamp(),
    };
    assert!(claims.is_superadmin);
    assert_eq!(claims.sub, 1);
}
