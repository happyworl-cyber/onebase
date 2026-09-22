# Object Storage File Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project members (including viewers) can browse an existing object-storage connection and open the latest file content in `/workspace/:projectId/files`.

**Architecture:** Add a member-readable connection catalog GET (slim DTO, no secrets). The files page uses existing `exec` `list`/`get`/`presign` ops. Preview is a read-only CodeMirror viewer. Connection admin stays on the existing object-storage page.

**Tech Stack:** Rust/Axum handlers, Next.js App Router, CodeMirror 6 (`@codemirror/lang-xml`), existing `objectStorageAPI.exec`.

## Global Constraints

- Read-only UI: no upload, delete, rename, save, history, diff, or notify.
- Catalog: `GET /api/object-storage-connections?tenant_id=` — membership any; active connections only; DTO fields `id`, `tenant_id`, `connection_name`, `provider`, `bucket` only.
- File bytes still go through `POST /api/object-storage-connections/:id/exec`; do not change `get`/`put` 5 MiB semantics.
- Nav group 「文件」 after 「概览」, no `visibleIf`.
- Viewer empty-state must not link to the admin object-storage page; admin may link.
- Do not commit unless the user asks. Existing unrelated dirty files stay untouched.

---

### Task 1: Public connection DTO

**Files:**
- Modify: `src/object_storage_ds/models.rs`

**Interfaces:**
- Produces: `ObjectStorageConnectionPublic { id: i64, tenant_id: i32, connection_name: String, provider: String, bucket: String }` with `From<&ObjectStorageConnection>`
- Produces: `require_catalog_tenant_id(tenant_id: Option<i32>) -> Result<i32>`

- [ ] **Step 1: Write the failing tests** in `models.rs` `#[cfg(test)]`:

```rust
#[test]
fn catalog_tenant_id_required() {
    assert!(require_catalog_tenant_id(None).is_err());
    assert_eq!(require_catalog_tenant_id(Some(42)).unwrap(), 42);
}

#[test]
fn public_dto_omits_secrets_and_ops_fields() {
    let row = /* same fixture as secret_not_serialized */;
    let public = ObjectStorageConnectionPublic::from(&row);
    let v = serde_json::to_value(&public).unwrap();
    assert_eq!(v["id"], 1);
    assert_eq!(v["connection_name"], "c");
    assert_eq!(v["bucket"], "b");
    assert!(v.get("access_key_id").is_none());
    assert!(v.get("secret_key_enc").is_none());
    assert!(v.get("endpoint").is_none());
    assert!(v.get("is_active").is_none());
}
```

- [ ] **Step 2: Run** `cargo test --lib public_dto_omits -- --nocapture` and `cargo test --lib catalog_tenant_id -- --nocapture`<br>
  Expected: FAIL (types/fns missing)

- [ ] **Step 3: Implement DTO + `require_catalog_tenant_id`** (InvalidQuery `"缺少 tenant_id"`)

- [ ] **Step 4: Re-run tests** — Expected: PASS

---

### Task 2: Catalog GET handler + route

**Files:**
- Modify: `src/object_storage_handlers.rs`
- Modify: `src/main.rs` (object_storage JWT router)

**Interfaces:**
- Consumes: `ObjectStorageConnectionPublic`, `require_catalog_tenant_id`, `permissions::require_tenant_membership_any`
- Produces: `list_catalog` → `GET /api/object-storage-connections?tenant_id=`

- [ ] **Step 1: Add handler** `list_catalog`: parse `ListConnectionsQuery.tenant_id` via `require_catalog_tenant_id`; `require_tenant_membership_any`; SQL:

```sql
SELECT id, tenant_id, connection_name, provider, bucket
FROM management.object_storage_connections
WHERE tenant_id = $1 AND is_active = true
ORDER BY connection_name ASC, id DESC
```

`query_as::<_, ObjectStorageConnectionPublic>`. Do not return inactive rows.

- [ ] **Step 2: Register route** on the same JWT `object_storage_admin_routes` router:

```rust
.route(
    "/api/object-storage-connections",
    get(object_storage_handlers::list_catalog),
)
```

Keep existing `POST /api/object-storage-connections/:id/exec`.

- [ ] **Step 3: Run** `cargo check --bin planeos`<br>
  Expected: success

---

### Task 3: Nav entry + tests

**Files:**
- Modify: `frontend-nextjs/components/workspace/workspaceNav.ts`
- Modify: `frontend-nextjs/components/workspace/workspaceNav.test.ts`

**Interfaces:**
- Produces: nav item `{ label: '文件', href: '/files', icon: 'fas fa-folder-open' }` in a new group immediately after 「概览」, no `visibleIf`

- [ ] **Step 1: Add failing assertion**

```ts
assert.deepEqual(resolveNavMeta('/files'), {
  label: '文件',
  icon: 'fas fa-folder-open',
})
```

- [ ] **Step 2: Run** `npx tsx frontend-nextjs/components/workspace/workspaceNav.test.ts`<br>
  Expected: FAIL (label 页面 / default icon)

- [ ] **Step 3: Insert NAV_GROUPS entry** after 概览

- [ ] **Step 4: Re-run test** — Expected: `workspaceNav tests passed`<br>
  Also `npx tsx frontend-nextjs/lib/helpCatalog.test.ts` — still pass (related href whitelist uses NAV_GROUPS)

---

### Task 4: Pure file-browser helpers

**Files:**
- Create: `frontend-nextjs/lib/objectStorageFiles.ts`
- Create: `frontend-nextjs/lib/objectStorageFiles.test.ts`

**Interfaces:**
- Produces: `previewLanguageFromKey(key: string): 'xml' | 'json' | 'text'`
- Produces: `fileDisplayName(key, prefix)`, `parentPrefix(prefix)`, `breadcrumbParts(prefix)`
- Produces: `isGetTooLargeError(message)`, `lastConnectionStorageKey(projectId)`
- XML extensions: `.xml` `.xsd` `.xsl` `.xslt` `.svg`

- [ ] **Step 1: Write tests** covering xml/json/text, breadcrumb, parent of `a/b/`, too-large substring `对象超过` + `presign`

- [ ] **Step 2: Run** `npx tsx frontend-nextjs/lib/objectStorageFiles.test.ts` — Expected: FAIL

- [ ] **Step 3: Implement helpers**

- [ ] **Step 4: Re-run** — Expected: `objectStorageFiles tests passed`

---

### Task 5: API client, viewer, files page

**Files:**
- Modify: `frontend-nextjs/lib/api.ts` (`listCatalog`)
- Create: `frontend-nextjs/components/files/FileContentViewer.tsx`
- Create: `frontend-nextjs/app/workspace/[projectId]/files/page.tsx`
- Modify: `frontend-nextjs/package.json` via `npm install @codemirror/lang-xml`

**Interfaces:**
- Consumes: `objectStorageAPI.listCatalog(tenantId)`, `objectStorageAPI.exec(id, { op, args })`
- URL query: `connection`, `prefix`, `key`
- Exec list args: `{ prefix, delimiter: '/', max_keys: 100, continuation_token? }`
- Exec get args: `{ key }`
- Exec presign args: `{ key, method: 'GET' }`; open `result.url`

Layout: toolbar (connection select, breadcrumb, refresh) | left list (prefixes then objects) | right viewer.

Behaviors from spec §§5–8: always re-get on open/refresh; binary/`content_base64` → no preview + download; too-large error → no preview + download; empty catalog copy for viewer vs admin; no write controls.

- [ ] **Step 1:** `npm install @codemirror/lang-xml --prefix frontend-nextjs`

- [ ] **Step 2:** Add types + `listCatalog` on `objectStorageAPI`

- [ ] **Step 3:** `FileContentViewer` read-only CodeMirror (xml/json) or `<pre>` for text

- [ ] **Step 4:** Files page wiring URL + localStorage last connection + list/get/presign

- [ ] **Step 5:** `npx tsc --noEmit` in frontend-nextjs (fix errors in touched files). Re-run helper + nav tests.

---

## Spec coverage

| Spec | Task |
|---|---|
| Member catalog GET, slim DTO, active only, tenant_id required | 1–2 |
| Nav 「文件」 after 概览, all members | 3 |
| Browse delimiter=/, breadcrumb, refresh, shareable URL | 4–5 |
| XML/JSON/text preview; binary and >5MiB download | 4–5 |
| Viewer empty state no 403 link | 5 |
| No write/history/diff; exec unchanged | 5 |
