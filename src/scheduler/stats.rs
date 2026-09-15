//! 定时任务仪表盘统计口径。
//!
//! 项目页必须按 `tenant_id` 过滤；不过滤时，新建的空项目会显示全平台的
//! 「任务总数 / 启用中 / 24h 执行」。平台页（不传 tenant）仍看全局。

/// 统计覆盖范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatsScope {
    /// 平台仪表盘：所有任务，含 `tenant_id IS NULL` 的平台级任务。
    All,
    /// 项目仪表盘：仅该租户的任务（不含平台级）。
    Tenant(i32),
}

/// 四张卡片对应的 COUNT SQL。Tenant scope 的语句带 `$1` = tenant_id。
pub struct StatsSql {
    pub total: &'static str,
    pub active: &'static str,
    pub runs_24h: &'static str,
    pub failed_24h: &'static str,
}

/// 一条任务是否计入该 scope 的任务总数 / 启用中。
/// 生产路径走 `stats_sql`；本函数给单测钉口径，避免 SQL 和语义各写一套。
#[allow(dead_code)]
pub fn task_in_stats_scope(task_tenant_id: Option<i32>, scope: StatsScope) -> bool {
    match scope {
        StatsScope::All => true,
        StatsScope::Tenant(id) => task_tenant_id == Some(id),
    }
}

pub fn stats_sql(scope: StatsScope) -> StatsSql {
    match scope {
        StatsScope::All => StatsSql {
            total: "SELECT COUNT(*)::bigint FROM management.scheduled_tasks",
            active:
                "SELECT COUNT(*)::bigint FROM management.scheduled_tasks WHERE is_active = true",
            runs_24h: "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs \
                 WHERE started_at >= NOW() - INTERVAL '24 hours'",
            failed_24h:
                "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs \
                 WHERE started_at >= NOW() - INTERVAL '24 hours' AND status IN ('failed','timeout')",
        },
        StatsScope::Tenant(_) => StatsSql {
            total: "SELECT COUNT(*)::bigint FROM management.scheduled_tasks WHERE tenant_id = $1",
            active: "SELECT COUNT(*)::bigint FROM management.scheduled_tasks \
                 WHERE is_active = true AND tenant_id = $1",
            runs_24h: "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs r \
                 INNER JOIN management.scheduled_tasks t ON t.id = r.task_id \
                 WHERE r.started_at >= NOW() - INTERVAL '24 hours' AND t.tenant_id = $1",
            failed_24h: "SELECT COUNT(*)::bigint FROM management.scheduled_task_runs r \
                 INNER JOIN management.scheduled_tasks t ON t.id = r.task_id \
                 WHERE r.started_at >= NOW() - INTERVAL '24 hours' \
                   AND t.tenant_id = $1 AND r.status IN ('failed','timeout')",
        },
    }
}

pub fn stats_bind_tenant(scope: StatsScope) -> Option<i32> {
    match scope {
        StatsScope::All => None,
        StatsScope::Tenant(id) => Some(id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_project_does_not_count_other_tenants_or_platform_tasks() {
        let empty = StatsScope::Tenant(99);
        assert!(!task_in_stats_scope(Some(1), empty));
        assert!(!task_in_stats_scope(None, empty));
        assert!(task_in_stats_scope(Some(99), empty));
    }

    #[test]
    fn platform_scope_counts_every_task() {
        let all = StatsScope::All;
        assert!(task_in_stats_scope(Some(1), all));
        assert!(task_in_stats_scope(None, all));
    }

    #[test]
    fn tenant_sql_binds_and_filters_by_tenant_id() {
        let sql = stats_sql(StatsScope::Tenant(7));
        assert_eq!(stats_bind_tenant(StatsScope::Tenant(7)), Some(7));
        for q in [sql.total, sql.active, sql.runs_24h, sql.failed_24h] {
            assert!(
                q.contains("tenant_id = $1"),
                "tenant-scoped stats must filter tenant_id: {q}"
            );
        }
        assert!(sql.runs_24h.contains("scheduled_tasks"));
        assert!(sql.failed_24h.contains("scheduled_tasks"));
    }

    #[test]
    fn platform_sql_has_no_tenant_bind() {
        let sql = stats_sql(StatsScope::All);
        assert_eq!(stats_bind_tenant(StatsScope::All), None);
        assert!(
            !sql.total.contains("tenant_id"),
            "unscoped total must count the whole table: {}",
            sql.total
        );
    }
}
