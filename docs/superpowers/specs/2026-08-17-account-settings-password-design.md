# 账号设置：个人修改密码

**日期：** 2026-08-17  
**状态：** 已实现  
**范围：** 独立页 `/account` + 各控制台用户菜单入口；改密复用现有 API，并补齐新密码强度校验

## 背景

后端已有 `POST /auth/change-password`：校验当前密码、更新哈希、清除 `must_change_password`、吊销该用户其它活跃会话（保留当前会话）。

前端已有 `/change-password`，但只用于**强制改初始密码**（登录后 `must_change_password=true`，或 API 返回 `password_change_required`）。文案是「修改初始密码」，没有返回入口。

工作区顶栏、平台侧栏、租户侧栏的用户菜单目前只有「退出登录」（超管另有平台相关链接）。普通用户没有自愿改密的地方。成员管理里会提示「建议其登录后自行修改密码」，但对应 UI 不存在。

## 目标

已登录用户可从任意主要控制台进入「账号设置」，查看只读账号信息并修改自己的密码。

## 非目标

- 修改用户名 / 邮箱
- 会话列表或手动踢其它设备（改密接口已吊销其它会话，本页只提示）
- 忘记密码 / 邮箱重置
- 把 `/change-password` 与账号设置合成同一页
- 在项目选择页、无项目引导页再加入口

## 结构

- 新增独立路由 `/account`，不套项目 / 平台 / 组织 layout。
- 已登录可打开；未登录跳 `/login`。
- 若 `must_change_password=true`，沿用现有拦截，继续去 `/change-password`，不能进账号页。
- `/change-password` 只负责强制改初始密码：文案、不能返回、成功后跳工作区/平台，均不改。
- 改密仍走 `POST /auth/change-password`。请求体不变：`{ old_password, new_password }`。

## 页面

`/account` 做成设置页（浅底 + 顶栏 + 卡片），不用登录页那种全屏渐变卡。

**顶栏：** 返回 + 标题「账号设置」。若 `document.referrer` 与当前站点同源，则 `history.back()`；否则超管去 `/platform`，其他人去 `/orgs`（避免无历史或从站外打开时把用户送出站点）。

**卡片一 · 账号信息（只读）**

- 用户名、邮箱，来自已登录的 `currentUser`
- 不提供编辑

**卡片二 · 修改密码**

| 字段 | 规则 |
|------|------|
| 当前密码 | 必填 |
| 新密码 | 至少 8 位，含大写、小写、数字；不能与当前密码相同 |
| 确认新密码 | 必须与新密码一致 |

- 前端先校验，不通过不发请求。
- 提交成功：留在本页，清空表单，显示成功提示；若响应 `other_sessions_revoked > 0`，一并写明其它设备已退出。
- 不强制重新登录（当前会话保留）。
- 用户用顶栏返回，不另做「取消」跳转。

## 入口

在「退出登录」上方增加「账号设置」，链到 `/account`：

| 位置 | 组件 | 出现场景 |
|------|------|----------|
| 项目工作区顶栏 | `ProjectTopbar` | `/workspace/[projectId]/*` |
| 平台侧栏用户菜单 | `PlatformSidebar` | `/platform/*` |
| 租户控制台侧栏用户菜单 | `OrgSidebar` | `/org/[orgId]` |
| 旧版 dashboard 侧栏 | `SidebarV3` | `/dashboard/*`：把无效的「个人资料」改成「账号设置」并链到 `/account` |

不改：`/orgs` 选择页、`/workspace/no-projects`、`/change-password`。

## API 与校验

现有接口行为保持：验证旧密码 → 新旧不能相同 → 写新哈希并 `must_change_password = false` → 吊销其它会话。

补齐缺口：`change_password` 在写库前对新密码调用 `auth::validate_password`（与注册、管理员创建账号相同：≥8 位，含大小写和数字）。当前该接口只用 validator 检查了长度。强制改密页 `/change-password` 的前端仍可只查长度；弱密码会被后端拒绝，属预期，不改该页文案与跳转。

错误：

| 情况 | 表现 |
|------|------|
| 前端校验失败 | 表单内错误，不发请求 |
| 旧密码错误 | 沿用现有「旧密码错误」 |
| 新密码强度不够 | 后端 `InvalidQuery` 文案（与 `validate_password` 一致） |
| 其它接口失败 | 显示返回的 `error`；没有则「修改密码失败，请重试」 |

## 测试

- 给 `validate_password` 补单元测试：过短、缺大写/小写/数字失败；`Password123` 通过。
- 不新增需要数据库的 handler 集成测。
- 前端无单测框架：手工核对菜单入口、只读资料、校验与成功/失败提示、强制改密仍走 `/change-password`。
- 实现后跑现有认证相关 `cargo test`，确认登录 / 强制改密未回归。
