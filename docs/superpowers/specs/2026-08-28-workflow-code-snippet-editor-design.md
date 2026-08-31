# 工作流代码片段：大窗口 + 内嵌 IDE — 设计文档

- 日期：2026-08-28
- 状态：草案
- 相关代码：
  - `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`（节点配置右侧栏，现为 `<textarea>`）
  - `frontend-nextjs/components/workflow/WorkflowCanvas.tsx`（挂载配置栏）
  - `frontend-nextjs/components/Modal.tsx`（现有弹窗 `full` = `max-w-6xl`，本功能不复用）
  - 只读路径：版本浏览页通过 `NodeConfigPanel readOnly`

## 1. 背景与目标

工作流节点配置里的代码、SQL、JSON 都在右侧栏用固定行数的 `<textarea>` 编辑。默认栏宽 280px，代码节点只有 12 行，没有语法高亮和行号。用户反馈：窗口太小，需要大窗口，也需要 IDE 级编辑。

**目标**：工作流节点配置里所有代码类字段，都用内嵌 CodeMirror 6 编辑（高亮、行号、括号匹配），并支持放大到接近全屏的编辑层。改动即时写回节点 config，后端与保存/运行协议不变。

### 已确认需求

1. **范围**：工作流节点配置里所有代码类输入（代码节点 + SQL、JSON、HTTP Body 等），不是只改「代码」节点。
2. **能力**：应用内 IDE（高亮、行号、括号匹配）+ 大窗口；不接外部 IDE。
3. **交互**：面板里就是小 IDE，另提供「放大」到大编辑层（方案 C）。
4. **编辑器**：CodeMirror 6，一个共用组件同时服务小窗和大窗（方案 1）。
5. **写入**：边打边写回，大窗关闭不需要二次「应用 / 保存」。

### 非目标（YAGNI）

- 不接 Cursor / VS Code / MCP 外部打开。
- 不改工作流页头的 npm / pip 依赖框。
- 不把单行字段（URL、参数、数据源、超时、Redis key/ttl 等）换成编辑器。
- 不做自动补全、诊断、格式化、Vim 模式、自定义搜索条（查找用编辑器自带 `Cmd/Ctrl+F`）。
- 不改右侧栏默认宽度（仍 280–900，持久化 key 不变）。
- 不改后端、节点 config 形状、JSON 校验规则。

## 2. 关键决定

| 决定 | 选择 | 理由 |
|------|------|------|
| 编辑器 | CodeMirror 6 | 多实例轻；适合同一面板同时出现 SQL / JSON / Body |
| 组件 | 单一 `CodeSnippetEditor` | 小窗和大窗同一套，避免两套行为 |
| 大窗 | 独立遮罩层，不复用 `Modal` | 现有 `full` 宽度和高度都不够当 IDE |
| 写入 | `onChange` 即时写回 | 与现有 textarea 一致；关窗即收起 |
| 主题 | 代码节点深色；SQL / JSON 浅色 | 代码节点沿用现有终端风格；表单字段与面板一致 |
| 栏宽 | 不改 | 长文本靠放大，不靠加宽默认栏 |

## 3. 架构

```
NodeConfigPanel / StatementsEditor
        │  value: string
        │  onChange(string)
        │  onBlur?  language  readOnly  minRows
        ▼
CodeSnippetEditor
        │
        ├─ 工具栏：语言标签 + 放大
        ├─ CodeMirror 小窗（固定 minRows 高度）
        │
        └─ 放大 ──► CodeSnippetEditorOverlay
                      接近视口 92% × 88%
                      同一 value / onChange
                      Esc / 遮罩 / 关闭 → 收起（并触发一次 onBlur）
                      失败时回退 textarea
```

### 组件边界

| 单元 | 职责 | 依赖 |
|------|------|------|
| `CodeSnippetEditor` | 小窗 CM、工具栏、打开/关闭大窗、加载失败回退 textarea | CodeMirror 6 语言包 |
| `CodeSnippetEditorOverlay` | 全屏遮罩、标题、大窗 CM（或回退 textarea） | 由 `CodeSnippetEditor` 内部使用，不对外 |
| `NodeConfigPanel` | 把各字段 textarea 换成组件；继续负责对象/字符串互转与 JSON 校验 | 编辑器只收发 string |
| `StatementsEditor` | 每条 SQL 换成组件；参数行仍用 textarea | 同上 |

不把编辑器逻辑堆进 `NodeConfigPanel`（该文件已超过 2000 行）。`WorkflowEditorHeader` 本轮不改。

建议路径：`frontend-nextjs/components/workflow/CodeSnippetEditor.tsx`（若 overlay 超过约 80 行再拆同目录 `CodeSnippetEditorOverlay.tsx`）。

## 4. 编辑器约定

### 4.1 对外 props

```ts
type SnippetLanguage = 'lua' | 'javascript' | 'python' | 'sql' | 'json'

interface CodeSnippetEditorProps {
  value: string
  onChange?: (value: string) => void
  language: SnippetLanguage
  label: string          // 大窗标题、无障碍名
  minRows?: number       // 小窗高度，默认按语言：code 12，sql 5，json 4
  readOnly?: boolean
  onBlur?: () => void    // 小窗失焦，或大窗关闭
  invalid?: boolean      // 红框，接现有 jsonFieldErrors
  placeholder?: string
}
```

`onChange` 为空或 `readOnly` 时内容不可改，仍可放大查看。

### 4.2 语言映射

| 字段 | language |
|------|----------|
| 代码节点 Lua / JS / Python | `lua` / `javascript` / `python` |
| SQL 查询、SQL 语句、事务/foreach 各条 SQL | `sql` |
| Headers、Body、transform output、response body/headers、Kafka value/headers、SSE 推送数据、call_workflow input、对象存储 keys | `json` |

Lua 使用 `@codemirror/legacy-modes` 的 StreamLanguage，不引入单独社区 Lua 包。

### 4.3 覆盖字段（完整清单）

只替换下列 textarea，没有「其余」兜底：

| 节点 | 字段 | language | 建议 minRows（对齐现 rows） |
|------|------|----------|---------------------------|
| `code` | `code` | 节点语言 | 12 |
| `db_query` / `db_execute` | `sql` | `sql` | 5 |
| `db_transaction` / `foreach` | 每条 `statements[].sql` | `sql` | 4 |
| `http_call` | `headers`, `body` | `json` | 3 |
| `transform` | `output` | `json` | 6 |
| `response` | `body`, `headers` | `json` | 5 / 2 |
| `sse_publish` | `data` | `json` | 5 |
| `call_workflow` | `input` | `json` | 6 |
| Kafka | `value`, `headers` | `json` | 4 / 3 |
| 对象存储 | `keys` | `json` | 2 |

**不替换**（即使是 textarea）：

- 单行 input（URL、参数、数据源、超时、slug、topic 等）
- 事务 / foreach 的「参数（每行一个）」
- `email_send` 的 To / 纯文本正文 / HTML 正文（收件人列表与邮件正文，不是代码片段）
- Redis 多行 `value` / `members` / `values`（短模板，不是代码）
- 对象存储 `content`（模板原文，不是 JSON）
- 动态 SQL 复选框、语言 `<select>`、页头 npm / pip

### 4.4 高度与主题

- 小窗高度 = `minRows * 行高`（约 1.5rem/行），不随内容长高，内部滚动。
- 默认 `minRows`：代码 12，SQL 5，JSON 4；调用方可覆盖以贴近原 `rows`。
- 大窗：编辑区占满遮罩内容区剩余高度（`flex-1 min-h-0`）。
- 代码节点：深色主题（对齐现 `bg-gray-900 text-green-400`）。
- SQL / JSON：浅色主题。
- 行号常开；括号匹配常开。

### 4.5 大窗交互

- 工具栏「放大」打开。用组件内共享状态（React context 或模块级 setter）保证**同时只有一个大窗**：打开 B 时自动关掉 A。
- 尺寸约视口 92% 宽 × 88% 高，居中，背景变暗。
- 标题 = `label`；关闭按钮；点遮罩关闭；Esc 关闭。
- 大窗打开时不改 `document.body` 滚动锁之外的全局状态；关闭时恢复。
- 关闭时调用一次 `onBlur`（JSON 校验与现失焦行为对齐）。
- 无页脚、无「保存 / 应用」。

## 5. 数据流

编辑器只处理字符串。父组件保持现有写入语义：

| 字段 | 写入 |
|------|------|
| `code`、SQL、Kafka value | 原样字符串 |
| `transform` output | `JSON.parse` 成功则存对象，失败或整段 `{{...}}` 暂存原文 |
| `http_call` / `response` headers、body；Kafka headers | 与现 `onChange` / `onBlur` 相同 |

`isWholeTemplateExpr` 与 `validateJsonField` 不搬家、不改规则。`invalid` 只控制边框样式；错误文案仍由父组件渲染在编辑器下方。

代码节点换语言：仍由 `NodeConfigPanel` 的 `switchCodeLanguage` 处理（空或旧模板则换新模板）。编辑器不感知模板。

## 6. 异常与只读

- CodeMirror 用 `next/dynamic` 且 `ssr: false`，避免 Next 14 服务端渲染报错。
- 动态 import 失败：小窗和大窗都回退到现有样式的 `<textarea>`，放大按钮仍可用。不阻断保存工作流。
- 同一面板多个实例互不共享文档对象；value 受控，父级更新必须反映到编辑器（避免放大后关窗与面板不同步）。
- `readOnly`（版本浏览）：可放大、不可编辑、无「可编辑」暗示。
- 半成品 JSON 不在输入过程中打断；只在失焦 / 关大窗时提示。

## 7. 测试

无现成前端单测框架可依赖；本轮以手工验收为主，不新增测试栈。

1. 代码节点：小窗有高亮与行号；放大后修改，关窗后面板为同一段；换语言仍走原模板逻辑。
2. SQL / 事务多条：每条可独立放大，内容不串。
3. JSON：非法 JSON 失焦报错；整段 `{{template}}` 不报错；合法 JSON 仍存成对象（保存后刷新仍在）。
4. 只读版本页：能看、能放大、不能改。
5. 保存并运行含 code / SQL / transform 的工作流：config 形状与现在一致，执行结果与改前同类脚本一致。
6. 人为断掉 CM 的 dynamic import（或模拟 reject）：回退 textarea，仍能编辑和保存。

## 8. 依赖

在 `frontend-nextjs` 增加（实现时锁定当时稳定小版本）：

- `@uiw/react-codemirror`（React 绑定）
- `@codemirror/lang-javascript`
- `@codemirror/lang-python`
- `@codemirror/lang-sql`
- `@codemirror/lang-json`
- `@codemirror/legacy-modes`（Lua）
- `@codemirror/theme-one-dark`（代码节点深色；浅色用 CM 默认）

不引入 Monaco。不引入 highlight.js / Prism。
