# OneBase MCP Server

把 OneBase 的 HTTP 管理端点封装成 [MCP](https://modelcontextprotocol.io) 工具，让 AI / 自动化客户端可以直接：

- 用 PG 池里的库**开通新项目**（`create_project`）
- **创建 / 更新 / 调试 / 运行工作流**（`*_workflow`）

底层通过 **平台服务令牌（`obp_` 前缀）** 鉴权——令牌在 OneBase 后端被解析成绑定用户的身份，并受令牌 scope 约束。

## 前置：拿到平台令牌

> 最简单的方式是用网页：登录后点右上角用户菜单 →「平台服务令牌」→ 创建，页面里也有完整使用说明。
> 下面是纯命令行的等价流程。

**第 1 步：登录拿 JWT**

```bash
export ONEBASE_BASE_URL=http://127.0.0.1:3000   # 换成你的后端地址

curl -s -X POST "$ONEBASE_BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"Admin123"}'
# → { "token": "<JWT>", "user": {...} }   复制其中的 token
```

**第 2 步：用 JWT 创建平台令牌**（明文只返回一次）

```bash
export JWT=粘贴上一步的token

curl -s -X POST "$ONEBASE_BASE_URL/api/platform-tokens" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"mcp-bot","scopes":["project:create","workflow:read","workflow:write","workflow:run"],"expires_in_days":90}'
# → { "token": "obp_....", ... }   保存好 token
```

可选 scope：`project:create`、`workflow:read`、`workflow:write`、`workflow:run`，或 `*`（全部）。
不传 `scopes` 默认给全部；不传 `expires_in_days` 表示永不过期。

> 注意：创建令牌只认 JWT（登录用户），不能用 `obp_` 令牌再创建令牌（防提权）。

## 构建

```bash
cd mcp-server
npm install
npm run build
```

## 配置（环境变量）

| 变量 | 说明 |
|------|------|
| `ONEBASE_BASE_URL` | 后端基址，如 `http://10.0.5.11:31088` |
| `ONEBASE_TOKEN` | 平台令牌明文，`obp_` 开头 |

## 接入 MCP 客户端

以 Cursor / Claude Desktop 等的 `mcpServers` 配置为例：

```json
{
  "mcpServers": {
    "onebase": {
      "command": "node",
      "args": ["/绝对路径/onebase/mcp-server/dist/index.js"],
      "env": {
        "ONEBASE_BASE_URL": "http://10.0.5.11:31088",
        "ONEBASE_TOKEN": "obp_xxxxxxxx"
      }
    }
  }
}
```

## 工具一览

| 工具 | 作用 | 所需 scope |
|------|------|-----------|
| `list_pg_pools` | 列出可用 PG 池（拿 `pg_pool_id`） | — |
| `list_templates` | 列出项目模板（拿 `template_slug`） | — |
| `create_project` | 在 PG 池上建库 + 开通项目 | `project:create` |
| `list_workflows` | 列出工作流（可按 `database_id` 过滤） | `workflow:read` |
| `get_workflow` | 查看工作流详情 | `workflow:read` |
| `create_workflow` | 创建工作流（DAG） | `workflow:write` |
| `update_workflow` | 局部更新工作流 | `workflow:write` |
| `debug_workflow` | 对未保存定义跑一遍（支持 `dry_run`） | `workflow:write` |
| `run_workflow` | 调用 endpoint 工作流 | `workflow:run` |

## 典型流程

1. `list_pg_pools` + `list_templates` → 拿到 `pg_pool_id`、`template_slug`
2. `create_project` → 拿到 `database_id`、`database_slug`
3. `create_workflow`（带 `database_id`，定义 `nodes`/`edges`）
4. `debug_workflow`（`dry_run: true`）验证定义
5. `run_workflow`（`database_slug` + `workflow_slug` + `payload`）触发执行

## 工作流定义速览

- 节点：`{ id, type, label?, config }`，`type` ∈ `code` / `db_query` / `db_execute` / `http_call` / `email_send` / `condition` / `transform` / `response` / `sse_publish`
- 边：`{ from, to, branch? }`；`condition` 节点用 `branch`（`true`/`false`）区分分支
- 模板变量：节点 config 内可用 `{{trigger.字段}}`、`{{节点id.字段}}`
- `condition` 节点两种写法均可：单表达式 `{ "expression": "{{trigger.age}} > 18" }`（走 true/false 边），或多分支 `{ "conditions": [{ "branch": "...", "expression": "..." }], "default_branch": "..." }`
