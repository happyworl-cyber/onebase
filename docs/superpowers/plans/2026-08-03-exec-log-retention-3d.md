# 执行日志保留 3 天 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 仓库文档标明生产建议将执行索引与权威 run 表保留 3 天；生产通过 env + SQL 生效（无代码默认值变更）。

**Architecture:** 保留策略已由 `execution_log::spawn_cleanup_task` 读取 env。本次只更新 `.env.example` 注释与规格状态；生产运维步骤见 design spec。

**Tech Stack:** 环境变量、Postgres SQL（运维侧）

## Global Constraints

- 不改 `EXEC_*` 代码默认值（仍为 index/runs=7、logs=24h）。
- 不清理 `audit_logs` / `slow_query_logs`。
- 生产 SQL 只对管理库 `management.*` 执行。

---

### Task 1: 更新 `.env.example` 注释

**Files:**
- Modify: `.env.example`（执行日志保留段落，约 L112–123）
- Modify: `docs/superpowers/specs/2026-08-03-exec-log-retention-3d-design.md`（状态 → 已确认）

**Interfaces:**
- Consumes: 现有 `EXEC_INDEX_RETENTION_DAYS` / `EXEC_RUNS_RETENTION_DAYS` 变量名
- Produces: 注释中写明生产建议 `3`

- [x] **Step 1:** 在 `.env.example` 的索引/run 保留注释中增加「生产建议 3 天」说明；示例值可改为注释态的 `3` 或保留 `7` 并加建议句。推荐：默认示例仍写 `7`（与代码默认一致），另起一行注明生产建议 `EXEC_INDEX_RETENTION_DAYS=3` 与 `EXEC_RUNS_RETENTION_DAYS=3`。
- [x] **Step 2:** 将 design spec 状态改为「已确认 / 运维执行」。
- [x] **Step 3:** 目视确认无其它文件需改；不 commit（除非用户要求）。

---

### Task 2: 生产运维（人工，仓库外）

**Files:** 无

- [ ] **Step 1:** 生产 onebase 设置 `EXEC_INDEX_RETENTION_DAYS=3`、`EXEC_RUNS_RETENTION_DAYS=3` 并重启。
- [ ] **Step 2:** 在管理库按 design spec 执行预览 + 分批 DELETE。
- [ ] **Step 3:** 确认启动日志 `index_retention_days=3`、`runs_retention_days=3`；执行日志页无 3 天前数据。
