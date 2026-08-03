#!/usr/bin/env node
/**
 * OneBase MCP server
 *
 * 把 OneBase 的 HTTP 管理端点封装成 MCP 工具，让 AI / 自动化客户端能直接：
 *   - 用 PG 池里的库开通新项目（create_project）
 *   - 创建 / 更新 / 调试 / 运行工作流（*_workflow）
 *
 * 鉴权：使用平台服务令牌（crp_ 前缀），通过环境变量注入。该令牌在 OneBase 后端
 * 被解析成绑定用户的身份，并受令牌 scope（project:create / workflow:read|write|run）约束。
 *
 * 必需环境变量：
 *   - ONEBASE_BASE_URL   后端基址，如 http://10.0.5.11:31088
 *   - ONEBASE_TOKEN      平台令牌明文，crp_ 开头
 *
 * 运行（stdio）：node dist/index.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.ONEBASE_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.ONEBASE_TOKEN || "";

if (!BASE_URL) {
  console.error("[onebase-mcp] 缺少环境变量 ONEBASE_BASE_URL");
  process.exit(1);
}
if (!TOKEN) {
  console.error("[onebase-mcp] 缺少环境变量 ONEBASE_TOKEN（crp_ 平台令牌）");
  process.exit(1);
}
if (!TOKEN.startsWith("crp_")) {
  console.error(
    "[onebase-mcp] 警告：ONEBASE_TOKEN 不是 crp_ 开头，可能不是平台服务令牌"
  );
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** 统一的 HTTP 调用：带平台令牌，返回 {status, body}；body 优先按 JSON 解析。 */
async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; ok: boolean; data: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应，保留原始文本 */
  }
  return { status: res.status, ok: res.ok, data };
}

/** 把 api() 的结果包装成 MCP ToolResult；HTTP 非 2xx 标记 isError。 */
function toResult(r: { status: number; ok: boolean; data: unknown }): ToolResult {
  const text = JSON.stringify(
    { status: r.status, ok: r.ok, data: r.data },
    null,
    2
  );
  return { content: [{ type: "text", text }], isError: !r.ok };
}

/** 把抛出的异常包装成 MCP 错误结果（避免整个工具调用崩溃）。 */
function errResult(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text", text: `请求失败：${msg}` }],
    isError: true,
  };
}

const server = new McpServer({ name: "onebase", version: "1.0.0" });

// ─── 项目开通 ──────────────────────────────────────────────────────

server.registerTool(
  "list_pg_pools",
  {
    title: "列出可用 PG 池",
    description:
      "列出当前可用于开通项目的 PostgreSQL 池（服务器）。开通项目前先用它拿到 pg_pool_id。",
    inputSchema: {},
  },
  async (): Promise<ToolResult> => {
    try {
      return toResult(await api("GET", "/api/provision/pg-pools/available"));
    } catch (e) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "list_templates",
  {
    title: "列出项目模板",
    description:
      "列出可选的项目模板（template_slug）。开通项目时需指定其中一个模板的 slug。",
    inputSchema: {},
  },
  async (): Promise<ToolResult> => {
    try {
      return toResult(await api("GET", "/api/project-templates"));
    } catch (e) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "create_project",
  {
    title: "开通新项目",
    description:
      "在指定 PG 池上自动 CREATE DATABASE 并开通一个新项目（租户）。令牌绑定的用户会成为 owner。" +
      "返回含 database_id / db_name / slug。需要令牌持有 project:create scope。",
    inputSchema: {
      name: z.string().describe("项目显示名（1-200 字）"),
      slug: z
        .string()
        .describe("项目唯一标识，小写字母开头，仅 [a-z0-9_-]，1-50 字"),
      use_platform_pg: z
        .boolean()
        .optional()
        .describe("使用当前平台 PG 实例建库（与 pg_pool_id / use_provision_webhook 等四选一；推荐 true）"),
      use_provision_webhook: z
        .boolean()
        .optional()
        .describe("调用运维 Provisioner Webhook 自动开通（需平台配置 PROVISION_WEBHOOK_URL）"),
      requested_resources: z
        .array(z.string())
        .optional()
        .describe("Webhook 请求资源，默认 [\"postgresql\"]"),
      pg_pool_id: z
        .number()
        .int()
        .optional()
        .describe("PG 池 id（来自 list_pg_pools；与其他 PG 来源四选一）"),
      template_slug: z.string().describe("模板 slug（来自 list_templates，如 blank）"),
      scenario: z.string().optional().describe("可选场景标记，写入项目元信息"),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      return toResult(await api("POST", "/api/projects/provision", args));
    } catch (e) {
      return errResult(e);
    }
  }
);

// ─── 工作流管理 ────────────────────────────────────────────────────

const NODES_DESC =
  "节点数组。每个节点形如 {id, type, label?, config}。type 可选：" +
  "code(Lua/JavaScript/Python) / db_query / db_execute / http_call / email_send / condition / transform / response / sse_publish。";
const EDGES_DESC =
  "边数组，每条形如 {from, to, branch?}。condition 节点用 branch 区分 true/false 分支。";

server.registerTool(
  "list_workflows",
  {
    title: "列出工作流",
    description: "列出工作流，可按 database_id 过滤。需要 workflow:read scope。",
    inputSchema: {
      database_id: z.number().int().optional().describe("按项目库过滤"),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      const q =
        args.database_id !== undefined ? `?database_id=${args.database_id}` : "";
      return toResult(await api("GET", `/api/admin/workflows${q}`));
    } catch (e) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "get_workflow",
  {
    title: "查看工作流详情",
    description: "按 id 获取工作流完整定义。需要 workflow:read scope。",
    inputSchema: {
      id: z.number().int().describe("工作流 id"),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      return toResult(await api("GET", `/api/admin/workflows/${args.id}`));
    } catch (e) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "create_workflow",
  {
    title: "创建工作流",
    description:
      "创建一个工作流（DAG）。需指定 database_id 把工作流绑定到某项目库。需要 workflow:write scope。",
    inputSchema: {
      name: z.string().describe("工作流名称"),
      slug: z.string().describe("工作流唯一标识，小写/数字/连字符，≤64"),
      database_id: z.number().int().describe("绑定的项目库 id（来自 create_project）"),
      description: z.string().optional(),
      category: z.string().optional().describe("分类标签，便于管理"),
      trigger_type: z
        .enum(["endpoint", "hook", "cron", "manual", "notify"])
        .optional()
        .describe("触发方式，默认 endpoint"),
      trigger_config: z.record(z.any()).optional().describe("触发配置 JSON"),
      nodes: z.array(z.any()).describe(NODES_DESC),
      edges: z.array(z.any()).describe(EDGES_DESC),
      is_enabled: z.boolean().optional(),
      timeout_ms: z.number().int().optional().describe("整体超时，默认 30000"),
      max_retries: z.number().int().optional(),
      version_note: z.string().optional().describe("初始版本备注"),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      return toResult(await api("POST", "/api/admin/workflows", args));
    } catch (e) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "update_workflow",
  {
    title: "更新工作流",
    description:
      "按 id 局部更新工作流（仅传需要改的字段）。同时传 nodes+edges 才会触发版本快照。需要 workflow:write scope。",
    inputSchema: {
      id: z.number().int().describe("工作流 id"),
      name: z.string().optional(),
      slug: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      trigger_type: z
        .enum(["endpoint", "hook", "cron", "manual", "notify"])
        .optional(),
      trigger_config: z.record(z.any()).optional(),
      nodes: z.array(z.any()).optional().describe(NODES_DESC),
      edges: z.array(z.any()).optional().describe(EDGES_DESC),
      is_enabled: z.boolean().optional(),
      timeout_ms: z.number().int().optional(),
      max_retries: z.number().int().optional(),
      version_note: z.string().optional(),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      const { id, ...body } = args;
      return toResult(await api("PATCH", `/api/admin/workflows/${id}`, body));
    } catch (e) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "debug_workflow",
  {
    title: "调试运行工作流定义",
    description:
      "对一套（未保存的）nodes/edges 定义直接跑一遍，返回逐节点结果，便于迭代。" +
      "dry_run=true 可跳过写库/HTTP/邮件/SSE 等副作用。需要 workflow:write scope。",
    inputSchema: {
      nodes: z.array(z.any()).describe(NODES_DESC),
      edges: z.array(z.any()).describe(EDGES_DESC),
      database_id: z.number().int().optional().describe("db_query/db_execute 节点需要"),
      tenant_id: z.number().int().optional(),
      trigger_type: z.string().optional(),
      trigger_data: z.record(z.any()).optional().describe("模拟触发输入，节点里用 {{trigger.*}} 取"),
      timeout_ms: z.number().int().optional(),
      dry_run: z.boolean().optional().describe("干跑，跳过副作用节点"),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      return toResult(await api("POST", "/api/admin/workflows/debug", args));
    } catch (e) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "run_workflow",
  {
    title: "运行 endpoint 工作流",
    description:
      "调用某项目下已启用的 endpoint 工作流（POST /workflow/{database_slug}/{workflow_slug}）。" +
      "payload 作为触发数据传入。需要 workflow:run scope。",
    inputSchema: {
      database_slug: z.string().describe("项目库 slug"),
      workflow_slug: z.string().describe("工作流 slug"),
      payload: z.record(z.any()).optional().describe("触发数据 JSON body"),
    },
  },
  async (args): Promise<ToolResult> => {
    try {
      return toResult(
        await api(
          "POST",
          `/workflow/${encodeURIComponent(args.database_slug)}/${encodeURIComponent(
            args.workflow_slug
          )}`,
          args.payload ?? {}
        )
      );
    } catch (e) {
      return errResult(e);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[onebase-mcp] 已启动，后端=${BASE_URL}`);
}

main().catch((e) => {
  console.error("[onebase-mcp] 启动失败:", e);
  process.exit(1);
});
