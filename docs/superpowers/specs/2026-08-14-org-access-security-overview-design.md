# 租户控制台：访问矩阵 + 安全总览

**日期：** 2026-08-14  
**状态：** 已实现  
**范围：** `/org/[orgId]` 新增「访问」「安全总览」；两个组织侧只读聚合 API

## 背景

租户控制台已有项目、成员、观测与设置，但缺少：

1. **成员 × 项目**对照——谁进了哪些项目、谁还没进  
2. **跨项目安全/集成摘要**——各项目 API Key / Webhook / SSO / IdP / 连接是否配齐  

凭证仍绑项目（`tenant_id`）；本功能只做**总览 + 深链 / 快捷加人**，不把资源上提到租户。

## 目标

组织 admin+ 在控制台一眼看清访问缺口与安全配置覆盖度，并能跳进工作区或快捷把成员加入项目。

## 非目标

- 矩阵内改角色、批量加人  
- 在总览页创建/删除 API Key、Webhook、SSO  
- 租户级统一 SSO  
- 工作流 / 定时任务配置总览  
- 计费、配额、品牌  

## UI

侧栏（`OrgNavId`，可见性同 `canViewOrgLogs` / org admin+）：

| 导航 | 说明 |
|------|------|
| **访问** | 成员 × 项目角色矩阵 |
| **安全总览** | 每项目安全/集成计数 |

### 访问

- 行：组织活跃成员；列：组织活跃项目（横向滚动）  
- 单元格：项目角色或「—」  
- 点击空单元格：打开现有「加入项目成员」弹层，预填该 `user_id`、模式=`org`  
- v1 不在矩阵内修改已有角色  
- 顶部摘要：成员数、项目数；可选筛选「未加入任何项目的成员」

### 安全总览

表格列：项目 | API Key | Webhook | SSO | IdP | DB 连接 | 操作  

- 数字为计数；0 显示 `0` 或「—」  
- 「打开」深链至 `/workspace/{id}/security/api-keys`（及同类入口可按列扩展）  
- 只读  

## API

鉴权：`require_organization_admin`。

### `GET /api/organizations/:id/member-project-matrix`

```json
{
  "organization_id": 1,
  "members": [
    { "user_id": 1, "username": "...", "email": "...", "org_role": "admin" }
  ],
  "projects": [
    { "id": 10, "name": "...", "slug": "..." }
  ],
  "cells": [
    { "user_id": 1, "project_id": 10, "role": "admin" }
  ]
}
```

- 仅 active 成员 / active 项目  
- 无 `user_tenants` 关系则不出现在 `cells`  

### `GET /api/organizations/:id/security-overview`

```json
{
  "organization_id": 1,
  "projects": [
    {
      "id": 10,
      "name": "...",
      "slug": "...",
      "api_keys": 3,
      "webhooks": 1,
      "sso_providers": 0,
      "idp_providers": 1,
      "databases": 1
    }
  ]
}
```

计数按 `tenant_id IN organization_project_ids`，来源：

| 字段 | 表 |
|------|-----|
| `api_keys` | `management.api_keys` |
| `webhooks` | `management.webhooks` |
| `sso_providers` | `management.sso_providers` |
| `idp_providers` | `management.project_idp_providers` |
| `databases` | `management.tenant_databases`（`is_active`） |

v1 不分页（单组织项目数预期有限）。

## 前端

- `OrgSidebar` 增加 `access` / `security-overview`  
- 新组件：`OrgAccessMatrixView.tsx`、`OrgSecurityOverviewView.tsx`  
- `organizationAPI.memberProjectMatrix` / `securityOverview`  
- 复用现有加入项目弹层状态（预填 `projectAddUserId` + `projectAddTarget`）

## 测试要点

1. Org admin：两 Tab 有数据；空矩阵/空项目不报错  
2. Org member（非 admin）：侧栏无入口；API 403  
3. 矩阵空格加人成功后刷新单元格有角色  
4. 安全计数与单项目工作区列表一致（抽样）  
5. 他组织项目不出现在结果中  

## 与既有文档关系

延续 `2026-08-12-organization-project-hierarchy`：资源仍绑项目；本功能是组织侧**只读聚合视图**，不是资源上提。
