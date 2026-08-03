# 平台监控增强 — 设计文档

- 日期：2026-07-16
- 状态：已确认（实现按 P1→P2→P3 分期）
- 相关代码：`frontend-nextjs/app/platform/monitor/page.tsx`、`src/platform_monitor_handlers.rs`、`src/alert_webhook.rs`、`migrations/050_platform_monitor.sql`

## 1. 目标

把 `/platform/monitor` 从「熔断 + 慢查询」扩展为平台运维总览，尽早发现：

1. 运行时健康问题（管理库 / Redis / 连接池 / 熔断 / 限流降级）
2. 流量与错误面问题（跨租户 QPS、P95、错误率、慢查询）
3. 异步与后台问题（execution / scheduler / SSE）

并提供历史趋势（PG 采样）与平台级阈值 Webhook 告警。

## 2. 范围

**做：**

- Tab UI：总览 | 流量 | 异步 | 告警
- `GET /api/admin/platform-monitor/overview` 聚合实时指标
- `management.platform_metric_samples` + 分钟采样 + timeseries API
- 平台告警配置 / 规则 / 事件 + 采样后评估

**不做：**

- 项目级 `pg_stat_*`（仍在工作空间 `/monitor`）
- OS CPU/磁盘/网络主机监控
- 外部 Prometheus、多 Webhook、升级策略、异常检测

## 3. UI（布局 B）

| Tab | 内容 |
|-----|------|
| 总览 | 健康条、KPI、**隐患信号网格**、24h sparkline、按严重度着色的信号清单 |
| 流量 | 趋势图、**Top 接口（1h，按 5xx/P95/调用量排序）**、慢查询表、限流状态、熔断列表 |
| 异步 | 执行 source×status、定时任务、SSE、连接池 |
| 排查 | **最近失败执行（带 trace_id）、最近 5xx 请求、按租户分解** |
| 告警 | Webhook 配置、规则 CRUD、最近发送记录 |

鉴权：平台超管；`/platform` layout 已有客户端兜底。

### 3.1 预警信号（overview.signals，早发现隐患）

一次 SQL 拉齐：近 1h 限流命中 / 认证失败(401,403)、卡死执行(running>10min)、卡死工作流、
7 天内将过期的 API Key / 平台令牌、24h Webhook 投递失败。按阈值冒泡进异常清单（critical/warning/info）。

### 3.2 根因排查端点（问题发生时快速定位）

- `GET .../top-endpoints?window=1h&order=errors|latency|calls`：按路径聚合调用/5xx/4xx/P95/均值
- `GET .../recent-errors?limit=`：最近失败 execution_index（含 trace_id）+ 最近 5xx audit
- `GET .../tenant-breakdown?range=24h`：按租户 calls/5xx/错误率/P95/慢查询，判断全局 vs 单租户

## 4. API

均需 `require_platform_superadmin`（路由挂 `require_superadmin_middleware` + handler 兜底）。

| 方法 | 路径 | 期次 |
|------|------|------|
| GET | `/api/admin/platform-monitor/overview` | P1 |
| GET | `/api/admin/platform-monitor/timeseries?range=24h\|7d` | P2 |
| GET/PUT | `/api/admin/platform-monitor/alert-config` | P3 |
| GET/POST/PATCH/DELETE | `/api/admin/platform-monitor/alert-rules[/:id]` | P3 |
| GET | `/api/admin/platform-monitor/alert-events` | P3 |

已有明细继续用：`/api/admin/slow-queries`、`/api/admin/circuit-breakers`。

`overview` 子源失败时字段置 `null` 并附 `warnings[]`，不整页 500。

## 5. 采样（P2）

表 `management.platform_metric_samples`：每分钟一行。后台 task 用 PG advisory lock 防多实例重复写。保留原始样本 7 天（清理同 task）。

字段覆盖：流量（qps/p95/error/calls/slow）、运行时（db/redis/pool/circuit/rate_limit）、异步（exec_failed/scheduler_failed/sse_connections）。

## 6. 告警（P3）

- `platform_alert_config`：单行 Webhook URL/模板/总开关/默认限流小时
- `platform_alert_rules`：metric + operator + threshold + `metric_window`（勿用 PG 保留字 `window`）+ enabled + throttle
- `platform_alert_events`：发送记录
- 评估与采样同周期；复用 `alert_webhook::render_template` 与短超时 POST
- 与工作流/定时任务对象级失败告警互补，配置表独立

默认规则（可改）：`error_rate_24h>0.05`、`circuit_open_count>=1`、`rate_limit_degraded>=1`、`slow_queries_5min>20`、`exec_failed_24h>50`、`mgmt_db_ok==0`、`redis_ok==0`。

## 7. 交付顺序

1. P1：overview + Tab UI（告警 Tab 可先接 API，无规则时空态）
2. P2：采样 + timeseries + 趋势
3. P3：评估器写入事件并真正发 Webhook（与表/API 可同 PR 落地）
