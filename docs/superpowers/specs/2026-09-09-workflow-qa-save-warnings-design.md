# 工作流保存前规范预警 — 设计文档

- 日期：2026-09-09
- 状态：已通过
- 范围：保存前用本地规则预检未保存定义，有发现项则弹层，仍允许保存。不调用项目 AI Provider，不挡硬错误以外的保存。
- 相关代码：
  - `src/workflow_qa/`（规则；本档为 `WorkflowSnapshot` 增加 `input_schema`）
  - `src/workflow_handlers.rs` / `src/main.rs`（新 `POST /api/admin/workflows/qa`，须在 `/:id` 之前注册）
  - `src/mcp_tools.rs`（`review_*` 自动带上新 `style.*` 规则，无新工具）
  - `frontend-nextjs/components/workflow/WorkflowsManager.tsx`（保存链）
  - `frontend-nextjs/components/Modal.tsx`

## 1. 目标与非目标

作者常能写出「引擎不报错、但写法不规范」的图。第一期质量检查只覆盖危险习惯和结构问题，且只在 MCP。保存成功会立刻回列表，提醒必须出现在保存之前。

**目标**

1. 点保存后、写入前：对**当前编辑器定义**跑本地规则（现有 7 条 + 4 条规范）。
2. 有发现项则弹层，可「返回修改」或「仍然保存」。
3. JSON / cron / 节点 config 等硬错误仍立即中止，行为与今天一致。
4. 不调用项目 AI Provider；预检不写库、不打版本。

### 已确认需求

| 项 | 结论 |
|---|---|
| 交互 | 保存前 Modal，不挡保存 |
| 检查引擎 | 只跑本地规则 |
| 清单 | B：4 条 `style.*` + 现有 7 条一并显示 |
| 实现 | 复用 `workflow_qa`，另开 qa 接口（不在前端重写规则） |
| 跳过记忆 | 每次保存都重新预检，不记住「仍然保存」 |

### 非目标

- 保存接口内嵌预检 / `confirm_warnings` 二次提交
- 编辑器或保存路径调用项目 AI Provider
- 弹层跳转到节点（只展示 `node_label`）
- 预警写入 `version_note` 或落库
- 报「未见 `execute()`」、label 为空、非 endpoint 缺 `input_schema`、Lua `pcall`
- 前端再实现一遍规则

## 2. 关键决定

| 项 | 结论 | 理由 |
|---|---|---|
| 路由 | `POST /api/admin/workflows/qa`，与 `debug` 一样在 `/:id` 前注册 | 吃未保存定义；避免 `qa` 被当成 id |
| 鉴权 | 与 `debug_workflow` 相同：用 `database_id` / `tenant_id` 解析租户并 `require_tenant_member` | 新建未保存无 workflow id |
| 预警与硬错误 | qa 业务成功恒 200；鉴权失败 401/403；nodes/edges 非法 400 | 预警绝不当成 4xx |
| 规范级别 | 新 4 条 `low` + `style.` 前缀 | 不和 `huge_code` 等抢名 |
| AI Provider | qa / 保存路径不发起模型请求 | 保存必须是秒级 |
| MCP | 不改工具列表；`scan_rules` 多 4 条后 `review_*` 自动带上 | 单一规则源 |

## 3. 架构

```
handleSave
  ├─ 硬校验失败 → alert，停
  ▼
POST /api/admin/workflows/qa
  │  JWT + database_id
  ▼
workflow_qa::review_local（脱敏 + 11 条规则）
  │
  ├─ findings 空 → create/patch，回列表
  ├─ findings 非空 → Modal → 返回修改 | 仍然保存→ create/patch
  └─ qa 网络/5xx → Toast「预检失败，仍可保存」+ 仍出「仍然保存 / 取消」
```

`WorkflowSnapshot` 增加 `input_schema: Option<Value>`，供 `style.missing_input_schema`。`snapshot_from_get_json` / `list_item` 读取该字段（缺省 `None`）。

## 4. 预检契约

请求：

```json
{
  "database_id": 2,
  "tenant_id": null,
  "trigger_type": "endpoint",
  "input_schema": null,
  "nodes": [],
  "edges": []
}
```

| 字段 | 说明 |
|---|---|
| `nodes` / `edges` | 必填，JSON 数组 |
| `trigger_type` | 缺省 `manual` |
| `input_schema` | 省略或 `null` = 未声明 |
| `database_id` / `tenant_id` | 与 debug 相同，用于解析租户 |

回包 200：

```json
{ "findings": [ { "severity", "code", "title", "detail", "node_id", "node_label", "evidence" } ] }
```

排序：`crit > high > med > low`，同级按 `code`、再按 `node_id`。形状与 MCP 发现项相同。

## 5. 弹层

- 标题：`保存前有 N 条提醒`
- 每行：级别色点、title、节点 label（有则）、detail
- 主按钮「仍然保存」→ 现有 create/patch
- 次按钮「返回修改」→ 关层，留在编辑器
- 硬错误仍用现有 `alert`，不进 qa

## 6. 规则

现有 7 条判定与级别不变（`hardcoded_secret`、`empty_code`、`endpoint_no_response`、`noop_b64_roundtrip`、`manual_object_storage`、`isolated_node`、`huge_code`）。保存弹层也列出它们，**仍不挡保存**。

新增（皆 `low`）：

| code | 判定 |
|---|---|
| `style.missing_input_schema` | `trigger_type == endpoint` 且 `input_schema` 不是 JSON object。`{}` 不报。`node_id` 空 |
| `style.generated_node_id` | `id` 匹配 `` `{type}_{base36}_{序号}` ``（`generateNodeId`），且前缀等于该节点 `type`。`resp_ok` / `normalize` 不报 |
| `style.bare_except` | Python：`except:` / `except Exception:` 后一行是 `pass` 或空；JS：`catch {}` / `catch (...) {}`。Lua `pcall` 不报 |
| `style.http_in_code` | `type==code` 且源码含 `http.get` / `http.post` / `http.put` / `http.delete`。可与 `manual_object_storage` 同时命中 |

不报：裸脚本 / 无 `execute`、label 为空、非 endpoint 缺 schema。

## 7. 测试

规则（`--lib workflow_qa`）：

- endpoint + `input_schema=null` → `style.missing_input_schema`；`{}` 不报；`cron` 不报
- `id=code_lj9abc_3` 且 `type=code` → `style.generated_node_id`；`id=resp_ok` 且 `type=response` 不报
- `except:\n    pass`、`catch {}` → `style.bare_except`；`except ValueError:\n    return {}` 不报
- `http.post(` → `style.http_in_code`
- 现有 7 条回归仍过
- 排序：crit 在 low 前

qa handler：nodes 非数组 → 400；合法空图 → 200 + `findings` 数组（可能空）。不写连接 AI Provider 的测试。不写前端单测（仓库无 runner）；手动：有预警弹层后「仍然保存」能写入，「返回修改」不写库。

## 8. 不做的代码

- 不改 `create_workflow` / `update_workflow` 的写入语义
- 不改 `workflow_engine.rs`
- 不加 migration
- 不改 `mcp-server/src/index.ts` 工具列表
