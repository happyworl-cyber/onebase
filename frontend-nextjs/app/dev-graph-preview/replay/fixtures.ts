/**
 * 执行回放图本地 mock fixture —— 零后端依赖，供 dev 预览页渲染验证。
 * 覆盖：成功/失败/跳过三态、条件分支二选一、耗时热力梯度、5 种特殊节点角标
 *（http_call/kafka/redis/call_workflow/sse_publish）、失败运行的错误信息展示、
 * run#3 的静默空响应三例（http 200 空 body / kafka 无 ack / db_execute 0 行受影响）。
 */

import type { WorkflowEdgeDef, WorkflowNodeDef } from '@/components/workflow/WorkflowCanvas'
import type { ReplayRunDetail, ReplayRunSummary } from '@/components/workflow/replay/replayApi'

export const MOCK_WORKFLOW_NODES: WorkflowNodeDef[] = [
  {
    id: 'fetch_user',
    type: 'http_call',
    label: '拉取用户信息',
    config: { method: 'GET', url: 'https://api.example.com/users/{{trigger.user_id}}', headers: { Authorization: 'Bearer {{env.API_TOKEN}}' } },
  },
  {
    id: 'check_tier',
    type: 'condition',
    label: '判断会员等级',
    config: {
      conditions: [{ branch: 'vip', expression: '{{fetch_user.body.tier}} == "vip"' }],
      default_branch: 'default',
    },
  },
  { id: 'apply_discount', type: 'code', label: '计算折扣', config: { language: 'lua', code: 'return { discount = 0.8 }' } },
  {
    id: 'publish_kafka',
    type: 'kafka',
    label: '发通知消息',
    config: { connection_id: 3, op: 'produce', topic: 'order-events', key: '{{fetch_user.body.id}}', value: { event: 'discount_applied' } },
  },
  {
    id: 'save_order',
    type: 'db_execute',
    label: '写订单',
    config: { sql: 'UPDATE orders SET discount = {{apply_discount.discount}} WHERE user_id = {{trigger.user_id}}', params: [] },
  },
  {
    id: 'call_sub_refund',
    type: 'call_workflow',
    label: '调用退款子流程',
    config: { workflow: 'refund-issue', input: { order_id: '{{save_order.id}}' }, allow_failure: false },
  },
  { id: 'publish_sse', type: 'sse_publish', label: '推送前端', config: { topic: 'order/{{trigger.user_id}}', event: 'discount' } },
  {
    id: 'log_default',
    type: 'redis',
    label: '记录普通用户',
    config: { connection_id: 1, op: 'incr', key: 'stat:default_user_count' },
  },
  { id: 'respond', type: 'response', label: '返回结果', config: { status_code: 200, body: { ok: true } } },
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

/** run#2：vip 分支，走到写库变慢（900ms，热力最红），子流程调用失败，下游被跳过。 */
const RUN_2_DETAIL: ReplayRunDetail = {
  id: 2,
  workflow_id: 1,
  status: 'failed',
  trigger_type: 'endpoint',
  elapsed_ms: 1585,
  started_at: '2026-08-19T10:15:00Z',
  completed_at: '2026-08-19T10:15:02Z',
  error_message: '子工作流 refund-issue 执行失败：连接超时',
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
      error: '子工作流 refund-issue 返回失败：连接超时（3000ms）',
    },
    // skipped 节点后端 elapsed_ms 恒为 0（非 null）——fixture 与真实数据对齐，
    // 这样才能在预览页里验证"热力不覆盖 skipped 灰框、侧栏不显 0ms"这两处修复。
    { node_id: 'publish_sse', node_type: 'sse_publish', status: 'skipped', elapsed_ms: 0 },
    { node_id: 'respond', node_type: 'response', status: 'skipped', elapsed_ms: 0 },
  ],
}

/**
 * run#3：vip 分支全程成功，但其中 3 个节点是"连接通、不报错、但没拿到数据"的静默空响应——
 * fetch_user 200 但 body 为空、publish_kafka 投递后没拿到 result（无 ack）、save_order
 * UPDATE 没匹配到行（rows_affected=0）。用来验收空响应角标/侧栏快照/总览统计三处联动。
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

/** run#1：default 分支，全程成功，走另一条路径（供切换运行验证分支跟着换）。 */
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
