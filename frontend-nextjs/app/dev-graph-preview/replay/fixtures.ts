/**
 * Local mock fixture for the execution replay graph -- zero backend dependency, used to
 * verify rendering on the dev preview page.
 * Covers: the three states success/failed/skipped, a two-way conditional branch, an elapsed-
 * time heat gradient, 5 special-node badges (http_call/kafka/redis/call_workflow/sse_publish),
 * error-message display for a failed run, and run#3's three silent empty-response cases
 * (http 200 with empty body / kafka with no ack / db_execute with 0 rows affected).
 */

import type { WorkflowEdgeDef, WorkflowNodeDef } from '@/components/workflow/WorkflowCanvas'
import type { ReplayRunDetail, ReplayRunSummary } from '@/components/workflow/replay/replayApi'

export const MOCK_WORKFLOW_NODES: WorkflowNodeDef[] = [
  {
    id: 'fetch_user',
    type: 'http_call',
    label: 'Fetch user info',
    config: { method: 'GET', url: 'https://api.example.com/users/{{trigger.user_id}}', headers: { Authorization: 'Bearer {{env.API_TOKEN}}' } },
  },
  {
    id: 'check_tier',
    type: 'condition',
    label: 'Determine membership tier',
    config: {
      conditions: [{ branch: 'vip', expression: '{{fetch_user.body.tier}} == "vip"' }],
      default_branch: 'default',
    },
  },
  { id: 'apply_discount', type: 'code', label: 'Calculate discount', config: { language: 'lua', code: 'return { discount = 0.8 }' } },
  {
    id: 'publish_kafka',
    type: 'kafka',
    label: 'Send notification message',
    config: { connection_id: 3, op: 'produce', topic: 'order-events', key: '{{fetch_user.body.id}}', value: { event: 'discount_applied' } },
  },
  {
    id: 'save_order',
    type: 'db_execute',
    label: 'Write order',
    config: { sql: 'UPDATE orders SET discount = {{apply_discount.discount}} WHERE user_id = {{trigger.user_id}}', params: [] },
  },
  {
    id: 'call_sub_refund',
    type: 'call_workflow',
    label: 'Call refund sub-workflow',
    config: { workflow: 'refund-issue', input: { order_id: '{{save_order.id}}' }, allow_failure: false },
  },
  { id: 'publish_sse', type: 'sse_publish', label: 'Push to frontend', config: { topic: 'order/{{trigger.user_id}}', event: 'discount' } },
  {
    id: 'log_default',
    type: 'redis',
    label: 'Record regular user',
    config: { connection_id: 1, op: 'incr', key: 'stat:default_user_count' },
  },
  { id: 'respond', type: 'response', label: 'Return result', config: { status_code: 200, body: { ok: true } } },
]

export const MOCK_WORKFLOW_EDGES: WorkflowEdgeDef[] = [
  { from: 'fetch_user', to: 'check_tier' },
  { from: 'check_tier', to: 'apply_discount', branch: 'vip' },
  { from: 'check_tier', to: 'log_default', branch: 'default' },
  { from: 'apply_discount', to: 'publish_kafka' },
  { from: 'publish_kafka', to: 'save_order' },
  { from: 'save_order', to: 'call_sub_refund' },
  { from: 'call_sub_refund', to: 'publish_sse' },
  { from: 'publish_sse', to: 'respond' },
  { from: 'log_default', to: 'respond' },
]

/** run#2: vip branch, hits a slow DB write (900ms, hottest on the heatmap), the sub-workflow
 * call fails, and downstream nodes are skipped. */
const RUN_2_DETAIL: ReplayRunDetail = {
  id: 2,
  workflow_id: 1,
  status: 'failed',
  trigger_type: 'endpoint',
  elapsed_ms: 1585,
  started_at: '2026-08-19T10:15:00Z',
  completed_at: '2026-08-19T10:15:02Z',
  error_message: 'Sub-workflow refund-issue failed: connection timeout',
  final_output: null,
  node_results: [
    {
      node_id: 'fetch_user',
      node_type: 'http_call',
      status: 'success',
      elapsed_ms: 80,
      output: { status: 200, headers: { 'content-type': 'application/json' }, body: { tier: 'vip', id: 1001 } },
    },
    { node_id: 'check_tier', node_type: 'condition', status: 'success', elapsed_ms: 15, branch: 'vip', output: { matched: 'vip' } },
    { node_id: 'apply_discount', node_type: 'code', status: 'success', elapsed_ms: 350, output: { discount: 0.8 } },
    {
      node_id: 'publish_kafka',
      node_type: 'kafka',
      status: 'success',
      elapsed_ms: 50,
      output: { op: 'produce', result: { partition: 0, offset: 128 } },
    },
    { node_id: 'save_order', node_type: 'db_execute', status: 'success', elapsed_ms: 1200, output: { rows_affected: 1 } },
    {
      node_id: 'call_sub_refund',
      node_type: 'call_workflow',
      status: 'failed',
      elapsed_ms: 700,
      error: 'Sub-workflow refund-issue failed: connection timeout (3000ms)',
    },
    // For skipped nodes the backend always sets elapsed_ms to 0 (not null) -- this fixture
    // matches real data so we can verify the two fixes on the preview page: "heat coloring
    // doesn't cover the skipped gray box" and "the side panel doesn't show 0ms".
    { node_id: 'publish_sse', node_type: 'sse_publish', status: 'skipped', elapsed_ms: 0 },
    { node_id: 'respond', node_type: 'response', status: 'skipped', elapsed_ms: 0 },
  ],
}

/**
 * run#3: the vip branch succeeds all the way through, but 3 of its nodes are silent empty
 * responses -- "connection fine, no error, but no data came back": fetch_user returns 200 with
 * an empty body, publish_kafka delivers but gets no result back (no ack), and save_order's
 * UPDATE matches no rows (rows_affected=0). Used to verify the interplay between the empty-
 * response badge, the side-panel snapshot, and the overview stats.
 */
const RUN_3_DETAIL: ReplayRunDetail = {
  id: 3,
  workflow_id: 1,
  status: 'completed',
  trigger_type: 'endpoint',
  elapsed_ms: 261,
  started_at: '2026-08-20T09:00:00Z',
  completed_at: '2026-08-20T09:00:01Z',
  error_message: null,
  final_output: { ok: true },
  node_results: [
    {
      node_id: 'fetch_user',
      node_type: 'http_call',
      status: 'success',
      elapsed_ms: 45,
      input: { method: 'GET', url: 'https://api.example.com/users/1002', headers: { Authorization: 'Bearer xxx' } },
      output: { status: 200, headers: { 'content-type': 'application/json' }, body: null },
    },
    {
      node_id: 'check_tier',
      node_type: 'condition',
      status: 'success',
      elapsed_ms: 6,
      branch: 'vip',
      input: { 'fetch_user.body.tier': null },
      output: { matched: 'vip' },
    },
    {
      node_id: 'apply_discount',
      node_type: 'code',
      status: 'success',
      elapsed_ms: 30,
      output: { discount: 0.8 },
    },
    {
      node_id: 'publish_kafka',
      node_type: 'kafka',
      status: 'success',
      elapsed_ms: 15,
      input: { connection_id: 3, op: 'produce', topic: 'order-events', key: '1002', value: { event: 'discount_applied' } },
      output: { op: 'produce', result: null },
    },
    {
      node_id: 'save_order',
      node_type: 'db_execute',
      status: 'success',
      elapsed_ms: 60,
      input: { sql: 'UPDATE orders SET discount = 0.8 WHERE user_id = 1002', params: [] },
      output: { rows_affected: 0 },
    },
    {
      node_id: 'call_sub_refund',
      node_type: 'call_workflow',
      status: 'success',
      elapsed_ms: 90,
      input: { workflow: 'refund-issue', input: { order_id: null } },
      output: { status_code: 200, body: { refunded: true }, headers: {} },
    },
    {
      node_id: 'publish_sse',
      node_type: 'sse_publish',
      status: 'success',
      elapsed_ms: 10,
      output: { topic: 'order/1002', event: 'discount', delivered: 2 },
    },
    {
      node_id: 'respond',
      node_type: 'response',
      status: 'success',
      elapsed_ms: 5,
      output: { status_code: 200, body: { ok: true } },
    },
  ],
}

/** run#1: default branch, succeeds all the way through a different path (used to verify the
 * branch highlight switches when the selected run changes). */
const RUN_1_DETAIL: ReplayRunDetail = {
  id: 1,
  workflow_id: 1,
  status: 'completed',
  trigger_type: 'endpoint',
  elapsed_ms: 113,
  started_at: '2026-08-18T09:00:00Z',
  completed_at: '2026-08-18T09:00:01Z',
  error_message: null,
  final_output: { ok: true },
  node_results: [
    {
      node_id: 'fetch_user',
      node_type: 'http_call',
      status: 'success',
      elapsed_ms: 60,
      output: { status: 200, headers: { 'content-type': 'application/json' }, body: { tier: 'normal', id: 1002 } },
    },
    { node_id: 'check_tier', node_type: 'condition', status: 'success', elapsed_ms: 8, branch: 'default', output: { matched: 'default' } },
    { node_id: 'log_default', node_type: 'redis', status: 'success', elapsed_ms: 35, output: { op: 'incr', result: 5 } },
    { node_id: 'respond', node_type: 'response', status: 'success', elapsed_ms: 10, output: { status_code: 200, body: { ok: true } } },
  ],
}

export const MOCK_RUNS: ReplayRunSummary[] = [
  {
    id: 3,
    workflow_id: 1,
    status: 'completed',
    trigger_type: 'endpoint',
    elapsed_ms: 261,
    started_at: '2026-08-20T09:00:00Z',
    completed_at: '2026-08-20T09:00:01Z',
  },
  {
    id: 2,
    workflow_id: 1,
    status: 'failed',
    trigger_type: 'endpoint',
    elapsed_ms: 1585,
    started_at: '2026-08-19T10:15:00Z',
    completed_at: '2026-08-19T10:15:02Z',
  },
  {
    id: 1,
    workflow_id: 1,
    status: 'completed',
    trigger_type: 'endpoint',
    elapsed_ms: 113,
    started_at: '2026-08-18T09:00:00Z',
    completed_at: '2026-08-18T09:00:01Z',
  },
]

export const MOCK_RUN_DETAILS: Record<number, ReplayRunDetail> = {
  1: RUN_1_DETAIL,
  2: RUN_2_DETAIL,
  3: RUN_3_DETAIL,
}
