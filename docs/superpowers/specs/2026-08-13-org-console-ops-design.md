# 租户控制台：统计 / 监控 / 审计

**状态：** 已实现  
**日期：** 2026-08-13

## 侧栏（org admin+）

统计 · 监控 · 审计 · 操作日志 · 执行日志（后两项已有）

## API

- `GET /api/organizations/:id/stats`
- `organization_id` 过滤：`/api/admin/audit-logs`、`/api/admin/slow-queries`、`/api/platform/raw-sql-audit`（可收敛部分）
