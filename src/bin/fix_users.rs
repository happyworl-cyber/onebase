use sqlx::PgPool;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    let database_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set in .env file");

    println!("🔌 连接到数据库...");
    let pool = PgPool::connect(&database_url).await?;
    println!("✅ 数据库连接成功");

    println!("🗑️  删除旧的 users 表...");
    sqlx::query("DROP TABLE IF EXISTS users CASCADE")
        .execute(&pool)
        .await?;
    println!("✅ 旧表已删除");

    println!("📝 创建新的 users 表...");
    sqlx::query(
        r#"
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(50) NOT NULL DEFAULT 'user',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    "#,
    )
    .execute(&pool)
    .await?;
    println!("✅ users 表已创建");

    println!("📊 创建索引...");
    sqlx::query("CREATE INDEX idx_users_email ON users(email)")
        .execute(&pool)
        .await?;
    sqlx::query("CREATE INDEX idx_users_username ON users(username)")
        .execute(&pool)
        .await?;
    sqlx::query("CREATE INDEX idx_users_role ON users(role)")
        .execute(&pool)
        .await?;
    println!("✅ 索引已创建");

    println!("⚡ 创建触发器函数...");
    sqlx::query(
        r#"
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = CURRENT_TIMESTAMP;
            RETURN NEW;
        END;
        $$ language 'plpgsql'
    "#,
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    "#,
    )
    .execute(&pool)
    .await?;
    println!("✅ 触发器已创建");

    println!("👤 插入默认用户...");
    sqlx::query(r#"
        INSERT INTO users (username, email, password_hash, role)
        VALUES 
            ('admin', 'admin@example.com', '$2b$12$lWU6Xl/ZBMTwceFjCLGxwOAO4NAN4We9wA8c61z25G5jxNhzOIpSS', 'admin'),
            ('testuser', 'test@example.com', '$2b$12$KLspJRkworxQAa2ruPeNBeispBG0nRIZRMKOE0oFoFiiGXvpK5xG.', 'user')
    "#)
    .execute(&pool)
    .await?;
    println!("✅ 默认用户已创建");
    println!("\n🎉 users 表修复完成！");
    println!("\n登录信息:");
    println!("  管理员: admin@example.com / Admin123");
    println!("  测试用户: test@example.com / User1234");

    Ok(())
}
