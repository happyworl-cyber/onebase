import type {
  DependencyGraphResponse,
  DependencyGraphNode,
  DependencyGraphEdge,
} from '@/components/workflow/graph/graphApi'

/**
 * Built-in mock data for the local dev preview page -- no backend, pure frontend constants.
 * Covers every implemented capability: nested multi department/category combos, node size
 * scaling with nodeCount, the four special-node badges (SSE/Kafka/Redis/HTTP), call_workflow
 * dependency edges (including long edges crossing combos), and external:true external
 * dependency nodes (used by the category-scoped view).
 */

/** "Full" fixture: the overview when no scope is applied -- 5 departments, 8 categories, 18 workflow nodes. */
export const FULL_FIXTURE: DependencyGraphResponse = {
  unresolved: 1,
  windowDays: 3,
  nodes: [
    { id: 1, slug: 'order-create', name: 'Create Order', department: 'Order Service', category: 'Payment', nodeCount: 8, specialFlags: [], external: false, enabled: true, windowRuns: 1200, windowFailed: 24, errorRate: 0.02, activity: 'active' },
    { id: 2, slug: 'order-pay', name: 'Order Payment', department: 'Order Service', category: 'Payment', nodeCount: 14, specialFlags: ['http_call'], external: false, enabled: true, windowRuns: 1200, windowFailed: 96, errorRate: 0.08, activity: 'active' },
    { id: 3, slug: 'order-pay-callback', name: 'Payment Callback', department: 'Order Service', category: 'Payment', nodeCount: 6, specialFlags: ['http_call'], external: false, enabled: true, windowRuns: 1200, windowFailed: 420, errorRate: 0.35, activity: 'active' },
    { id: 4, slug: 'order-refund', name: 'Initiate Refund', department: 'Order Service', category: 'Refund', nodeCount: 5, specialFlags: [], external: false, enabled: true, windowRuns: 40, windowFailed: 0, errorRate: 0.0, activity: 'idle' },
    { id: 5, slug: 'order-refund-audit', name: 'Refund Review', department: 'Order Service', category: 'Refund', nodeCount: 3, specialFlags: [], external: false, enabled: false, windowRuns: 0, windowFailed: 0, errorRate: 0.0, activity: 'dormant' },
    { id: 6, slug: 'user-login', name: 'User Login', department: 'User Service', category: 'Account', nodeCount: 10, specialFlags: ['redis'], external: false, enabled: true, windowRuns: 1200, windowFailed: 12, errorRate: 0.01, activity: 'active' },
    { id: 7, slug: 'user-profile', name: 'User Profile', department: 'User Service', category: 'Account', nodeCount: 4, specialFlags: [], external: false, enabled: true, windowRuns: 0, windowFailed: 0, errorRate: 0.0, activity: 'dormant' },
    { id: 8, slug: 'user-bind-phone', name: 'Bind Phone Number', department: 'User Service', category: 'Account', nodeCount: 7, specialFlags: [], external: false, enabled: true, windowRuns: 40, windowFailed: 24, errorRate: 0.6, activity: 'idle' },
    { id: 9, slug: 'notify-order', name: 'Order Notification', department: 'User Service', category: 'Notification', nodeCount: 12, specialFlags: ['sse_publish', 'kafka'], external: false, enabled: true, windowRuns: 1200, windowFailed: 144, errorRate: 0.12, activity: 'active' },
    { id: 10, slug: 'notify-refund', name: 'Refund Notification', department: 'User Service', category: 'Notification', nodeCount: 6, specialFlags: ['sse_publish'], external: false, enabled: false, windowRuns: 0, windowFailed: 0, errorRate: 0.0, activity: 'dormant' },
    { id: 11, slug: 'notify-digest', name: 'Notification Digest', department: 'User Service', category: 'Notification', nodeCount: 40, specialFlags: ['kafka'], external: false, enabled: true, windowRuns: 40, windowFailed: 36, errorRate: 0.9, activity: 'idle' },
    { id: 12, slug: 'shared-log', name: 'Shared Audit Log', department: '', category: '', nodeCount: 2, specialFlags: [], external: false, enabled: true, windowRuns: 1200, windowFailed: 0, errorRate: 0.0, activity: 'active' },
    { id: 13, slug: 'shared-cleanup', name: 'Shared Cleanup Task', department: '', category: '', nodeCount: 3, specialFlags: ['redis'], external: false, enabled: true, windowRuns: 40, windowFailed: 0, errorRate: 0.0, activity: 'idle' },
    { id: 14, slug: 'gw-route', name: 'Gateway Routing Dispatch', department: 'Gateway', category: 'Routing', nodeCount: 9, specialFlags: ['http_call'], external: false, enabled: true, windowRuns: 1200, windowFailed: 60, errorRate: 0.05, activity: 'active' },
    { id: 15, slug: 'gw-ratelimit', name: 'Rate Limit Check', department: 'Gateway', category: 'Routing', nodeCount: 5, specialFlags: ['redis', 'http_call'], external: false, enabled: true, windowRuns: 1200, windowFailed: 540, errorRate: 0.45, activity: 'active' },
    { id: 16, slug: 'risk-check', name: 'Risk Check', department: 'Risk Service', category: 'Rules', nodeCount: 5, specialFlags: ['redis'], external: false, enabled: true, windowRuns: 40, windowFailed: 0, errorRate: 0.0, activity: 'idle' },
    { id: 17, slug: 'risk-blacklist-sync', name: 'Blacklist Sync', department: 'Risk Service', category: 'Rules', nodeCount: 11, specialFlags: ['kafka'], external: false, enabled: false, windowRuns: 0, windowFailed: 0, errorRate: 0.7, activity: 'dormant' },
    { id: 18, slug: 'risk-report', name: 'Risk Report', department: 'Risk Service', category: 'Reports', nodeCount: 16, specialFlags: ['sse_publish', 'http_call'], external: false, enabled: true, windowRuns: 0, windowFailed: 0, errorRate: 0.0, activity: 'dormant' },
  ],
  edges: [
    { from: 15, to: 14 },
    { from: 14, to: 1 },
    { from: 1, to: 2 },
    // Duplicate-edge test case: simulates workflow 1 having two call_workflow nodes that each
    // call the same target 2 (before the backend fix this (from,to) pair would be emitted
    // twice, causing G6 to report "Edge already exists").
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 1, to: 4 },
    { from: 4, to: 5 },
    { from: 4, to: 10 },
    { from: 2, to: 9 },
    { from: 9, to: 11 },
    { from: 6, to: 8 },
    { from: 6, to: 9 },
    { from: 9, to: 12 },
    { from: 1, to: 16 },
    { from: 16, to: 17 },
    { from: 17, to: 18 },
  ],
}

/**
 * "Category scope" fixture: simulates the response for a request with
 * department=Order Service&category=Payment -- 3 nodes in the primary set plus 3 external
 * dependency nodes (external:true, from three different services: User Service, Risk Service,
 * and Gateway), used to demonstrate the dashed outline + gray badge + cross-combo edges for
 * external nodes.
 */
export const SCOPE_FIXTURE: DependencyGraphResponse = {
  unresolved: 0,
  windowDays: 3,
  nodes: [
    { id: 1, slug: 'order-create', name: 'Create Order', department: 'Order Service', category: 'Payment', nodeCount: 8, specialFlags: [], external: false, enabled: true, windowRuns: 1200, windowFailed: 24, errorRate: 0.02, activity: 'active' },
    { id: 2, slug: 'order-pay', name: 'Order Payment', department: 'Order Service', category: 'Payment', nodeCount: 14, specialFlags: ['http_call'], external: false, enabled: true, windowRuns: 1200, windowFailed: 96, errorRate: 0.08, activity: 'active' },
    { id: 3, slug: 'order-pay-callback', name: 'Payment Callback', department: 'Order Service', category: 'Payment', nodeCount: 6, specialFlags: ['http_call'], external: false, enabled: true, windowRuns: 1200, windowFailed: 420, errorRate: 0.35, activity: 'active' },
    { id: 9, slug: 'notify-order', name: 'Order Notification', department: 'User Service', category: 'Notification', nodeCount: 12, specialFlags: ['sse_publish', 'kafka'], external: true, enabled: true, windowRuns: 1200, windowFailed: 144, errorRate: 0.12, activity: 'active' },
    { id: 16, slug: 'risk-check', name: 'Risk Check', department: 'Risk Service', category: 'Rules', nodeCount: 5, specialFlags: ['redis'], external: true, enabled: true, windowRuns: 40, windowFailed: 0, errorRate: 0.0, activity: 'idle' },
    { id: 14, slug: 'gw-route', name: 'Gateway Routing Dispatch', department: 'Gateway', category: 'Routing', nodeCount: 9, specialFlags: ['http_call'], external: true, enabled: false, windowRuns: 0, windowFailed: 0, errorRate: 0.0, activity: 'dormant' },
  ],
  edges: [
    { from: 14, to: 1 },
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 2, to: 9 },
    { from: 1, to: 16 },
  ],
}

export const SCOPE_FIXTURE_SCOPE = { department: 'Order Service', category: 'Payment' }

/**
 * "Large" fixture -- simulates realistic scale (roughly 120~150 nodes). All previous
 * layout/color tuning had only been verified against the 18-node FULL_FIXTURE; after shipping,
 * the boss's real screenshots exposed the problem: with more nodes the force layout spreads the
 * graph out with huge blank areas, zoom-to-fit shrinks the whole graph tiny, and the colors are
 * too light to make anything out. This fixture reproduces that scale problem locally -- every
 * layout-convergence/color-darkening tweak must be verified against it, not just the small
 * graph.
 *
 * 8 departments, each with 2~4 categories; nodeCount/status/special flags/external are all
 * derived from the index modulo to create a gradient (deterministic, no randomness, so
 * screenshots stay reproducible). Edges: sequential chained dependencies within each category,
 * plus a handful of long cross-department edges, plus 1 duplicate edge (reusing the dedup test
 * case).
 */
function generateLargeFixture(): DependencyGraphResponse {
  const DEPARTMENTS: { name: string; categories: string[] }[] = [
    { name: 'Order Service', categories: ['Place Order', 'Payment', 'Refund'] },
    { name: 'User Service', categories: ['Account', 'Notification'] },
    { name: 'Gateway', categories: ['Routing', 'Rate Limit'] },
    { name: 'Risk Service', categories: ['Rules', 'Reports', 'Blacklist'] },
    { name: 'Payment Service', categories: ['Channel', 'Reconciliation'] },
    { name: 'Message Service', categories: ['In-app Message', 'Push', 'SMS', 'Email'] },
    { name: 'Operations Service', categories: ['Campaign', 'Coupon'] },
    { name: 'Data Service', categories: ['Reports', 'Sync', 'Archive'] },
  ]
  // nodeCount gradient: cycles from small to large, ensuring the fixture has both bloated
  // and lightweight workflows.
  const NODE_COUNT_CYCLE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 32, 40]
  const FLAG_CYCLE: string[][] = [
    [],
    [],
    ['http_call'],
    ['redis'],
    ['kafka'],
    ['sse_publish'],
    [],
    ['http_call', 'redis'],
    ['kafka', 'sse_publish'],
    [],
  ]
  const ACTIVITY_CYCLE: DependencyGraphNode['activity'][] = ['active', 'active', 'idle', 'dormant', 'idle']

  const nodes: DependencyGraphNode[] = []
  // Table of workflow ids per category, used by the edge-generation phase for in-category
  // chained dependencies + cross-department long edges.
  const catNodeIds: string[][] = []
  let seq = 1
  let cursor = 0
  for (const dept of DEPARTMENTS) {
    for (const cat of dept.categories) {
      // 5~8 workflows per category; across 8 departments x 2~4 categories (21 categories
      // total) this lands in the 120~150 node range.
      const count = 5 + (cursor % 4)
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const id = seq
        const isExternal = seq % 17 === 0
        nodes.push({
          id,
          slug: `${dept.name}-${cat}-${i}`.toLowerCase(),
          name: `${dept.name} · ${cat} · Workflow ${i + 1}`,
          department: dept.name,
          category: cat,
          nodeCount: NODE_COUNT_CYCLE[seq % NODE_COUNT_CYCLE.length],
          specialFlags: FLAG_CYCLE[seq % FLAG_CYCLE.length],
          external: isExternal,
          enabled: seq % 9 !== 0,
          errorRate: [0, 0.02, 0.08, 0.15, 0.35, 0.6, 0.9][seq % 7],
          windowRuns: [1200, 300, 40, 0][seq % 4],
          windowFailed: Math.round([1200, 300, 40, 0][seq % 4] * [0, 0.02, 0.08, 0.15, 0.35, 0.6, 0.9][seq % 7]),
          activity: ACTIVITY_CYCLE[seq % ACTIVITY_CYCLE.length],
        })
        ids.push(String(id))
        seq += 1
      }
      catNodeIds.push(ids)
      cursor += 1
    }
  }

  const edges: DependencyGraphEdge[] = []
  // In-category chained dependency: workflow[i] calls workflow[i+1], simulating call
  // orchestration within the same category.
  for (const ids of catNodeIds) {
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ from: Number(ids[i]), to: Number(ids[i + 1]) })
    }
  }
  // Cross-department/cross-category long edges: each category's first node depends on the
  // previous category's last node, creating long edges that must be drawn across combos (the
  // test case for long-edge curvature/color handling), while also keeping the overall graph
  // connected instead of fragmented into isolated pieces.
  for (let i = 1; i < catNodeIds.length; i++) {
    const from = catNodeIds[i][0]
    const to = catNodeIds[i - 1][catNodeIds[i - 1].length - 1]
    edges.push({ from: Number(from), to: Number(to) })
  }
  // Duplicate edge test case (reusing FULL_FIXTURE's dedup regression coverage): duplicate
  // the first edge.
  if (edges.length > 0) edges.push({ ...edges[0] })

  return { nodes, edges, unresolved: 2, windowDays: 3 }
}

export const LARGE_FIXTURE: DependencyGraphResponse = generateLargeFixture()

/**
 * "XL" fixture (P0 real-data-scale reproduction) -- reproduces two issues reported from
 * production, both of which must show up in this fixture:
 * (1) long names get truncated and unreadable (real cases look like "Purchase plugin Chapter
 * Pass subscription" / "Renewal (Airwallex channel) auto-charge failure handling" -- mixed
 * language, parentheses, and proper nouns, which is closer to the real pain point than the
 * short names in LARGE_FIXTURE);
 * (2) drag/zoom jank at the 300~400 node scale. The department/category counts are also
 * doubled compared to LARGE_FIXTURE (13 departments, wider spread), approximating a real
 * tenant's "many departments, each split into several categories" distribution, rather than
 * just piling more nodes into a single category -- the latter doesn't exercise the real
 * overhead of the three-level combo-combined recursion when both the level count and combo
 * count are high. The generation logic mirrors generateLargeFixture (deterministic, no
 * randomness, so screenshots stay reproducible); only the parameters are scaled up and a batch
 * of realistic long-name nodes is inserted.
 */
function generateXLFixture(): DependencyGraphResponse {
  const DEPARTMENTS: { name: string; categories: string[] }[] = [
    { name: 'Order Service', categories: ['Place Order', 'Payment', 'Refund', 'After-sales'] },
    { name: 'User Service', categories: ['Account', 'Notification', 'Permission'] },
    { name: 'Gateway', categories: ['Routing', 'Rate Limit', 'Auth'] },
    { name: 'Risk Service', categories: ['Rules', 'Reports', 'Blacklist'] },
    { name: 'Payment Service', categories: ['Channel', 'Reconciliation', 'Settlement'] },
    { name: 'Message Service', categories: ['In-app Message', 'Push', 'SMS', 'Email'] },
    { name: 'Operations Service', categories: ['Campaign', 'Coupon', 'Points'] },
    { name: 'Data Service', categories: ['Reports', 'Sync', 'Archive'] },
    { name: 'Plugin Market', categories: ['Purchase', 'Renewal', 'Unsubscribe', 'Trial'] },
    { name: 'Content Service', categories: ['Post', 'Comment', 'Review'] },
    { name: 'Support Service', categories: ['Ticket', 'Support Message'] },
    { name: 'Live Service', categories: ['Co-host', 'Gift', 'Bullet Comments'] },
    { name: 'Community Service', categories: ['Topic', 'Follow', 'Report'] },
  ]
  // Reproducing the real pain point: long-name nodes -- mixed language, parentheses, proper
  // nouns -- inserted as the first node of each catNodeIds entry, ensuring every category has
  // at least one long-name node actually rendered (not scattered randomly by chance).
  const LONG_NAME_CYCLE = [
    'Purchase plugin Chapter Pass subscription',
    'Renewal (Airwallex channel) auto-charge',
    'Cancel subscription and refund remaining balance to wallet',
    'Stripe webhook callback signature verification and idempotency handling',
    'Plugin trial expiration auto-downgrade to free tier',
    'Multi-currency price conversion (USD/EUR/JPY/CNY) cache refresh',
  ]
  const NODE_COUNT_CYCLE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 32, 40]
  const FLAG_CYCLE: string[][] = [
    [],
    [],
    ['http_call'],
    ['redis'],
    ['kafka'],
    ['sse_publish'],
    [],
    ['http_call', 'redis'],
    ['kafka', 'sse_publish'],
    [],
  ]
  const ACTIVITY_CYCLE: DependencyGraphNode['activity'][] = ['active', 'active', 'idle', 'dormant', 'idle']

  const nodes: DependencyGraphNode[] = []
  const catNodeIds: string[][] = []
  let seq = 1
  let cursor = 0
  let longNameCursor = 0
  for (const dept of DEPARTMENTS) {
    for (const cat of dept.categories) {
      // 6~9 workflows per category; 13 departments x several categories (41 categories
      // total) lands in the 300~400 node range.
      const count = 6 + (cursor % 4)
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const id = seq
        const isExternal = seq % 19 === 0
        // The first node of each category uses the long-name cycle table, ensuring long
        // names are evenly distributed across services/categories instead of clustering.
        const name =
          i === 0
            ? LONG_NAME_CYCLE[longNameCursor % LONG_NAME_CYCLE.length]
            : `${dept.name} · ${cat} · Workflow ${i + 1}`
        if (i === 0) longNameCursor += 1
        nodes.push({
          id,
          slug: `${dept.name}-${cat}-${i}`.toLowerCase(),
          name,
          department: dept.name,
          category: cat,
          nodeCount: NODE_COUNT_CYCLE[seq % NODE_COUNT_CYCLE.length],
          specialFlags: FLAG_CYCLE[seq % FLAG_CYCLE.length],
          external: isExternal,
          enabled: seq % 9 !== 0,
          errorRate: [0, 0.02, 0.08, 0.15, 0.35, 0.6, 0.9][seq % 7],
          windowRuns: [1200, 300, 40, 0][seq % 4],
          windowFailed: Math.round([1200, 300, 40, 0][seq % 4] * [0, 0.02, 0.08, 0.15, 0.35, 0.6, 0.9][seq % 7]),
          activity: ACTIVITY_CYCLE[seq % ACTIVITY_CYCLE.length],
        })
        ids.push(String(id))
        seq += 1
      }
      catNodeIds.push(ids)
      cursor += 1
    }
  }

  const edges: DependencyGraphEdge[] = []
  for (const ids of catNodeIds) {
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ from: Number(ids[i]), to: Number(ids[i + 1]) })
    }
  }
  for (let i = 1; i < catNodeIds.length; i++) {
    const from = catNodeIds[i][0]
    const to = catNodeIds[i - 1][catNodeIds[i - 1].length - 1]
    edges.push({ from: Number(from), to: Number(to) })
  }
  if (edges.length > 0) edges.push({ ...edges[0] })

  return { nodes, edges, unresolved: 3, windowDays: 3 }
}

export const XL_FIXTURE: DependencyGraphResponse = generateXLFixture()

/**
 * "Aggregation stress" fixture (dedicated reproduction case for the plan-1 aggregated-view
 * node-overlap fix) -- the boss's real environment reported that with 20+ categories and dense
 * inter-cluster call edges, the "aggregate by category" view piles nodes into large overlapping
 * clumps, with labels overlapping each other or even truncated into "...". The earlier
 * LARGE/XL fixtures had plenty of categories too (21/41 respectively) but never exposed this,
 * because: (1) inter-cluster edges were just the sparse chain "each category's first node
 * depends on the previous category's last node" -- after aggregation each cluster had at most
 * one in-edge and one out-edge, so the force layout never got crowded no matter how it placed
 * things; (2) long names were concentrated on a handful of nodes, and the category names
 * themselves were all short.
 * This fixture specifically reproduces the real pain point:
 * - 22 categories, with workflow counts per category ranging unevenly from 1 to 8 (categories
 *   with 1 workflow are the most easily overwhelmed by long labels, since their circle is
 *   already tiny);
 * - a mix of long and short category names -- half are short ("Reconciliation"/"Shipping"),
 *   half are the kind of long category names seen in real business ("Various Campaign & Coupon
 *   Auto-redemption Exception Handling" style), faithfully reproducing the "Acme·..." truncation
 *   pain point;
 * - inter-cluster call edges are no longer a sparse chain; instead each category additionally
 *   builds edges to 3 other non-adjacent categories (deterministic modulo, no randomness, so
 *   screenshots stay reproducible), so after aggregation it becomes a dense many-to-many mesh
 *   rather than a single necklace chain.
 */
function generateAggStressFixture(): DependencyGraphResponse {
  const CATEGORIES: { dept: string; cat: string }[] = [
    { dept: 'Order Service', cat: 'Place Order' },
    { dept: 'Order Service', cat: 'Payment' },
    { dept: 'Order Service', cat: 'Refund Review & Arbitration' },
    { dept: 'Order Service', cat: 'After-sales' },
    { dept: 'User Service', cat: 'Account' },
    { dept: 'User Service', cat: 'Identity Verification & Risk Blacklist Check' },
    { dept: 'User Service', cat: 'Permission' },
    { dept: 'Gateway', cat: 'Routing' },
    { dept: 'Gateway', cat: 'Rate Limit & Circuit Breaker Strategy' },
    { dept: 'Risk Service', cat: 'Rules' },
    { dept: 'Risk Service', cat: 'Reports' },
    { dept: 'Payment Service', cat: 'Channel Integration & Signature Verification' },
    { dept: 'Payment Service', cat: 'Reconciliation' },
    { dept: 'Message Service', cat: 'Push' },
    { dept: 'Message Service', cat: 'In-app Message & System Announcement Distribution' },
    { dept: 'Operations Service', cat: 'Campaign & Coupon Auto-redemption Exception Handling' },
    { dept: 'Operations Service', cat: 'Points' },
    { dept: 'Data Service', cat: 'Sync' },
    { dept: 'Plugin Market', cat: 'Purchase & Subscription Lifecycle Management' },
    { dept: 'Plugin Market', cat: 'Unsubscribe' },
    { dept: 'Content Service', cat: 'Review' },
    { dept: 'Community Service', cat: 'Report & Arbitration Ruling Process' },
  ]
  // Count gradient deliberately starts at 1 -- a category with 1 node has the smallest
  // circle (near the lower bound of the nodeVisualSize power curve), making it the easiest to
  // be overwhelmed by a long label, which is exactly the pain point being reproduced.
  const COUNT_CYCLE = [1, 1, 2, 3, 5, 8]
  const FLAG_CYCLE: string[][] = [[], ['http_call'], ['redis'], [], ['kafka'], ['sse_publish']]

  const nodes: DependencyGraphNode[] = []
  const catNodeIds: string[][] = []
  let seq = 1
  CATEGORIES.forEach((c, ci) => {
    const count = COUNT_CYCLE[ci % COUNT_CYCLE.length]
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = seq
      nodes.push({
        id,
        slug: `${c.dept}-${c.cat}-${i}`.toLowerCase(),
        name: `${c.dept} · ${c.cat} · Workflow ${i + 1}`,
        department: c.dept,
        category: c.cat,
        nodeCount: [3, 5, 8, 12, 18, 26][seq % 6],
        specialFlags: FLAG_CYCLE[seq % FLAG_CYCLE.length],
        external: false,
        enabled: seq % 7 !== 0,
        errorRate: [0, 0.05, 0.2, 0.5][seq % 4],
        windowRuns: [800, 120, 0][seq % 3],
        windowFailed: Math.round([800, 120, 0][seq % 3] * [0, 0.05, 0.2, 0.5][seq % 4]),
        activity: (['active', 'idle', 'dormant'] as const)[seq % 3],
      })
      ids.push(String(id))
      seq += 1
    }
    catNodeIds.push(ids)
  })

  const edges: DependencyGraphEdge[] = []
  // In-category chained dependency (only categories with >=2 workflows have internal
  // orchestration).
  for (const ids of catNodeIds) {
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ from: Number(ids[i]), to: Number(ids[i + 1]) })
    }
  }
  // Dense cross-category edges: each category additionally builds edges to 3 categories at
  // different "jump distances" (+3/+7/+11, deterministic modulo); after aggregation each
  // cluster node has several edges hanging off it instead of a sparse chain -- this is the
  // key to reproducing the real environment's "dense edges".
  const JUMPS = [3, 7, 11]
  catNodeIds.forEach((ids, i) => {
    if (ids.length === 0) return
    JUMPS.forEach((jump) => {
      const targetIdx = (i + jump) % catNodeIds.length
      const targetIds = catNodeIds[targetIdx]
      if (targetIdx === i || targetIds.length === 0) return
      edges.push({ from: Number(ids[0]), to: Number(targetIds[targetIds.length - 1]) })
    })
  })

  return { nodes, edges, unresolved: 0, windowDays: 3 }
}

export const AGG_STRESS_FIXTURE: DependencyGraphResponse = generateAggStressFixture()

/**
 * "600-node" fixture (dedicated to phase-2 performance acceptance) -- the phase-2 target scale
 * approved by the boss, approximating a real large-tenant volume. Three deliberate design
 * points that mirror real distributions:
 * - department/category counts are strongly uneven (anywhere from 3 to 34 workflows in a single
 *   category), not evenly sliced;
 * - a handful of "hub" nodes (shared capabilities that get called everywhere, like gateway
 *   auth/risk verification/unified notification) are pointed to heavily across departments,
 *   with an in-degree far exceeding other nodes, used to verify whether the in-degree
 *   halo/leaderboard still reads clearly under a realistically skewed distribution;
 * - a mix of long and short workflow names (reusing XL fixture's real-business long-name pool)
 *   to verify the label wrap/ellipsis strategy.
 * Edge generation is still deterministic (no randomness): in-category chains + sparse
 * cross-category jumps + hub-focused calls layered together.
 */
function generateHugeFixture(): DependencyGraphResponse {
  const DEPARTMENTS: { name: string; categories: string[] }[] = [
    { name: 'Order Service', categories: ['Place Order', 'Payment', 'Refund', 'After-sales', 'Invoice'] },
    { name: 'User Service', categories: ['Account', 'Notification', 'Permission', 'Identity Verification'] },
    { name: 'Gateway', categories: ['Routing', 'Rate Limit', 'Auth', 'Circuit Breaker'] },
    { name: 'Risk Service', categories: ['Rules', 'Reports', 'Blacklist', 'Device Fingerprint'] },
    { name: 'Payment Service', categories: ['Channel', 'Reconciliation', 'Settlement'] },
    { name: 'Message Service', categories: ['In-app Message', 'Push', 'SMS', 'Email', 'Template Management'] },
    { name: 'Operations Service', categories: ['Campaign', 'Coupon', 'Points', 'Check-in'] },
    { name: 'Data Service', categories: ['Reports', 'Sync', 'Archive'] },
    { name: 'Plugin Market', categories: ['Purchase', 'Renewal', 'Unsubscribe', 'Trial'] },
    { name: 'Content Service', categories: ['Post', 'Comment', 'Review', 'Recommendation'] },
    { name: 'Support Service', categories: ['Ticket', 'Support Message'] },
    { name: 'Live Service', categories: ['Co-host', 'Gift', 'Bullet Comments'] },
    { name: 'Community Service', categories: ['Topic', 'Follow', 'Report'] },
    { name: 'Search Service', categories: ['Index Building', 'Query'] },
    { name: 'Auth Service', categories: ['Login', 'Third-party Auth', 'Session Management'] },
    { name: 'Analytics Service', categories: ['Tracking', 'Report Generation'] },
    { name: 'Inventory Service', categories: ['Deduction', 'Reservation', 'Sync'] },
    { name: 'Logistics Service', categories: ['Shipment', 'Tracking Sync'] },
  ]
  const LONG_NAME_CYCLE = [
    'Purchase plugin Chapter Pass subscription',
    'Renewal (Airwallex channel) auto-charge',
    'Cancel subscription and refund remaining balance to wallet',
    'Stripe webhook callback signature verification and idempotency handling',
    'Plugin trial expiration auto-downgrade to free tier',
    'Multi-currency price conversion (USD/EUR/JPY/CNY) cache refresh',
    'Device fingerprint collection and batch risk score verification',
    'Third-party auth token expiration auto-refresh retry',
  ]
  // The count gradient deliberately widens the spread (3~34), more extremely uneven than the
  // XL fixture -- in a real large tenant, core categories like "Account/Payment" have far more
  // workflows than edge categories like "Follow/Report"; a fixed cycle table simulates this
  // skew instead of an even split.
  const COUNT_CYCLE = [3, 5, 6, 8, 10, 12, 14, 18, 22, 28, 34, 4, 7, 9]
  const NODE_COUNT_CYCLE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 32, 40]
  // trigger_cron / trigger_notify are two categories newly added to the special-node filter
  // (aligned with the synthetic flags the backend derives from trigger_type -- see the
  // SPECIAL_FLAG_META comment in graphData.ts) -- added to the cycle table so all four required
  // filter categories (scheduled execution/Redis/Kafka/waiting on Notify) get nonzero hits in
  // this acceptance fixture.
  const FLAG_CYCLE: string[][] = [
    [],
    [],
    ['http_call'],
    ['redis'],
    ['kafka'],
    ['sse_publish'],
    ['trigger_cron'],
    ['http_call', 'redis'],
    ['kafka', 'sse_publish'],
    ['trigger_notify'],
    [],
    ['redis', 'trigger_cron'],
    ['kafka', 'trigger_notify'],
    [],
  ]
  const ACTIVITY_CYCLE: DependencyGraphNode['activity'][] = ['active', 'active', 'idle', 'dormant', 'idle']

  const nodes: DependencyGraphNode[] = []
  const catNodeIds: string[][] = []
  let seq = 1
  let cursor = 0
  let longNameCursor = 0
  DEPARTMENTS.forEach((dept) => {
    dept.categories.forEach((cat) => {
      const count = COUNT_CYCLE[cursor % COUNT_CYCLE.length]
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const id = seq
        const isExternal = seq % 23 === 0
        const name = i === 0 ? LONG_NAME_CYCLE[longNameCursor % LONG_NAME_CYCLE.length] : `${dept.name} · ${cat} · Workflow ${i + 1}`
        if (i === 0) longNameCursor += 1
        nodes.push({
          id,
          slug: `${dept.name}-${cat}-${i}`.toLowerCase(),
          name,
          department: dept.name,
          category: cat,
          nodeCount: NODE_COUNT_CYCLE[seq % NODE_COUNT_CYCLE.length],
          specialFlags: FLAG_CYCLE[seq % FLAG_CYCLE.length],
          external: isExternal,
          enabled: seq % 9 !== 0,
          errorRate: [0, 0.02, 0.08, 0.15, 0.35, 0.6, 0.9][seq % 7],
          windowRuns: [1200, 300, 40, 0][seq % 4],
          windowFailed: Math.round([1200, 300, 40, 0][seq % 4] * [0, 0.02, 0.08, 0.15, 0.35, 0.6, 0.9][seq % 7]),
          activity: ACTIVITY_CYCLE[seq % ACTIVITY_CYCLE.length],
        })
        ids.push(String(id))
        seq += 1
      }
      catNodeIds.push(ids)
      cursor += 1
    })
  })

  const edges: DependencyGraphEdge[] = []
  // In-category chained dependency: workflows in the same category call each other in
  // sequence order.
  for (const ids of catNodeIds) {
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ from: Number(ids[i]), to: Number(ids[i + 1]) })
    }
  }
  // Sparse cross-category jumps: create long edges that must be drawn across combos, while
  // keeping the overall graph connected.
  for (let i = 1; i < catNodeIds.length; i++) {
    const from = catNodeIds[i][0]
    const to = catNodeIds[i - 1][catNodeIds[i - 1].length - 1]
    if (from && to) edges.push({ from: Number(from), to: Number(to) })
  }
  // Hub-focused calls: pick 8 "shared capability" nodes spread across different departments
  // as hubs (nodes that really do get called everywhere in real life, like gateway auth/risk
  // verification/unified notification), and have every other category pick one node to point
  // at a hub via deterministic modulo, creating the "a few nodes with extremely high
  // in-degree" skew common in real distributions, instead of uniform in-degree across all
  // nodes.
  const hubCandidates = ['gateway-auth-0', 'risk service-rules-0', 'user service-account-0', 'auth service-login-0', 'message service-in-app message-0', 'data service-sync-0', 'payment service-channel-0', 'inventory service-deduction-0']
  const slugToId = new Map<string, string>()
  nodes.forEach((n) => slugToId.set(n.slug, String(n.id)))
  const hubIds = hubCandidates.map((slug) => slugToId.get(slug)).filter((id): id is string => !!id)
  if (hubIds.length > 0) {
    catNodeIds.forEach((ids, i) => {
      const caller = ids[ids.length - 1]
      const hub = hubIds[i % hubIds.length]
      if (caller && hub && caller !== hub) edges.push({ from: Number(caller), to: Number(hub) })
    })
  }
  if (edges.length > 0) edges.push({ ...edges[0] })

  return { nodes, edges, unresolved: 4, windowDays: 3 }
}

export const HUGE_FIXTURE: DependencyGraphResponse = generateHugeFixture()
