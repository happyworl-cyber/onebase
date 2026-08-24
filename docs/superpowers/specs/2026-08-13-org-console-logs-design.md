# 租户控制台聚合日志

**状态：** 已实现  
**日期：** 2026-08-13

## 目标

在 `/org/[orgId]` 侧栏提供「操作日志」「执行日志」，聚合本租户下全部项目；权限为 org admin+ / 超管。

## API

- `GET /api/organizations/:id/operation-logs`（及 stats / detail / facets / actors / export）
- `GET /api/platform/executions` 增加可选 `organization_id`

数据范围：`tenant_id ∈ 该组织下属 tenants(projects)`。

## UI

侧栏两项；主区复用现有操作日志 / `ExecutionLogsView` 体验，操作日志多一列「项目」。
