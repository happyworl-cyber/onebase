# Object Storage Workflow Node Implementation Plan

> **For agentic workers:** Follow tasks in order; verify each before next.

**Goal:** Ship `object_storage` workflow node (engine + editor + MCP), mirroring Redis/Kafka.

**Spec:** `docs/superpowers/specs/2026-08-11-object-storage-workflow-node-design.md`

## File map

| File | Change |
|------|--------|
| `src/workflow_engine.rs` | `NodeType::ObjectStorage` + `exec_object_storage_node` + match arm |
| `src/mcp_tools.rs` | Document `object_storage` node |
| `frontend-nextjs/components/workflow/NodeTypes.tsx` | Visual meta |
| `frontend-nextjs/components/workflow/WorkflowCanvas.tsx` | Palette + default config |
| `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` | `ObjectStorageNodeConfig` |
| Parent design §11 | Mark Phase 3 implemented |

## Tasks

1. Engine: enum + exec + dispatch  
2. MCP docs  
3. Frontend palette / types / config panel  
4. `cargo check --bin onebase` + smoke unit path if any  
