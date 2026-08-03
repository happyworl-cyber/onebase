# 工作流统一响应信封规范

> 状态：design 待 user review（2026-06-15）。
>
> 背景：endpoint 类工作流当前由作者在 `response` 节点里自由填 `body`，对外返回结构因人而异（如 `{game, msg, ok, result}`、`{ok:true}`、裸数组等），调用方无法用统一逻辑判成败、取数据。本规范把对外响应**统一为 `{code, message, data}` 信封**，并由引擎在出口处自动包裹，让所有人按同一套约定设计工作流响应。

## 1. 目标与非目标

### 1.1 目标

- **统一**：所有 endpoint 工作流对外返回同一信封 `{code, message, data}`，调用方只看 `code` 判成败、取 `data` 拿数据。
- **作者低成本**：作者**无需改任何节点**也能拿到统一信封（引擎自动包裹）；需要业务码时再按规范主动返回信封。
- **可规范、可教学**：本文档即规范，给出作者编写指引与示例，新人照抄即可。

### 1.2 非目标

| 不做 | 理由 |
|---|---|
| 向后兼容旧调用方 | 已确认接受 breaking change：旧调用方需改为读 `data`。统一优先。 |
| cron / notify / manual 触发的包裹 | 这些不对外返回 HTTP 响应，无信封意义；仅 endpoint 类生效。 |
| 强制作者只能用信封 | 作者可继续随意写 `body`，引擎兜底包裹；只有想自定义业务码时才需按信封写。 |
| 改造 `response` 节点的配置 UI | v1 不动节点结构，纯出口层包裹；后续如需"信封模式"勾选项再议。 |

## 2. 信封结构

所有 endpoint 工作流对外响应统一为：

```json
{
  "code": 0,
  "message": "",
  "data": {}
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `code` | integer | `0` = 成功；非 `0` = 失败。 |
| `message` | string | 成功时 `""`；失败时为人类可读的错误描述。 |
| `data` | any（object / array / 标量 / null） | 成功时为业务数据；失败时为 `null`。 |

### 2.1 `code` 取值规范

| 取值 | 含义 | 由谁产生 |
|---|---|---|
| `0` | 成功 | 引擎自动包裹，或作者显式返回 |
| 正整数（如 `1001`、`40001`） | 业务错误，语义由作者/团队约定 | 作者在 `response` 节点 body 里显式返回 |
| `-1` | 系统/引擎级错误（节点报错且无 response 节点被执行、引擎异常等） | 引擎产生 |

> 业务码空间（正整数）由各团队自行规划，建议在各自工作流文档里维护码表。`-1` 为系统保留，作者不应使用。

## 3. 引擎出口包裹规则

在 `endpoint_trigger` / `endpoint_trigger_get` / `endpoint_trigger_public` 三处出口，对 response 节点的 `body` 应用以下规则（**智能透传 + 自动包裹**）：

```
设 body 为 response 节点输出的 body 字段：

1. 智能透传：若 body 是 JSON 对象且含 "code" 键
   → 视为作者已按信封返回，原样透传（作者掌控 code/message/data）。

2. 自动包裹：否则
   → 返回 { "code": 0, "message": "", "data": body }
      （body 为 null 时 data 即 null）。
```

### 3.1 示例

**作者啥都没改**（body = `{game:"rocs", msg:"...", ok:true, result:"0"}`）：

```json
{
  "code": 0,
  "message": "",
  "data": { "game": "rocs", "msg": "...", "ok": true, "result": "0" }
}
```

**作者要返业务错误**（在 response 节点 body 里直接写信封）：

```json
{ "code": 1001, "message": "余额不足", "data": null }
```

→ 含 `code` 键，原样透传。

## 4. 错误路径

| 场景 | code | message | data | HTTP |
|---|---|---|---|---|
| 成功 | `0` | `""` | 业务数据 | 200 |
| 业务失败（作者主动返回信封） | 作者定义（如 `1001`） | 作者定义 | `null` 或作者定义 | 200 |
| 系统失败（节点报错且无 response 节点 / 引擎异常） | `-1` | 错误信息 | `null` | 500 |

## 5. `code` 与 HTTP 状态码解耦

- 工作流**跑完即 HTTP 200**（含业务失败）——调用方只凭 `code` 判成败，逻辑统一。
- 仅**系统级错误**（引擎崩溃、工作流未找到/未启用、鉴权失败等执行前/执行中异常）走非 200（沿用现有 `AppError` 语义，body 仍尽量包成信封 `{code:-1,...}`）。

## 6. 适用范围

- **生效**：`trigger_type = 'endpoint'` 的全部对外 HTTP 出口，含 POST（`endpoint_trigger`）、GET（`endpoint_trigger_get`）、public（`endpoint_trigger_public`）。
- **不生效**：cron / notify / manual / hook 触发（不对外返回 HTTP 响应）。

## 7. 作者编写指引

1. **默认情况**：正常用 `response` 节点把业务结果放进 `body` 即可，引擎会自动包成 `{code:0, message:"", data:<body>}`。无需关心信封。
2. **要返业务错误**：把 `response` 节点的 `body` 直接写成信封，并给出非 0 `code`：
   ```json
   { "code": 1001, "message": "余额不足", "data": null }
   ```
3. **要自定义成功信封**（例如想自己控制 `message` 或让 `data` 是数组）：同样直接在 `body` 里写完整信封，含 `code:0`，引擎原样透传。
4. **不要**在业务里使用 `code:-1`，那是系统保留码。

## 8. 实现位置（落地参考，待 plan 细化）

- `src/workflow_engine.rs`：新增一个出口包裹辅助函数（如 `wrap_response_envelope(body) -> Value`），实现 §3 规则；单一构造点，三处出口共用。
- `src/workflow_handlers.rs`：`endpoint_trigger` / `endpoint_trigger_get` / `endpoint_trigger_public` 三处把 `Ok(Json(body))` 改为 `Ok(Json(wrap_response_envelope(body)))`；系统失败分支构造 `{code:-1, message, data:null}`。
- 执行记录「最终输出」展示：可继续展示 response 节点原始输出（`{status_code, body, headers}`），信封化只作用于对外 HTTP 响应；如希望执行记录也展示包裹后结果，plan 阶段再定。

## 9. 迁移影响与兼容性

- **Breaking**：现有 endpoint 工作流的外部调用方拿到的结构会从「裸 body」变成「`{code,message,data}` 信封」。调用方需改为读取 `data`。
- 已按 `{code,...}` 形态返回的老工作流（恰好含 `code` 键）会被识别为信封、原样透传，不受影响。
- 建议：上线前盘点现有 endpoint 工作流的调用方，统一通知改造。

## 10. 验收标准

- 任一 endpoint 工作流（POST/GET/public），作者不改节点，对外响应均为 `{code:0, message:"", data:<原 body>}`。
- 作者在 response 节点写 `{code:1001,...}` 时，对外原样透传，HTTP 200。
- 节点报错且无 response 节点时，对外返回 `{code:-1, message:<错误>, data:null}`，HTTP 500。
- cron/notify/manual 触发行为不变。
