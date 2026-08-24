# Organization → Project Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有「项目 ≡ tenants」之上新增 Organization（租户）层，支持一租户多项目与两级成员，存量 1:1 迁移。

**Architecture:** 新增 `management.organizations` / `organization_members`；`tenants.organization_id` 指向组织；资源表 FK 不动。后端新增 Organization API；项目 API 兼容并增加组织字段与加人校验。前端改为「租户选择 → 项目选择 → workspace」。

**Tech Stack:** PostgreSQL migrations、Rust/Axum/sqlx、Next.js/Zustand

**Spec:** `docs/superpowers/specs/2026-08-12-organization-project-hierarchy-design.md`

## Global Constraints

- `tenant_id` / `X-Tenant-Id` 语义仍 = **project id**
- 资源（DB/Key/SSO/工作流）不上提到组织
- 两级成员：项目成员前提是组织成员
- Org admin 不自动进入全部项目；`?view=all` 仅管理视图
- 存量：每项目 → 一同名组织；`viewer`/`member` → org `member`
- 创建组织仅平台超管；项目必须挂在已有 organization_id 下

## File Structure

| File | Responsibility |
|------|----------------|
| `migrations/060_organizations.sql` | orgs / members / tenants.organization_id + backfill |
| `src/migrate.rs` | 注册 060 |
| `src/permissions.rs` | org 角色校验 helpers；项目 membership 双 active 护栏 |
| `src/organization_handlers.rs` | Organization CRUD / members / projects |
| `src/tenant_handlers.rs` | 项目响应带 org；加人校验；provision 支持 organization_id |
| `src/main.rs` | 注册 org 路由与 mod |
| `frontend-nextjs/lib/store.ts` | `Organization` + `currentOrganization` |
| `frontend-nextjs/lib/api.ts` | organizationAPI |
| `frontend-nextjs/lib/permissions.ts` | org capabilities |
| `frontend-nextjs/app/workspace/page.tsx` | 先选租户再选项目 |
| `frontend-nextjs/components/workspace/ProjectTopbar.tsx` | 展示租户/项目切换 |
| `frontend-nextjs/app/workspace/provision/page.tsx` | 带 organization_id |
| `frontend-nextjs/app/platform/*` | 组织维度文案（P2） |

---

### Task 1: Migration 060 + backfill

**Files:** `migrations/060_organizations.sql`, `src/migrate.rs`

- [x] Create tables + backfill + NOT NULL
- [x] Register in migrate.rs
- [x] Verify: every tenant has organization_id; project members have org membership

### Task 2: Organization permission helpers

**Files:** `src/permissions.rs`

- [x] `ORG_ADMIN_ROLES`, `is_organization_admin/member`, `require_organization_admin/member/owner`
- [x] `require_project_access` / tighten membership checks to require org membership
- [x] `ensure_org_member_for_project_add(user_id, project_id)`

### Task 3: Organization handlers + routes

**Files:** `src/organization_handlers.rs`, `src/main.rs`

- [x] list/create/get/patch orgs
- [x] members CRUD
- [x] list/create projects under org
- [x] Wire routes under `/api/organizations`

### Task 4: Project API compatibility (P0)

**Files:** `src/tenant_handlers.rs`

- [x] list/get project include `organization_id`, `organization_name`
- [x] optional `organization_id` filter on list
- [x] add/create member: require target is org member (create-user: also insert org membership)
- [x] get_project / require paths: dual membership for non-superadmin
- [x] provision: **require** `organization_id`（禁止隐式建租户）

### Task 5: Frontend org → project nav (P1)

**Files:** store, api, permissions, workspace page, Topbar, provision

- [x] Organization type + API client
- [x] Picker: orgs first, then projects for selected org
- [x] Topbar: org name + project switcher scoped to org
- [x] Provision under current org

### Task 6: P2 converge

- [x] Mark legacy provision-without-org deprecated in docs/logs
- [x] Platform copy: distinguish 组织 vs 项目 where obvious
- [x] Spec status → implemented

---

## Acceptance

- Migrated users enter old projects
- Second project under same org works; non-members blocked
- Legacy headers/APIs still work
- Keys/pools/workflows still scoped by tenant_id (project)
