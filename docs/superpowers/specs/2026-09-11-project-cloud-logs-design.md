# 项目云日志（阿里云 SLS）— 设计文档

- 日期：2026-09-11
- 状态：已通过
- 范围：按项目配置多条云日志源，用项目凭证里的阿里云 AccessKey 由后端代查 SLS；站内查看日志，并生成控制台深链。第一期只做 `aliyun_sls`。
- 相关代码：
  - `migrations/064_wf_credentials_api_key.sql`
  - `src/workflow_credentials.rs`
  - `src/datasource_handlers.rs`
  - `src/execution_log_handlers.rs`
  - `frontend-nextjs/components/ExecutionLogsView.tsx`
  - `frontend-nextjs/app/workspace/[projectId]/logs/page.tsx`
  - `frontend-nextjs/app/workspace/[projectId]/settings/credentials/page.tsx`
  - `frontend-nextjs/components/workspace/workspaceNav.ts`
- 关联：代码节点日志已写入 stdout JSON，字段 `x_request_id` 与 `workflow_runs.trace_id` 相同，供 SLS 检索。

## 1. 目标与非目标

OneBase 项目内的「执行日志」来自库表；生产日志在各云（目前主要是阿里云 SLS）。排障要把同一次请求的 `x_request_id` / `trace_id` 在两边对上。密钥不能进浏览器。

**目标**

1. 项目可配多条日志源（如 Access / 业务 / 工作流），共用一份阿里云凭证。
2. AccessKey 只存在「设置 → 凭证管理」，类型 `aliyun_ak`，密文不回显。
3. 站内按时间、关键字、`x_request_id` 查看 SLS 日志行。
4. 同条件生成阿里云 SLS 控制台链接，新标签打开。
5. 执行日志详情可带着 `trace_id` 跳进云日志页。

### 已确认需求

| 项 | 结论 |
|---|---|
| 查看方式 | 站内查询 + 控制台深链 |
| 源数量 | 每项目多条 |
| 密钥 | 项目一份云账号凭证，多源只引用 `credential_id` |
| 凭证存放 | 现有 `wf_credentials`，不另建密钥表 |
| 权限 | 管理员配凭证和日志源；查 SLS / 跳控制台与「执行日志」同档（`canManageSecurity`，即项目 admin+ / 超管） |

### 非目标

- 写入或删除 SLS 日志
- 图表大盘、告警（网关页已有 SLS 聚合进 PG 的展示，本期不改）
- 华为云 / 腾讯云的实际实现（只留 `provider` 接口）
- 实时 tail / SSE 推日志
- 工作流节点用 `aliyun_ak` 发 HTTP 或 `{{cred.}}` / `cred.get`
- 把 AccessKey 交给前端直连 SLS

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 架构 | 后端代查；浏览器只拿日志行和控制台 URL | 密钥不离开服务端 |
| 凭证类型 | `aliyun_ak`：`username`=AccessKeyId，`secret`=AccessKeySecret | 与 basic 列复用，下拉能区分用途 |
| 工作流装载 | `load_credential_store` **排除** `aliyun_ak` | 即使模板不解析，也不把 SK 装进执行上下文 |
| HTTP / 数据源 | `apply_http_auth_headers` 与 `datasource_accepts_kind` 都不接受 `aliyun_ak` | 避免当普通登录头用 |
| 日志源表 | 新表 `management.project_log_sources` | 多源 CRUD，不塞 `workspace_config` |
| 检索字段 | 固定拼 `x_request_id: "..."` | 与 OneBase stdout JSON 字段一致 |
| 时间窗 | 默认最近 1 小时；单次最长 24 小时 | 控 SLS 费用与超时 |
| 行数 | 默认 50，上限 100，最新在前 | 与执行日志列表量级接近 |
| Provider | trait + `aliyun_sls` 一档实现 | 以后加云不用改表结构 |

## 3. 数据模型

### 3.1 凭证 `aliyun_ak`

沿用 `management.wf_credentials`。新迁移把 `kind` 检查扩成 `basic | bearer | api_key | aliyun_ak`。不加列。

| 项 | 规则 |
|---|---|
| 创建 | AccessKeyId（`username`）与 AccessKeySecret（`secret`）均必填非空 |
| 更新 | `secret` 缺省或空字符串 = 不改密文；改 Id 不影响密文 |
| 回显 | 列表 / 详情只回 `username`（AccessKeyId）与 `has_secret`，永不回 Secret |
| 模板字段 | **不注册**。`field_value("aliyun_ak", _)` 恒为 `None` |
| 删除 | 仍被本项目数据源 **或** 日志源引用则 400 |

`ref_count` = `wf_datasources` 引用数 + `project_log_sources` 引用数。删除提示写明哪边还在用。

### 3.2 表 `management.project_log_sources`

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | serial PK | |
| `tenant_id` | int | 项目，非空 |
| `name` | varchar(100) | 非空；`(tenant_id, name)` 唯一 |
| `provider` | varchar(32) | 非空；检查 `aliyun_sls` |
| `credential_id` | int | FK → `wf_credentials(id)`，`ON DELETE RESTRICT`；必须同 `tenant_id` |
| `region` | varchar(64) | 非空，如 `cn-hangzhou` |
| `sls_project` | varchar(128) | 非空 |
| `logstore` | varchar(128) | 非空 |
| `endpoint` | varchar(256) | 可空；空则 `https://{sls_project}.{region}.log.aliyuncs.com` |
| `query_prefix` | text | 可空；每次查询 AND 进去 |
| `created_by` | int | 可空 |
| `created_at` / `updated_at` | timestamptz | 默认 now |

`credential_id` 指向的行必须是本项目的 `kind = aliyun_ak`。绑成其它 kind 返回 400。

名称规则与凭证相同：trim 后非空、最长 100、项目内唯一。

## 4. 查询语义

服务端拼 SLS 查询串（顺序固定，空段丢掉）：

1. `query_prefix`（trim 后非空）
2. 用户 `query`（trim 后非空；原样当作 SLS 片段，不自动加引号）
3. 若有 `x_request_id`：`x_request_id: "{id}"`。`id` 只允许与 `looks_like_request_id` 相同的字符集（ASCII 字母数字、`-`、`_`，长度 8–128），否则 400。

全部为空则查询 `*`。

多段用 ` and ` 连接。

时间：`from` / `to` 为 Unix 秒。缺省 `to = now`、`from = to - 3600`。`from >= to` 或 `to - from > 86400` 则 400。

`line` 默认 50、夹在 1–100。`offset` 默认 0。`reverse = true`。

**响应**（无密钥）：

```json
{
  "logs": [
    {
      "time": 1726032000,
      "contents": {
        "message": "...",
        "x_request_id": "...",
        "level": "INFO"
      }
    }
  ],
  "count": 1,
  "console_url": "https://sls.console.aliyun.com/lognext/project/.../logsearch/..."
}
```

`contents` 是 SLS 返回的字段映射；不做二次脱敏（SLS 里已是采集后的内容，代码节点路径已在写入 stdout 前脱敏）。单行超大字段原样返回，依赖 SLS 侧截断与 `line` 上限。

超时：请求 SLS 10 秒。401/403 → 400，文案「凭证无效或没有该 Logstore 的读权限」。其它 SLS / 网络错误 → 502，带简短原因，不含 AccessKey。

## 5. 控制台深链

后端生成，不经过阿里云 OAuth。格式固定为：

```
https://sls.console.aliyun.com/lognext/project/{sls_project}/logsearch/{logstore}
  ?slsRegion={region}
  &queryTimeType=99
  &startTime={from}
  &endTime={to}
  &queryString={urlencode(与代查相同的查询串)}
```

`sls_project` / `logstore` / `region` 做 URL path/query 编码。新标签打开。若阿里云控制台日后改参，只改这一处拼装函数。

## 6. API

路径均挂在 `/api/projects/:id/...`。`:id` 即 `tenant_id`。

| 方法 | 路径 | 权限 | 行为 |
|---|---|---|---|
| `GET` | `/log-sources` | 与执行日志相同（项目 admin+ / 超管） | 列表，无密钥；含 `credential_id`、`credential_name` |
| `POST` | `/log-sources` | `require_tenant_admin` | 新建 |
| `PUT` | `/log-sources/:sid` | 同上写 | 更新；不换密钥（密钥在凭证上改） |
| `DELETE` | `/log-sources/:sid` | 同上写 | 删除该源 |
| `POST` | `/log-sources/:sid/query` | 与 GET 列表相同 | 代查；body 见下 |
| `GET` | `/log-sources/:sid/console-url` | 同上 | querystring：`from` `to` `query` `x_request_id`；只返回 `{ "console_url": "..." }` |
| `POST` | `/log-sources/:sid/test` | 写权限 | 最近 60 秒、`line=1`、查询 `*`（仍 AND `query_prefix`） |

`POST .../query` body：

```json
{
  "from": 1726028400,
  "to": 1726032000,
  "query": "error",
  "x_request_id": "98753d7e-3bdb-4c00-bcf7-4a697606b88b",
  "line": 50,
  "offset": 0
}
```

写日志源记操作日志（名称、provider、id，不含密钥），对齐凭证审计。

凭证 CRUD 仍走现有 `/api/projects/:id/credentials`；只扩 `kind`。

## 7. 后端结构

- `src/cloud_log.rs`：`CloudLogProvider` trait（`query` + `console_url`）、查询串拼装、时间窗校验。
- `src/cloud_log_aliyun.rs`：SLS GetLogs 签名与 HTTP；仅此文件依赖阿里云协议。
- `src/cloud_log_handlers.rs`：路由、鉴权、读表、解密凭证、调 provider。
- 迁移序号：当时仓库最大编号 +1。

解密只在 handler 内按 `credential_id` 取一行，用现有 `decrypt_secret_lossy` / 等价函数。不把 `aliyun_ak` 放进工作流 `CredentialStore`。

## 8. 前端

**设置 → 云日志源**（`/workspace/[projectId]/settings/log-sources`）

- 导航：设置组，紧挨「凭证管理」，`visibleIf: canManageSecurity`（能配才能进；不向普通成员展示源列表）。
- 列表 + 表单：名称、凭证下拉（仅 `aliyun_ak`）、地域、SLS Project、Logstore、可选 endpoint、可选查询前缀。
- 「测试连接」。未建 `aliyun_ak` 时引导去凭证页。

**诊断与监控 → 云日志**（`/workspace/[projectId]/cloud-logs`）

- 导航：紧挨「执行日志」，`visibleIf: canManageSecurity`。
- 选日志源、时间、关键字、`x_request_id`；表格展示 `time` + 主要字段（至少 `message` / `level` / `x_request_id`，其余可折行）。
- 「在阿里云打开」用接口返回的 `console_url`。
- 无日志源：空态链到设置页。
- 支持 URL：`?source_id=&trace_id=&from=&to=`，供执行日志跳转。

**执行日志详情**

- 按钮「云日志」。一条源：跳 `/cloud-logs?source_id=&trace_id=`。多条：先选源再跳。零条：提示去配置。

凭证页增加类型「阿里云 AccessKey」，字段标签为 AccessKeyId / AccessKeySecret。

## 9. 测试

不连真实阿里云。SLS HTTP 用 mock 或对 trait 的假实现。

| 用例 | 断言 |
|---|---|
| 拼查询：前缀 + 关键字 + request id | 三段 `and` 连接，id 带引号 |
| 非法 `x_request_id` | 400 |
| 时间窗 > 24h | 400 |
| `aliyun_ak` 不能绑数据源 | 400 |
| `load_credential_store` | 结果里没有 `aliyun_ak` |
| 删除仍被日志源引用的凭证 | 400 |
| 控制台 URL | path 含 project/logstore，query 含编码后的同一查询串 |
| query handler + mock SLS | 返回行 + `console_url`，响应无 `secret` / AccessKeySecret |
| 非 admin 查 / 配 | 与执行日志 / 凭证写权限相同的 403 |

## 10. 不做的代码

- 华为 / 腾讯 provider 文件（trait 允许日后加）
- 改网关监控里「SLS 聚合进 PG」的管道
- MCP 工具查 SLS
- 在回放 / 调试面板内嵌 SLS 全文（执行日志跳转即可）
