use sqlx::postgres::PgPoolOptions;
use sqlx::Row;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    let database_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/onebase".to_string());

    println!("🔗 连接数据库: {}", database_url);

    // 创建数据库连接池
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    // 管理员信息
    let username = "admin";
    let email = "admin@example.com";
    let password = "Admin123";

    // 使用 bcrypt 哈希密码（cost=12）
    let password_hash = bcrypt::hash(password, 12)?;

    println!("👤 创建管理员账户:");
    println!("   邮箱: {}", email);
    println!("   密码: {}", password);

    // 检查用户是否已存在
    let existing = sqlx::query("SELECT id FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(&pool)
        .await?;

    if let Some(row) = existing {
        let user_id: i32 = row.try_get("id")?;
        println!("⚠️  用户已存在，更新密码和权限...");

        // 把密码重置回默认值的同时，重新打上“需强制改密”标记并清空 password_changed_at，
        // 使得下次用默认密码登录后必须先改密（与容器每次启动重置默认密码的行为一致）。
        // must_change_password / password_changed_at 列可能在旧库上尚未创建，失败则降级为不带这两列的更新。
        let updated = sqlx::query(
            "UPDATE users SET password_hash = $1, is_superadmin = true, role = 'admin', username = $2, must_change_password = true, password_changed_at = NULL WHERE email = $3",
        )
        .bind(&password_hash)
        .bind(username)
        .bind(email)
        .execute(&pool)
        .await;
        if updated.is_err() {
            sqlx::query("UPDATE users SET password_hash = $1, is_superadmin = true, role = 'admin', username = $2 WHERE email = $3")
                .bind(&password_hash)
                .bind(username)
                .bind(email)
                .execute(&pool)
                .await?;
        }

        println!("✅ 用户已更新 (ID: {})", user_id);
    } else {
        println!("📝 创建新用户...");

        // 新建默认管理员时即标记为需强制改密。同样对旧库缺列做降级兜底。
        let inserted = sqlx::query("INSERT INTO users (username, email, password_hash, role, is_superadmin, must_change_password) VALUES ($1, $2, $3, 'admin', true, true) RETURNING id")
            .bind(username)
            .bind(email)
            .bind(&password_hash)
            .fetch_optional(&pool)
            .await;
        let row = match inserted {
            Ok(Some(r)) => r,
            _ => sqlx::query("INSERT INTO users (username, email, password_hash, role, is_superadmin) VALUES ($1, $2, $3, 'admin', true) RETURNING id")
                .bind(username)
                .bind(email)
                .bind(&password_hash)
                .fetch_one(&pool)
                .await?,
        };

        let user_id: i32 = row.try_get("id")?;
        println!("✅ 用户已创建 (ID: {})", user_id);
    }

    println!("\n🎉 超级管理员账户已就绪！");
    println!("   邮箱: {}", email);
    println!("   密码: {}", password);

    Ok(())
}
