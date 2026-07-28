//! 集成测试：验证两个 `SchedulerRunner` 不会重复 claim 同一个任务。
//!
//! 运行前提：环境变量 `DATABASE_URL_TEST` 指向一个已跑过 014 迁移的 PG 实例。
//! 没设这个变量时测试自动 skip（打印 skip 提示后 return），**不 fail**——
//! 这样 CI 在没有专用测试库时也能干净跑过 `cargo test --test scheduler_runner_integration`。
//!
//! 期望：
//! - 两个 runner 同时启动并 tick，由于 `FOR UPDATE SKIP LOCKED`，
//!   单个 due 任务只会被其中一个 runner claim，最终 `scheduled_task_runs` 只有 1 行。
//! - HTTP 调用本身会失败（example.test 不存在），无所谓——我们只验证 claim 去重。

use onebase::scheduler::executors::{HttpExecutor, RpcExecutor};
use onebase::scheduler::runner::{SchedulerConfig, SchedulerRunner};
use sqlx::PgPool;
use std::sync::Arc;

async fn setup_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL_TEST").ok()?;
    // 设了 env 但连不上是配置错误，要响亮地失败——否则 CI 会把"测试库挂了"当成"测试通过"。
    Some(
        PgPool::connect(&url)
            .await
            .expect("DATABASE_URL_TEST 已设置但连接失败"),
    )
}

async fn seed_due_task(pool: &PgPool) -> i64 {
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO management.scheduled_tasks \
            (name, cron_expr, timezone, kind, http_method, http_url, \
             is_active, next_run_at, created_by) \
         VALUES ('it', '* * * * *', 'UTC', 'http', 'GET', 'https://example.test/', \
                  true, NOW() - INTERVAL '1 second', 1) \
         RETURNING id",
    )
    .fetch_one(pool)
    .await
    .expect("insert");
    row.0
}

#[tokio::test]
async fn two_runners_do_not_double_claim() {
    let Some(pool) = setup_pool().await else {
        eprintln!("DATABASE_URL_TEST 未设置，skip scheduler_runner_integration");
        return;
    };

    sqlx::query("DELETE FROM management.scheduled_task_runs")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("DELETE FROM management.scheduled_tasks")
        .execute(&pool)
        .await
        .ok();
    let _task_id = seed_due_task(&pool).await;

    let rpc = Arc::new(RpcExecutor::new(pool.clone(), None));
    let http = Arc::new(HttpExecutor::new(true));

    let r1 = Arc::new(SchedulerRunner::new(
        pool.clone(),
        SchedulerConfig::default(),
        rpc.clone(),
        http.clone(),
    ));
    let r2 = Arc::new(SchedulerRunner::new(
        pool.clone(),
        SchedulerConfig::default(),
        rpc,
        http,
    ));

    // tick 是 private，通过 start() 启循环 + 短暂 sleep 观察。
    let h1 = r1.clone().start();
    let h2 = r2.clone().start();

    tokio::time::sleep(std::time::Duration::from_secs(8)).await;

    h1.abort();
    h2.abort();

    let runs: (i64,) =
        sqlx::query_as("SELECT COUNT(*)::bigint FROM management.scheduled_task_runs")
            .fetch_one(&pool)
            .await
            .expect("count");

    // HTTP 调用会失败（example.test 不存在），但 run 记录 = 1 行，
    // 说明只有一个 runner 抢到了 claim。
    assert_eq!(
        runs.0, 1,
        "两个 runner 同时跑应只产生一条 run 记录（当前 {}）",
        runs.0
    );
}
