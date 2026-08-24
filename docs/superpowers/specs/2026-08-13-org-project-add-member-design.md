# 租户控制台：加入项目成员（选已有 + 新增）

**日期：** 2026-08-13  
**状态：** 已实现  
**范围：** 组织控制台「项目」列表的「加入成员」弹窗 + 组织侧入项目 API

## 背景

当前「加入项目成员」只能从**已是本租户的成员**下拉选择。实际运维需要：

1. 选租户内已有成员加入项目（现状）
2. 搜索平台上已有、但还不是本租户成员的用户，一步入租户 + 入项目
3. 直接新建平台账号并加入租户 + 项目

工作区「成员管理」已有「搜已有 / 新建账号」，但鉴权是项目 admin；租户 admin 未必是该项目成员，不能直接复用 `POST /api/projects/:id/members/create-user`。

## 目标

在租户控制台用一次操作完成三种加人路径，鉴权统一为组织 admin+，不要求调用方已是项目成员。

## 非目标

- 租户「成员」页增加新建账号（仍只搜平台用户加入租户）
- 邮件邀请 / SSO 拉人
- 改工作区成员页逻辑
- 批量加人

## UI

「加入成员」弹窗三模式切换（样式对齐工作区成员页 segmented control）：

| Tab | 行为 |
|-----|------|
| **租户成员** | 下拉选本租户成员（现状） |
| **平台用户** | 搜索平台账号（`GET /api/organizations/:id/member-candidates`），选中后提交 |
| **新建账号** | 用户名 / 邮箱 / 初始密码 + 项目角色 |

共用：项目角色 `owner | admin | member | viewer`（owner 可选规则与现网弹窗一致）。

文案要点：

- 租户成员：从本租户选人加入该项目
- 平台用户：一步加入租户（org role 默认 `member`）+ 项目
- 新建：创建平台账号并加入租户 + 项目；初始密码线下告知，建议登录后修改

成功后关闭弹窗并刷新列表；若加入的是当前用户本人，保持现有进入工作区行为。

## API

### 扩展

`POST /api/organizations/:orgId/projects/:projectId/members`

鉴权：`require_organization_admin`。

Body **二选一**（互斥）：

```json
// 已有用户（租户成员或平台用户）
{ "user_id": 123, "role": "member" }

// 新建账号
{
  "username": "...",
  "email": "...",
  "password": "...",
  "role": "member"
}
```

可选字段 `org_role`（默认 `member`）：仅在目标用户**尚不是**租户成员时用于写入 `organization_members`。若请求 `org_role=owner`，调用方须为 org owner（或超管），与「成员」页授予 owner 规则一致。v1 UI 可不暴露 `org_role`。

### 行为

1. 校验项目属于该组织且 `status = active`
2. **`user_id` 路径**
   - 用户必须存在
   - 若非活跃租户成员：upsert 入 `organization_members`（`org_role`，默认 `member`）
   - upsert 入 `user_tenants`（项目角色）+ `sync_default_rbac_role`
3. **新建路径**
   - 校验：用户名 ≥3、邮箱合法、密码 ≥6；用户名/邮箱唯一
   - 建 `users`（role=`user`）→ 入租户 → 入项目 → RBAC  
   - 与 `create_project_member` 同口径，但鉴权为组织 admin
4. 已是项目成员：upsert 更新项目角色（与现网一致）

### 错误

沿用现有中文错误：`InvalidQuery` / `NotFound` / `Forbidden`（邮箱占用、用户名占用、项目不属组织、非法角色等）。

### 前端映射

| Tab | 调用 |
|-----|------|
| 租户成员 | 扩展后的 POST + `user_id` |
| 平台用户 | `member-candidates` 搜索 → POST + `user_id` |
| 新建账号 | POST + username/email/password/role |

不新增独立 `create-user` 组织路由（合并进上述 POST，减少表面积）。

## 默认策略

- 经「平台用户 / 新建」补入租户时，`org_role` 默认 `member`
- 不发邀请邮件；初始密码线下告知
- 不改工作区 `create-user` / `add` 接口行为

## 测试要点

- 租户 admin（非项目成员）可为下属项目：加租户成员 / 加平台用户 / 新建账号
- 平台用户路径：目标用户从非租户成员变为 org `member` + 项目角色正确
- 新建：账号可登录；已在 org + project；邮箱/用户名冲突有友好错误
- 非 org admin 调用 → 403
- 项目不属于该 org → 404
- 授予 `org_role=owner` 时非 owner → 403（若 API 支持该字段）
