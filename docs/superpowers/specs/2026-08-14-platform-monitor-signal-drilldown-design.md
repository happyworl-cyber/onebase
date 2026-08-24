# 平台监控：信号可下钻定位

**日期：** 2026-08-14  
**状态：** 已实现  
**范围：** `/platform/monitor` 总览信号 / 隐患 KPI → 页内明细或排查 Tab

## 背景

平台监控总览已能汇总「当前信号」与「隐患信号」（如 24h 异步失败、卡死执行、API Key 将过期），但只返回**计数**，缺少项目 / 资源维度，超管无法从总览一键定位问题落点。

「排查」Tab 已有「最近失败执行」列表（`recent-errors`），可复用；卡死执行与即将过期 Key 目前没有对应明细面。

## 目标

超管在总览上对关键信号**点一下**即可知道「哪个项目、哪条资源」，并在需要时落到已有排查列表；无需先猜再翻多个页面。

## 非目标

- 隐患区全部信号的完整下钻（限流 / 认证失败 / 卡死工作流 / 令牌过期 / Webhook 留待后续）
- 在总览内列出全部异步失败明细（例如 508 条）
- 跳转到工作区 `/workspace/.../security/api-keys` 做 Key 管理
- 在监控页内执行续期、取消执行、杀任务等写操作
- 改动告警规则引擎 / 阈值评估逻辑
- 变更 API Key 数据面鉴权语义

## 交互模式（C）

| 信号 | 行为 |
|------|------|
| 卡死执行 | 总览页内展开明细表 |
| Key 将过期 | 总览页内展开明细表 |
| 异步执行失败 | 切换到「排查」Tab（复用已有失败列表） |

「当前信号」文案行与「隐患」对应 KPI 共用同一套点击目标；再点收起，或点另一可展开信号则切换面板。

## API

扩展现有 `GET /api/admin/platform-monitor/overview`（仍仅超管），**不**新增独立 detail 路由。

在现有 `signals` 旁增加 `signal_samples`：

```json
{
  "signal_samples": {
    "stuck_running": {
      "total": 1,
      "items": [
        {
          "trace_id": "...",
          "source": "workflow",
          "name": "...",
          "tenant_id": 10,
          "project_name": "demo",
          "organization_id": 1,
          "organization_name": "Acme",
          "started_at": "...",
          "running_for_seconds": 720
        }
      ]
    },
    "expiring_api_keys": {
      "total": 1,
      "items": [
        {
          "id": 12,
          "name": "prod-ro",
          "key_prefix": "ob_abc",
          "tenant_id": 10,
          "project_name": "demo",
          "organization_id": 1,
          "organization_name": "Acme",
          "expires_at": "...",
          "days_left": 3
        }
      ]
    }
  }
}
```

### 查询口径

须与现有 `signals` 计数一致：

- **卡死执行：** `management.execution_index`，`status = 'running'` 且 `started_at < now() - interval '10 minutes'`；按 `started_at` 升序；`LIMIT 20`。`total` = 全量匹配数，`items` 最多 20。
- **Key 将过期：** `management.api_keys`，`COALESCE(is_active,false) = true`，`expires_at` 非空且落在 `(now(), now() + 7 days]`；按 `expires_at` 升序；`LIMIT 20`。只返回 `name` / `key_prefix`，不返回 hash 或明文。
- JOIN `management.tenants`（及 `organizations`）填充展示名；无组织时 `organization_*` 可为 `null`。

异步失败**不**附在 `signal_samples`；前端深链到排查 Tab。

样例查询失败时：该 bucket 可返回 `total` 与空 `items`，并在 overview 既有 `warnings` 中注明，不得拖垮整个 overview。

## 前端

文件：`frontend-nextjs/app/platform/monitor/page.tsx`（保持现有设计语言）。

1. 解析 `overview.signal_samples`；类型与 `EMPTY` 兜底。
2. 卡死 / Key 过期：信号行与 KPI 可点（`count > 0`）；展开面板展示表格。
3. 异步失败信号：切到 `diagnose`；支持 URL `?tab=diagnose`（刷新保持）。
4. 卡死行：展示项目名（及组织名若有）、source、name、开始时间、已跑时长、`trace_id`（可复制）。
5. Key 行：项目名、name、`key_prefix`、过期时间、剩余天数。
6. 当 `total > items.length` 时页脚提示「共 N 条，展示前 M」。
7. 不因展开而二次请求。

## 验收

1. 有卡死执行 / 将过期 Key 时，点击后能看到项目名（及组织名若有）与约定字段。
2. 点击异步失败信号进入排查 Tab，可见已有失败执行列表。
3. overview 仍一次加载；非超管仍 403。
4. 样例最多 20 条；`total` 可大于展示条数。
5. 密钥明文 / `key_hash` 不出现在响应或 UI。

## 后续（非 v1）

- 其余隐患 KPI 同样本 + 深链
- 异步失败 Top-N 按项目聚合
- 从明细跳工作区续期 / 打开执行详情页
