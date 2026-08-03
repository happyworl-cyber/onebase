# 工作区多 Tab 保活 —— 设计

日期：2026-07-03
状态：已批准，进入实现

## 背景与问题

工作区（`/workspace/[projectId]/*`）是 Next.js App Router，每个功能是独立路由，
壳 `layout.tsx` 用 `<main>{children}</main>` 渲染当前页。导航到别的功能时，Next
会卸载（unmount）旧页面，导致其全部状态丢失：正在跑的查询、未保存的表单输入、
滚动位置都没了，想回到原状态只能重新打开并重来。

## 目标

- 支持同时打开多个功能页，以 Tab 形式呈现，可自由切换。
- **完全保活**：切走再切回，页面处于原样（跑着的请求、未保存输入、滚动位置全保留），
  体验等同浏览器多标签。
- 现有功能页面**零改动**。

## 非目标（YAGNI）

- Tab 拖拽排序（v1 不做）。
- Tab 数量硬上限。
- 跨项目共享 Tab（Tab 按项目隔离）。

## 方案：Layout 级 keep-alive 缓存

在项目壳 layout 内维护“已打开路由 → 页面元素”的缓存，把每个打开过的页面保持
挂载、用 CSS 隐藏非激活的，只显示当前 Tab。Next.js App Router 在子路由切换时会
保留 layout 自身状态，因此这一做法契合框架，无需绕过路由，URL 与前进/后退照常。

### 核心机制（KeepAliveOutlet）

- 维护 `Map<path, ReactNode>`。
- **某路由首次进入时**把它的 `children` 元素缓存下来；之后再切回该 Tab 时
  **复用同一个元素引用**（忽略 Next 新生成的 children）。同一引用 → React 不卸载
  → 状态/滚动/在途请求全部保留。
- 非激活面板用 `display:none` 隐藏但仍挂载；只有关闭 Tab 时才从缓存移除（真正销毁）。
- 关键坑：若切回时用 Next 新生成的 children 覆盖缓存，会触发 remount 丢状态。
  因此“已存在的缓存不覆盖”。

## 组件 / 文件

1. `lib/workspaceTabs.ts`（Zustand store）
   - 状态：`tabs: { path, title, icon }[]`、`activePath`。
   - 动作：`openTab(path, meta)`、`closeTab(path)`、`setActive(path)`、`closeOthers(path)`、`resetForProject(projectId)`。
   - 按项目 id 持久化到 `sessionStorage`（刷新后 Tab 栏恢复）。沿用 store.ts 的手动
     sessionStorage 同步风格（不引入 persist 中间件）。

2. `components/workspace/workspaceNav.ts`
   - 把当前写在 `WorkspaceSidebar.tsx` 里的 `NAV_GROUPS` 抽出为共享模块，
     导出 `NAV_GROUPS`、类型与 `resolveNavMeta(relPath): { label, icon }`。
   - Sidebar 与 TabBar 共用同一份标题/图标来源（单一信源）。
   - 未知/详情路由（如 `/database/tables/:id`）：按已知前缀匹配最长项取标题，
     再不行用末段兜底，图标给默认。

3. `components/workspace/WorkspaceTabBar.tsx`
   - 渲染 Tab 条：图标 + 标题 + 关闭 ×；横向溢出可滚动。
   - 交互：点 Tab = `setActive + router.push`；× 或中键 = `closeTab`；激活态高亮。

4. `components/workspace/KeepAliveOutlet.tsx`
   - 入参：`activePath`、`openPaths`、`children`。
   - 按上文机制渲染所有已打开面板，仅激活面板可见。
   - 每个面板容器负责自己的 `overflow-auto` 与内边距（原 main 的 `p-6 overflow-auto`
     下沉到面板）。

5. `app/workspace/[projectId]/layout.tsx`
   - `<main>{children}</main>` → `顶栏 → <WorkspaceTabBar/> → <KeepAliveOutlet>{children}</KeepAliveOutlet>`。
   - 监听 `usePathname`：变化时 `openTab + setActive`（标题/图标来自 `resolveNavMeta`）。
   - 切换项目（projectId 变化）时 `resetForProject`。

## 数据流

侧栏点击 / 直接输入 URL → `pathname` 变化 → layout 自动 `openTab + setActive`
→ `KeepAliveOutlet` 首次缓存该页并常驻 → 点 Tab = `setActive + router.push`
→ Outlet 显示对应缓存面板。现有页面无需感知 Tab 的存在。

## 行为默认值

- 关闭最后一个 Tab：自动回到并打开「项目首页」，不出现空白。
- 关闭激活 Tab：激活相邻 Tab（优先右侧，无则左侧）。
- 刷新(F5)：Tab 栏从 sessionStorage 恢复；当前 Tab 实时加载，其它 Tab 点击时再加载。
- 同一路由只对应一个 Tab（按 path 去重）。

## 错误处理 / 边界

- 未知路由标题：`resolveNavMeta` 兜底，不抛错。
- `display:none` 隐藏面板的内部滚动：现代浏览器一般保留 `scrollTop`；若个别页面
  出问题，改用“移出视口（绝对定位到屏幕外）”方式兜底。
- 内存随打开 Tab 增长：由用户关闭回收，符合多标签心智。

## 测试

- 前端当前无测试运行器（package.json 仅 dev/build/start/lint）。本次不新增测试
  基建（超出范围）。`workspaceTabs` 逻辑保持纯函数化、易读，靠 `tsc` 类型检查
  与手动验收清单保证质量。
- 手动验收清单：
  1. 打开 A（SQL 编辑器）输入 SQL 并跑出结果 → 打开 B → 切回 A：SQL 与结果仍在。
  2. A 页面滚动到底 → 切走再切回：滚动位置保留。
  3. 关闭激活 Tab：激活相邻 Tab；关闭最后一个：回到项目首页。
  4. F5 刷新：Tab 栏恢复。
  5. 切换项目：Tab 重置为该项目。
  6. 直接输入未在菜单中的深层 URL：也能作为一个 Tab 打开且有合理标题。
