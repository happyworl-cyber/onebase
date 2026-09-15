# 对象存储文件浏览（只读最新内容）

- 日期：2026-09-15
- 状态：已实现（2026-09-15）
- 相关代码：
  - `frontend-nextjs/components/workspace/workspaceNav.ts`
  - `frontend-nextjs/app/workspace/[projectId]/events/object-storage-connections/page.tsx`（连接管理，本期不改职责）
  - `frontend-nextjs/lib/api.ts`（`objectStorageAPI`）
  - `src/object_storage_handlers.rs`（`list_connections` 仅 admin；`exec` 读操作已对任意成员开放）
  - `src/object_storage_ds/commands.rs`（`list` / `get` / `presign`，`get` 上限 5 MiB）
  - `frontend-nextjs/components/workflow/CodeSnippetMirror.tsx`（CodeMirror 6，无 XML 语言；文件预览不复用该组件）

## 1. 背景与目标

用户要维护一批经常改动的 XML（及少量其它文本）文件。改动在 OneBase **之外**完成（编辑器或其它系统覆盖写入对象存储）。OneBase 只做查看入口：打开时读到的是对象存储里该 key 的**当前内容**。改的人和看的人可以不是同一人。不需要变更通知、版本历史、diff。

OneBase 已有对象存储连接（MinIO / COS / OSS / GCS）和 `list` / `get` / `presign`。现有「集成 → 对象存储」页是 admin 用的连接控制台（JSON exec），普通成员进不去，也不适合当日常打开 XML 的界面。

**目标**：项目工作区提供独立的「文件」页。成员选择已有连接，按前缀/文件夹浏览，点开看最新正文（XML 高亮只读）。

### 已确认需求

| 项 | 结论 |
|---|---|
| 源 | 已有对象存储连接；打开即 `get` 当前 key |
| 改 | 在别处改；OneBase 本页不提供编辑/上传/删除 |
| 看 | 工作区文件浏览器：列表 + 点开正文 |
| 最新 | 每次打开/刷新重新拉取，不缓存正文 |
| 通知 | 不做 |
| 历史 / diff | 不做 |
| 谁能看 | 项目成员（含 viewer） |
| 谁管连接 | 仍是 admin，「对象存储」页不变 |

### 非目标

- 在 OneBase 里改文件、保存、格式化写回
- Git、对象版本、对比任意两版
- 变更通知、审阅流、按文件 ACL
- XML 树编辑、XSD 校验、XSLT
- 新建对象存储连接（空状态只提示管理员去配置）
- 新的「文件实体」表或独立文件 API（正文仍走现有 exec）
- 把浏览功能塞进现有对象存储控制台

## 2. 关键决定

| 决定 | 选择 | 理由 |
|---|---|---|
| 入口 | 侧栏独立「文件」，不对 `canManageEvents` 设门槛 | 「集成」整组 admin-only；查看人进不去 |
| 页 | 新路由 `/workspace/:projectId/files`，不改连接控制台 | 运维配连接 vs 成员看文件，受众不同 |
| 读接口 | 继续 `POST /api/object-storage-connections/:id/exec` 的 `list` / `get` / `presign` | 已对任意成员开放读；5 MiB `get` 上限已有 |
| 连接下拉 | 新增成员可读的连接目录 API（瘦 DTO，无密钥） | 现有 `GET /api/admin/object-storage-connections` 只给 admin，成员无法列出连接 |
| 列表 | `delimiter=/` + `prefix` + continuation | S3 已支持 `common_prefixes`，可按文件夹逛 |
| 预览 | 只读 CodeMirror；`.xml` 等用 `@codemirror/lang-xml` | 项目已有 CodeMirror；不把 workflow 的 `CodeSnippetMirror` 语言表撑乱 |
| 过大/非文本 | 不预览，presign GET 下载 | 与现有 `MAX_BODY_BYTES`（5 MiB）和二进制 `content_base64` 行为一致 |
| 分享 | URL 带 `connection`、`prefix`、`key` | 改的人把链接发给看的人，打开即同一文件的最新内容 |

## 3. 架构

```
侧栏「文件」（全体项目成员）
        │
        ▼
/workspace/:projectId/files
        │
        ├─ GET  /api/object-storage-connections?tenant_id=   连接目录（瘦 DTO）
        └─ POST /api/object-storage-connections/:id/exec
                list  { prefix, delimiter: "/", max_keys, continuation_token }
                get   { key }          → UTF-8 content
                presign { key, method: "GET" }  → 大文件/非文本下载
        │
        ▼
已有 object_storage_ds::commands（不改语义）
        │
        ▼
对象存储桶（别处覆盖写同一 key）
```

「集成 → 对象存储」仍只做连接 CRUD / 令牌 / JSON 调试，权限仍是 admin。

## 4. 权限与连接目录

### 4.1 现状缺口

| API | 谁能调 | 文件页是否够用 |
|---|---|---|
| `GET /api/admin/object-storage-connections` | 超管 / 租户 owner-admin | 否。member/viewer 得到空列表或 403 |
| `POST /api/object-storage-connections/:id/exec` 读（`list`/`get`/GET `presign`） | 任意项目成员 | 是 |
| 同路径写（`put`/`delete`/PUT `presign`） | member+（viewer 拒） | 本页不调用 |

成员只要知道 `connection_id` 就能 `exec` 读。文件页的下拉框还需要一份**不含密钥**的连接列表。

### 4.2 新 API

`GET /api/object-storage-connections?tenant_id=<projectId>`

- 鉴权：`require_tenant_membership_any`（与 exec 读相同）。`tenant_id` 必填，且必须等于该项目。
- 只返回该租户、`is_active = true` 的连接。
- 响应瘦 DTO，**不含** `access_key_id`、`secret_key_enc`、超时等运维字段：

```json
[
  {
    "id": 1,
    "tenant_id": 42,
    "connection_name": "配置桶",
    "provider": "minio",
    "bucket": "configs"
  }
]
```

不在本页暴露停用连接。密钥解密路径不变，仍只发生在 exec 建连时。

## 5. 页面

路由：`/workspace/:projectId/files`

查询参数（均可缺省）：

| 参数 | 含义 |
|---|---|
| `connection` | 连接 id |
| `prefix` | 当前「目录」（S3 prefix，建议以 `/` 结尾或空表示桶根） |
| `key` | 当前打开的对象 key |

解析顺序：URL 优先；否则用该项目上次选择的 `connection`（`localStorage`，key 带 `projectId`）；否则目录里第一项。改连接/进目录/打开文件时同步写回 URL，便于复制链接。

布局（与工作区其它页同一套顶栏 + 左右分栏）：

1. **顶栏**：连接下拉；当前 `prefix` 面包屑（可回到上级）；刷新（重新 `list`，若已打开文件则重新 `get`）。
2. **左列**：当前 prefix 下的 `common_prefixes`（进子目录）和 `objects`（点开）。展示文件名（key 去掉当前 prefix）、`size`、`last_modified`。`is_truncated` 时用 `next_continuation_token` 加载更多。
3. **右列**：选中文件后 `get`。展示规则见 §6。未选文件时给简短说明。

空状态：

- 无连接：文案「请让项目管理员在「集成 → 对象存储」中配置连接」。**viewer 不链到会 403 的连接页**；admin 可以给链。
- 目录为空：「这个目录下没有文件」（不是错误）。

本页控件不含：上传、删除、重命名、保存、历史、diff。

## 6. 正文预览

每次打开或刷新都请求 `get`，不用上次结果当「最新」。

| 情况 | 行为 |
|---|---|
| UTF-8 文本，且扩展名为 `.xml` / `.xsd` / `.xsl` / `.xslt` / `.svg` | 只读 CodeMirror + XML 高亮；原文展示，不 pretty-print、不写回 |
| UTF-8 文本，扩展名为 `.json` | 只读 CodeMirror + 已有 JSON 高亮 |
| 其它 UTF-8 文本 | 只读等宽文本（可无语言包） |
| `get` 返回 `content_base64`（非 UTF-8） | 不预览；说明「不是文本」，提供下载 |
| 对象大于 5 MiB（现有 `get` 拒绝） | 不预览；说明体积超限，提供下载 |
| 下载 | `presign` + `method: GET`，新标签打开或触发浏览器下载 |

预览组件独立（例如 `FileContentViewer`），`readOnly`，不要接到工作流节点的保存回调上。允许新增依赖 `@codemirror/lang-xml`。

## 7. 导航与帮助

在 `NAV_GROUPS` 里、「集成」与「安全」之间增加一组，无 `visibleIf`（项目成员都能看见）：

```
label: 文件
href:  /files
icon:  文件夹类图标（与现有 Font Awesome 用法一致）
```

Tab 标题走现有 `resolveNavMeta`。`helpCatalog.test.ts` 用 `NAV_GROUPS` 的 href 做 related 白名单，加入口即可，**不强制**新增帮助文章。若以后要在「集成」帮助里链到本页，related `href` 必须是 `/files`。

前端 `workspaceNav.test.ts` 若断言分组数量/路径，一并更新。

## 8. 错误

错误展示在列表区或右侧预览区，不把失败画成空目录。

| 情况 | 表现 |
|---|---|
| 非项目成员 | 与其它工作区页相同的禁止占位；不列出 key |
| 连接目录失败 | 顶栏错误；下拉为空 |
| `connection` 指向停用/不存在/非本租户 | 明确错误，不静默落到另一条连接 |
| `list` / `get` / `presign` 失败 | 展示后端错误原文 |
| 对象已删 | `get` 失败提示不存在；用户可刷新列表 |
| 超 5 MiB / 非 UTF-8 | §6，不是通用 toast 了事 |

不在文件页创建或修改连接。

## 9. 测试与验收

后端：连接目录 API — 成员/viewer 能列出本租户活跃连接且无密钥字段；非成员 403；不能用其它 `tenant_id` 扫连接。

前端 / 手工（主路径必须点开文件，不能只截列表）：

1. viewer 能进「文件」；admin 仍能进「对象存储」管连接。
2. 选连接后能按文件夹浏览，点 XML 看到高亮正文。
3. 在桶外改同一 key，刷新或重新打开后正文是新内容。
4. 带 `connection`+`key` 的 URL 给另一成员，打开即该文件最新内容。
5. 页上无上传、删除、保存、历史、diff。
6. 大文件与非文本：无法预览 + 可下载。
7. 无连接时的空状态不把 viewer 带到 403 页。

## 10. 文件改动范围（实现时）

| 区域 | 改动 |
|---|---|
| `src/object_storage_handlers.rs` + `src/main.rs` | 注册成员连接目录 GET；瘦 DTO |
| `frontend-nextjs/lib/api.ts` | 封装该 GET；文件页只对 exec 调 `list`/`get`/`presign` |
| `frontend-nextjs/app/workspace/[projectId]/files/page.tsx`（及必要子组件） | 浏览器 UI |
| `frontend-nextjs/components/workspace/workspaceNav.ts` | 「文件」入口 |
| `frontend-nextjs/package.json` | `@codemirror/lang-xml` |
| 连接控制台页 | **不改职责**；不在此页做文件浏览器 |

不改 `commands.rs` 的 op 语义与 5 MiB 上限（除非实现中发现 list 缺字段，才做最小补齐）。
