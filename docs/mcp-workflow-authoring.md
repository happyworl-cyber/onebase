# MCP 工作流创作工作台

让 AI 客户端（Claude Code 等）通过 MCP 协议在 OneBase 中**创作、调试、交付工作流**，
以工作流替代后端接口代码。设计与安全模型详见 `.omc/plans/onebase-workflow-mcp-plan.md`。

## 接入（Claude Code）

1. 页面「安全 → API Key → 个人访问令牌」生成 PAT（`obm_` 前缀，MCP 专用；区别于平台服务令牌的 `obp_`；明文只显示一次）
2. 客户端添加：

```bash
claude mcp add --transport http onebase https://你的OneBase地址/mcp \
  --header "Authorization: Bearer obm_xxxxxxxx"
```

## 工具集（11 个）

| 工具 | 用途 |
|------|------|
| `node_spec` | 节点规范知识库：9 种节点 config、模板变量、表达式语法（写定义前必读） |
| `list_workflows` / `get_workflow` | 查列表 / 查完整定义 |
| `create_workflow` | 创建（**强制 is_enabled=false**，启用由人在页面操作） |
| `update_workflow` | 更新（**不能改 is_enabled**） |
| `duplicate_workflow` | 复制为新副本（**强制 is_enabled=false**，自动唯一 slug）：基于现有工作流改造时先克隆再 update |
| `debug_workflow` | 调试未保存定义，逐节点结果；**默认 dry_run=true** |
| `workflow_api_doc` | 扫描 `{{trigger.X}}` 生成入参清单 + curl 示例 |
| `get_workflow_runs` | 执行历史排错 |
| `list_workflow_versions` / `get_workflow_version` | 版本历史（每次保存 nodes/edges 自动产生版本）：查列表 / 取某版本完整快照；恢复版本由人在页面操作 |

## 安全模型

- **PAT**：绑定用户、sha256 哈希入库、可吊销可过期；审计 `jti = "pat:{id}"` 定位到人。
- **环境隔离（实例级）**：测试/正式独立部署（不同 URL + 不同 env），MCP 权限随实例
  `RUST_ENV` 走（与 auth.rs / crypto.rs 同一惯例）：
  - `RUST_ENV=development|staging|test`：AI 真实调试可增删改查；
  - 其余值（含未设置，fail-safe）按**生产实例**对待：仅允许 ① dry_run ② 只读 DbQuery
    真实执行（READ ONLY 事务，数据修改型 CTE 也会被 PostgreSQL 拒绝）；DbExecute /
    HttpCall / EmailSend / SsePublish 返回 `blocked_by: production_readonly`，
    Lua `http.*` 直接报错。
  - 零运维配置：测试实例本来就设着 development，什么都不用做。
- **发布权留人**：MCP 无删除工具；启用/发布只能人在页面操作。

## 环境变量

业务密钥 / 配置（Stripe 密钥、回调域名等）由**项目级环境变量**统一管理，不再依赖
服务器 `.env`。在「设置 → 环境变量」页面增删改查（admin+），值加密入库、页面明文回显。

工作流两种消费方式，同源读取项目变量库：

- **模板**：任意节点 config 字符串里写 `{{env.变量名}}`（http_call header、email 地址等均可），未定义解析为空串。
- **Lua**：`env.get("变量名")` 读同一变量库——不再读进程环境变量、无 `PLUGIN_` 前缀限制；未配置返回 nil（不抛错），可用 `env.get("X") or "默认值"` 兜底。

脱敏（防密钥泄漏）：

- 工作流执行历史（workflow_runs 的节点输出 / final_output / error_message）与 `debug_workflow` 逐节点输出中，凡值来自环境变量（长度 ≥ 4）一律显示为 `***`。
- **endpoint 触发的对外 HTTP 响应不脱敏**——response 节点的 body 是返给调用方的正常业务输出，属预期行为；不要把密钥原样放进对外响应。
- 已知边界：变量值被节点二次加工（base64 / 截断 / 拼接）后输出，精确匹配不到、可能漏网（密钥通常原文直传 header，主场景已覆盖）。脱敏按变量值长度降序匹配，短值是长值子串时不会泄漏长值残余。

定位与权限红线：

- **定位**：项目级配置项 / 测试密钥的统一管理。本页面对项目 admin **明文可见**（有意的产品取舍：便于确认与修改），生产级高敏感密钥（主账户私钥等）请评估后再放入。
- **权限耦合红线**：能编辑工作流（admin+）= 能通过 Lua `env.get` 读到项目全部变量明文（并可经 http 外发）。当前两者同档不越权；**将来若把工作流编辑权下放给非 admin 角色，必须先重新设计环境变量的读取授权**，否则即成密钥导出口。

## 创作 SOP（AI 侧标准流程）

```
node_spec → create_workflow（禁用态落库）
         → debug_workflow（dry_run 验流程与模板变量）
         → debug_workflow dry_run=false（非生产库真实验证 / 生产库只读验证）
         → workflow_api_doc（生成交付文档）
         → 人工复审 + 页面启用 → POST /workflow/{db_slug}/{workflow_slug} 上线
```

## 协议实现说明

`POST /mcp`（src/mcp_server.rs）为手写 JSON-RPC 2.0 最小子集：
`initialize` / `ping` / `tools/list` / `tools/call`，MCP Streamable HTTP 无状态模式
（单 POST 单 JSON 响应），零 SDK 依赖。鉴权不走 auth_middleware，由 handler 内
`verify_pat` 完成（src/pat_handlers.rs）。
