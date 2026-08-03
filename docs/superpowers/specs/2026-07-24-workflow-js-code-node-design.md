# 工作流 Code 节点支持 JavaScript（Node.js）设计

> 状态：implemented（一期已落地；JS host bridge 的 crypto 仅部分对齐 Lua——sha256/hmac_sha256/uuid/base64，md5/aes/rsa 等待补全）。
>
> 背景：工作流 `code` 节点目前仅支持嵌入式 Lua（mlua）。团队计划将 n8n 工作流迁移到 OneBase，n8n 侧逻辑多为 Node.js；若强制改写为 Lua 成本过高。
>
> 范围锁定：一期仅 JavaScript（Node.js + 工作流级 npm）；Python / n8n `$input` 兼容层不做。

## 1. 目标与非目标

### 1.1 目标

1. `code` 节点可选执行 **JavaScript（Node.js）**，默认仍为 Lua，现有工作流零改动。
2. 脚本约定沿用 OneBase 的 `ctx.body` / `ctx.nodes`（允许入口处少量改动；**不**追求 n8n Code 节点 API 兼容）。
3. **按工作流**管理 npm 依赖（完整 npm 生态，非白名单）。
4. 执行使用 **子进程 + bwrap/nsjail**（复用调度器 shell 沙盒思路）。
5. 宿主 API **尽量对齐** 现有 Lua builtins：`env` / `http` / `crypto` / `log` / `json` / `time` / `sse` / `google`（含同等安全策略）。
6. 功能开关控制上线；宿主机缺少 `node`/`npm` 时给出明确错误。

### 1.2 非目标

| 不做 | 说明 |
|---|---|
| Python / 其他语言 | 二期；架构预留 `language` 扩展 |
| n8n `$input` / `$json` / `items` 兼容层 | 迁移时手改入口即可 |
| 项目级共享 `node_modules` | 一期仅工作流级 |
| 同进程嵌入 V8/Deno | 与「完整 npm」冲突，且隔离弱 |
| 外置 sidecar Worker 池 | 运维过重，一期不做 |
| 包名白名单 / 私有 registry 策略引擎 | 一期仅支持配置 registry URL 与安装超时 |
| 复杂依赖 GC（多版本保留 / 全局 LRU） | 一期：hash 变更则重装；可选后续再做清理 |

## 2. 关键决定

| 决定 | 选项 | 理由 |
|---|---|---|
| 成功标准 | OneBase `ctx` 约定，非 n8n API | 迁移成本可接受，实现面可控 |
| 语言一期 | **仅 Node.js** | 对应 n8n 主力；Python 二期 |
| 依赖作用域 | **按工作流** | 隔离清晰，与「每个迁移工作流自带依赖」一致 |
| 隔离 | **子进程 + bwrap/nsjail** | 对齐调度器；比同进程嵌入更安全 |
| 节点形态 | **扩展现有 `code` + `language`** | 避免 `code_js` 类型膨胀；Lua 路径不动 |
| 宿主 API | **对齐 Lua builtins（IPC 桥）** | 密钥与 SSRF 策略留在 Rust，脚本不直触私钥 |
| 架构方案 | **方案 1**（统一 code 节点 + 预加载 runtime） | 见下文 |

## 3. 架构

```
Workflow save / first JS exec
        │
        ▼
  deps hash 变更？ ──yes──► npm ci|install → workflow_deps/{id}/javascript/
        │
        ▼
DagEngine exec_code_node
        │
        ├─ language=lua  ──► 现有 LuaEngine（不变）
        │
        └─ language=javascript
                │
                ▼
         写临时 entry + 注入 ctx JSON
                │
                ▼
         bwrap/nsjail → node --require onebase-runtime entry.js
                │                    ▲
                │   IPC (UDS / 帧)   │
                └────────────────────┘
                   Rust HostBridge
                   （复用 lua_builtins 策略）
                │
                ▼
         stdout/结果文件 → ctx.body 写回
```

模块落点（实现计划可细化路径）：

```
src/workflow_engine.rs          # Code 分发：lua | javascript
src/js_engine/ 或 js_runner.rs  # 子进程执行、超时、结果解析
src/js_host_bridge.rs           # IPC 服务端；调用与 Lua 同策略的能力
src/js_deps.rs                  # 工作流依赖目录、hash、npm install 互斥
src/scheduler/executors.rs      # 复用/抽取沙盒启动（避免复制粘贴 bwrap 参数）
frontend-nextjs/.../NodeConfigPanel.tsx  # language + 编辑器模式
frontend-nextjs/.../Workflow*            # 工作流级依赖面板与 deps 状态
src/mcp_tools.rs                # NODE_SPEC 文档
```

运行时 JS 包（随服务部署，非用户依赖）：

```
js-runtime/onebase-runtime/   # --require 预加载；暴露 env/http/crypto/...
```

## 4. 数据模型

### 4.1 节点

继续 `type: "code"`。`config`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | string | 脚本源码（Lua 或 JS） |
| `language` | `"lua"` \| `"javascript"` | **可选**；缺省 `"lua"` |

示例：

```json
{
  "id": "transform",
  "type": "code",
  "label": "处理逻辑",
  "config": {
    "language": "javascript",
    "code": "function execute(ctx) {\n  ctx.body = { ok: true, from: ctx.body };\n  return ctx.body;\n}\nexecute(ctx);\n"
  }
}
```

### 4.2 工作流级依赖

存在工作流 definition 根级（与 `nodes` / `edges` 同级），不挂在单个节点上：

```json
{
  "nodes": [ ... ],
  "edges": [ ... ],
  "dependencies": {
    "javascript": {
      "packageJson": {
        "name": "workflow-<id>",
        "private": true,
        "dependencies": {
          "axios": "^1.7.0",
          "lodash": "^4.17.21"
        }
      },
      "packageLock": null
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `packageJson` | 完整或最小 `package.json` 对象；至少含 `dependencies` |
| `packageLock` | 可选字符串（lockfile 全文）；有则优先 `npm ci` |

磁盘布局：

```
{WORKFLOW_DEPS_DIR}/workflow_deps/{workflow_id}/javascript/
  package.json
  package-lock.json   # 若有
  node_modules/
  .deps-hash          # packageJson+lock 的稳定 hash
```

### 4.3 依赖状态（运行时/API）

状态写在依赖目录旁的 `.deps-status.json`（不新增 DB migration）；工作流详情 API 读取并返回：

| 状态 | 含义 |
|---|---|
| `idle` | 无 JS 依赖或未触发安装 |
| `installing` | 正在 npm install |
| `ready` | hash 匹配且 `node_modules` 可用 |
| `failed` | 最近一次安装失败（附 `error`） |

**语义**：保存工作流在依赖安装失败时**仍可成功**，但标记 `failed`；执行 JS code 节点时若未 `ready`，**节点失败**（不静默在无依赖环境下执行）。

## 5. 脚本约定（JavaScript）

与 Lua 对齐：

- 输入：`ctx.body`（触发/上游写入的载荷）、`ctx.nodes.<nodeId>`（上游输出）。
- 另注入与 Lua plugin 一致的上下文字段（如 `method`、`path`、`user_id`、`tenant_id`、`database_id`、`request_id`、`headers` 等）——以现有 `PluginContext` 为准。
- 输出：修改 `ctx.body`，或 `return` 普通对象（引擎写回 `ctx.body`）。
- 入口：支持裸脚本；或定义 `function execute(ctx) { ... }` / `module.exports.execute`。**引擎在包装层自动调用 `execute(ctx)`（若存在）**，避免「只定义不调用」导致空跑。

用户通过 `require()` 加载工作流 `node_modules` 中的包。**一期仅保证 CommonJS**；纯 ESM 包若无法 `require`，视为该包不兼容一期（文档注明；二期再评估 ESM loader）。

## 6. 依赖安装

1. **触发**：
   - 保存工作流且 `dependencies.javascript` 内容 hash 变化 → 异步安装；
   - 执行 JS code 节点前发现未就绪或 hash 不匹配 → 同步安装（带超时），失败则节点失败。
2. **命令**：有 lock → `npm ci --omit=dev`；否则 `npm install --omit=dev`。
3. **互斥**：同一 `workflow_id` 安装互斥锁，避免并行损坏 `node_modules`。
4. **配置**（环境变量）：
   - `WORKFLOW_DEPS_DIR` — 依赖根目录；缺省为数据目录下 `workflow_deps`
   - `WORKFLOW_NPM_REGISTRY` — 可选；设置则 `npm` 使用该 registry
   - `WORKFLOW_NPM_INSTALL_TIMEOUT_MS` — 缺省 `300000`（5 分钟）
   - `WORKFLOW_JS_TIMEOUT_MS` — 缺省 `30000`（与 Lua 对齐）
   - `WORKFLOW_JS_CODE_ENABLED` — 功能开关；**缺省 `false`**
5. **清理**：一期不做自动 GC；运维可手动删目录，下次执行按 hash 重装。

## 7. 执行与宿主桥

### 7.1 执行

1. 确认 `WORKFLOW_JS_CODE_ENABLED` 且本机有 `node`/`npm`。
2. 确保依赖 `ready`。
3. 组装 ctx → 临时目录写入 `ctx.json` + `entry.js`（包装用户代码）。
4. 启动：`node --require <onebase-runtime> entry.js`，`cwd` 为工作流 JS 依赖目录（或显式 `NODE_PATH`）。
5. 沙盒：复用调度器 `ShellExecutor` 的 bwrap/nsjail/direct 策略；超时使用 `WORKFLOW_JS_TIMEOUT_MS`（默认与 Lua 同为 30s），超时杀进程。
6. 结果：约定从结果文件或 stdout 尾帧读取 JSON `{ "body": ... }`；stderr 进入节点错误/调试日志。

### 7.2 宿主 API

预加载模块暴露与 Lua 同名能力：

| API | 行为 |
|---|---|
| `env.get(key)` | 项目环境变量，非 process env |
| `http.get/post/put/delete` | 走 Rust；SSRF 策略与平台受控 HTTP **对齐到更严一侧**（至少不弱于 `http_call`） |
| `crypto.*` | 与 `lua_builtins` 同集合，计算在 Rust 或等价实现 |
| `log.*` | 进入工作流执行日志 |
| `json.*` / `time.*` | 与 Lua 语义对齐 |
| `sse.publish` | 走 Rust |
| `google.sa_assertion` | 私钥留在 Rust |

传输：Unix domain socket 或长度前缀帧 IPC；每个脚本运行短生命周期 bridge，随子进程结束关闭。

### 7.3 错误

- 脚本 throw、非 0 退出、超时、IPC 失败、依赖未就绪、功能关闭、无 node → 节点失败，错误信息可在调试面板查看。

## 8. UI / MCP

- `code` 节点：语言选择 Lua / JavaScript；编辑器模式与默认模板随语言切换。
- 工作流级「依赖」面板：编辑 `dependencies.javascript.packageJson.dependencies`（支持粘贴 JSON）；展示 `deps_status` 与最近错误。
- 侧栏不新增独立「Node.js 代码」节点类型。
- MCP `NODE_SPEC` 更新 `code`：`language`、依赖字段、JS 示例。

## 9. 安全

| 控制 | 行为 |
|---|---|
| 进程隔离 | bwrap/nsjail（prod 推荐强制；dev 可 direct + warn） |
| 超时 | 杀子进程 |
| 密钥 | 仅经 `env` / `google` 宿主 API；不把 SA 私钥写入 ctx |
| HTTP | 宿主转发并做私网/SSRF 校验 |
| 依赖安装出网 | 仅安装阶段访问 registry；与脚本执行出网策略分离配置（若沙盒 `--share-net`，脚本仍可自建 socket——一期接受「完整 npm + Node 能力」的残留风险，靠沙盒与项目权限约束；文档标明） |
| 权限 | 能编辑工作流 ≈ 能执行任意 JS + 安装任意包；与现网「能写 Lua 即高权限」同级，需管理员意识 |

## 10. 测试

1. **单测**：`language` 缺省 lua；分发正确；hash 不变不重装；超时杀进程。
2. **集成**：使用 `axios` 的节点读写 `ctx.body`；`env.get` / 受控 `http` 经 IPC 与策略一致。
3. **沙盒**：有 bwrap 跑沙盒路径；无则 direct + 明确 skip/warn（对齐调度器）。
4. **回归**：现有 Lua code 工作流行为不变。

## 11. Rollout

1. 合并后 **`WORKFLOW_JS_CODE_ENABLED` 缺省 `false`**；环境显式设为 `true` 后启用。
2. 部署镜像/主机安装 Node.js LTS + npm；生产确认 bwrap。
3. 内部迁移 1～2 条原 n8n 工作流验证后，再开生产开关。
4. Python 二期：增加 `language: "python"` + pip 目录 + 同类 runner/bridge。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| npm 安装慢/失败阻塞执行 | 保存时异步预装；执行前有超时与清晰错误 |
| IPC 与 Lua 行为漂移 | 共享 Rust 能力实现；对照测试 |
| 沙盒下 node_modules 路径 bind | 明确 ro-bind 依赖目录 + tmp 可写 entry |
| 用户期望 n8n API | 文档与模板强调 `ctx`；不做兼容层 |
| 任意包供应链 | 与「完整 npm」取舍一致；后续可加 registry 与审计 |

## 13. 成功标准

- 新建 JS code 节点，声明 `axios` 依赖，保存后安装成功，执行后 `ctx.body` 正确。
- 旧 Lua 工作流无需修改即可运行。
- 关闭功能开关时，JS 节点失败信息明确。
- 宿主 `env`/`http` 行为与安全策略不弱于约定基线。
