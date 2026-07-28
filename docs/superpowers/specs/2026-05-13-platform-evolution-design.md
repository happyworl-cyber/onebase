# OneBase 平台化产品规划（v1 + v2 路线图）

- **撰写日期**：2026-05-13
- **作者**：Product Planning（AI 协作）
- **范围**：OneBase 从「Rust 数据网关 + Next.js 控制台」演进为「企业内部可自助使用的零代码后端平台」，并预留「数据 API 资产平台」的扩展路径
- **状态**：Draft，待评审

---

## 0. 一句话定位

> 在客户私有 Kubernetes 集群里，把 OneBase 升级成一个"开发者建表 → 30 分钟拿到完整后端 + 自带 AI 助手 + 自带运维大盘"的内部平台；运维同事只管 PG / Redis / 集群本身，不参与任何业务后端开发。

---

## 1. 决策背景与原则

### 1.1 用户已经决策的边界

| 维度 | 决策 | 影响 |
|---|---|---|
| 交付形态 | **企业私有化**（K8s only） | 不做 SaaS 计费 / 订阅；要 License；要 Helm Chart |
| 部署目标 | **Kubernetes only** | 部署子系统直接走 Helm，必要时演进到 Operator |
| 分布式范围 | **仅"项目级资源隔离"** | 不做 PG 集群 / 多 Region；PG/Redis 由客户自备 |
| v1 主航道 | **方向 A：零代码后端平台 + AI 增强** | 内核存量 95% 已有，落地最快 |
| v2 远期 | **方向 B：数据 API 资产平台** | v1 设计需为其预留接口 |
| 项目隔离 | **沿用现有 `tenant_handlers` 架构** | "Tenant" 在产品语义上重命名为 "Project"，零数据迁移 |
| AI 接入 | **LLM Adapter（OpenAI 兼容协议）** | 一套实现覆盖外部 API + 自部署模型 |

### 1.2 核心原则

1. **存量优先**：能复用 `src/` 下现有模块的，绝不新建
2. **不做平台外的事**：PG failover / 跨集群 / 全功能 APM 等交给生态（CloudNativePG / Prometheus / Loki）
3. **私有化友好**：所有外部依赖都可被替换或离线（含 LLM）
4. **向后兼容**：现有超管控制台保留，新增"项目工作空间"作为并列入口
5. **YAGNI**：v1 不做"Workspace 主题定制""多语言""审批流引擎"等容易膨胀的能力

---

## 2. v1 范围：零代码后端平台（方向 A）

### 2.1 模块拆分

| 编号 | 模块 | 内核存量 | v1 增量工作 |
|---|---|---|---|
| **M1** | 项目工作空间（Project Workspace） | Tenant 模型已存在 | 产品语义重命名 + 项目级中间件 + 前端 Workspace 路由 |
| **M2** | 自助开通向导（Onboarding Wizard） | 0% | 5 步 wizard + 后端 provisioning API |
| **M3** | 可视化建表 / Schema 编辑 | `schema_handlers` `index_handlers` 完整 | ER / 表设计器 + DDL 预览 + 一键迁移 |
| **M4** | RBAC 可视化配置 | 后端 95%，前端 40% | 角色 / 权限矩阵 / 行级条件构建器 + 模板 |
| **M5** | Webhook / Realtime 配置面板 | `webhook_*` `realtime` `events` 完整 | 订阅配置 + 在线测试器 + 重试详情 |
| **M6** | 项目级审计 / 监控大盘 | `audit_*` `monitor_*` `query_perf_*` 数据齐全 | 项目维度聚合 + 异常访问告警 + 大盘 |
| **M7** | AI 助手（NL2SQL + 慢查询诊断） | 30%（需要 LLM 适配 + RAG） | LlmProvider Adapter + 安全闸 + Chat UI |
| **M8** | 私有化交付包 | 0% | License 模块 + Helm Chart + 部署文档 |
| **M9** | 定时任务（Scheduled Tasks） | runner / executors / handlers / 14_migration | 详细 spec: `2026-05-14-scheduled-tasks-design.md` |

### 2.2 模块关系图

```
                    ┌─────────────────────────────────────┐
                    │  Project Workspace (M1)             │
                    │  ──────────────────────────         │
                    │  开发者 / 项目管理员的统一入口       │
                    └────────────┬────────────────────────┘
                                 │
        ┌────────────┬───────────┼───────────┬────────────┬────────────┐
        ▼            ▼           ▼           ▼            ▼            ▼
   ┌────────┐  ┌─────────┐ ┌─────────┐  ┌────────┐  ┌────────┐  ┌────────┐
   │ M2     │  │ M3      │ │ M4      │  │ M5     │  │ M6     │  │ M7 AI  │
   │开通向导│  │ Schema  │ │ RBAC    │  │Webhook │  │ 大盘   │  │ 助手   │
   └────────┘  └─────────┘ └─────────┘  └────────┘  └────────┘  └────────┘
        │           │           │            │           │           │
        └───────────┴───────────┴────────────┴───────────┴───────────┘
                                 │
                       使用现有引擎模块
        ┌────────────┬───────────┼───────────┬────────────┬────────────┐
        ▼            ▼           ▼           ▼            ▼            ▼
   tenant_*   schema_handlers  rbac_*  webhook_manager  audit_*    LlmProvider
   pool_mgr   index_handlers   query_  events           monitor_*  (新增 trait)
                               cache   realtime
```

### 2.3 模块详细设计

#### M1. 项目工作空间

- **数据模型**：直接在 `management.tenants` 上扩展（无需新表）
  - 增加 `tenants.kind ENUM('legacy_tenant', 'project')` 标记区分
  - 增加 `tenants.workspace_config JSONB`（存大盘布局、AI 开关等）
- **路由**：前端新增 `app/workspace/[projectId]/...`，与现有 `app/dashboard/...`（超管台）并列
- **权限**：复用 RBAC，新增内置角色 `project_owner` / `project_developer` / `project_viewer`
- **不做**：跨项目共享、项目模板市场（v2+）

#### M2. 自助开通向导

- 5 步：选场景 → 命名项目 → 挂载 PG（管理员预先池化的 PG 列表中选一个）→ 选模板（空白 / 博客 / 任务管理 / 社区）→ 完成
- 后端单一端点 `POST /api/projects/provision`，幂等，返回 project_id
- "管理员预先池化的 PG"：超管在控制台维护"可分配的 PG 连接池"列表
- **不做**：自动新建 PG 实例（这是子系统 B—自动部署的事，不在 v1 范围）

#### M3. 可视化建表

- 复用 `schema_handlers` 提供的 schema 元数据 API
- 前端引入开源 ER 编辑器（如 `dbml-renderer` / 自研轻量版）
- 改动写入流程：可视化操作 → 生成 DDL → 用户确认 → 调 `schema_handlers` 执行
- **安全**：所有 DDL 走现有的 SQL 安全校验，不允许 raw SQL 直执行

#### M4. RBAC 可视化配置

- 4 个核心界面：角色管理 / 权限矩阵（资源 × 动作）/ 行级条件构建器 / 列级可见性
- 行级条件构建器输出现有 `permissions.conditions` 的结构化 DSL，**不是 SQL 字符串**
- 提供 5 个开箱即用模板：仅自己 / 同部门 / 同租户 / 公开只读 / 禁止
- **不做**：基于 ABAC 的复杂表达式（保留为 v2 扩展点）

#### M5. Webhook / Realtime 配置

- Webhook：表 × 事件类型（INSERT/UPDATE/DELETE）→ HTTP URL；测试按钮；重试历史
- Realtime：项目维度生成 WebSocket endpoint，订阅协议复用 `realtime.rs` 已实现的部分
- **不做**：消息转换 DSL、目的地适配器（v2 逆向 ETL 的范畴）

#### M6. 项目级大盘

- 6 个核心卡片：QPS / P95 延迟 / 错误率 / 慢查询数 / 活跃 API Key / 每日 API 调用量
- 异常访问告警：基于 `audit_logs` 检测"非工作时间访问 / 跨项目访问尝试 / API Key 滥用"
- 数据源：`monitor_handlers` `query_perf_handlers` `audit_handlers` 的现有 API
- **不做**：自定义大盘 / 自定义告警规则（保留 v2）

#### M7. AI 助手

- **核心架构**：
  ```
  trait LlmProvider {
      async fn chat(&self, messages: Vec<Message>, opts: ChatOpts) -> Result<ChatResponse>;
      async fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>>;
  }
  ```
- v1 实现一个 `OpenAICompatibleProvider`，覆盖 OpenAI / DeepSeek / vLLM / Ollama / xinference
- 项目维度配置 LLM endpoint + API Key（API Key 走现有 `crypto.rs` 加密）
- **两个能力（v1 起步范围）**：
  - **NL2SQL**：用户用中文问 → AI 拿 schema + 当前用户 RBAC 条件 → 生成 SELECT-only SQL → 在前端预览 → 用户确认后走现有 `/query` 端点
  - **慢查询诊断**：把 `slow_queries` 表里的慢语句喂 AI → 输出"原因 + 建议索引/重写方案"
- **安全闸**（必须）：
  - NL2SQL 默认只读，写操作要求二次确认 + 记录审计
  - LLM 不接触加密 secrets / 密码 / 密钥字段（敏感字段在 schema 元数据阶段被 mask）
  - 所有 LLM 调用本身记录审计（谁问了什么、用了多少 token）
- **不做**：Function Calling / Agent 自主执行 / 自动改 Schema（要人审）

#### M8. 私有化交付包

- **Helm Chart**：包含 Deployment（OneBase 后端 + Next.js 前端）、Service、Ingress、ConfigMap、Secret 模板
- **License 模块**（软性）：
  - 表 `management.licenses`：max_projects / max_users / valid_until / signature
  - 启动校验 + 每天定时校验；过期进入"只读告警模式"，不阻断登录
  - 签名用非对称（颁发方私钥签 / 部署方公钥验）
  - **不做**：硬绑定 MAC/CPU 序列号（容器化下伪命题）
- **部署文档**：单文件部署手册 + 5 个常见问题排查

### 2.4 默认决策（小决策，不专门征询）

| 项 | 默认决策 | 理由 |
|---|---|---|
| Workspace 前端架构 | 在现有 Next.js 加 layout + 路由，复用组件库 | 避免重复维护两个前端代码库 |
| License 形态 | 软性 License Token（非对称签名） | 私有化下硬激活成本高且易绕过，软性够用 |
| 项目下数据库连接 | 1 项目可挂多个 PG 连接（沿用现有 tenant 能力） | 现成，省事 |
| AI 调用计量 | 按项目统计 token，写 `audit_logs` | 复用现有审计基础设施 |
| 国际化 | v1 仅中文 | 私有化客户主要在国内 |

---

## 3. 里程碑与时间表

> 假设：**2-3 人小队**（1 后端 + 1 前端 + 0.5 设计 / PM）

| 阶段 | 累计周 | 交付内容 | 可演示状态 | 风险点 |
|---|---|---|---|---|
| **M0 Foundation** | 2 周 | M1 项目工作空间 + 控制台拆分 | 内部 demo | 现有路由改造影响超管 |
| **MVP** | 4 周 | + M2 开通向导 + M3 裸建表 + M6 简化大盘 | 内部 alpha | M3 可视化复杂度 |
| **Beta** | 8 周 | + M4 RBAC 配置 + M5 Webhook 面板 + M6 完整 + M7 NL2SQL（只读） | 客户试点 | M7 AI 安全闸 |
| **GA** | 12 周 | + M7 慢查询诊断 + M8 Helm + License + v2 预留接口 | 私有化交付 | License 颁发流程 |

### 3.1 里程碑入口/出口标准

- **MVP 出口**：开发者能从 0 自助完成 "登录 → 建项目 → 建表 → 查 API → 看大盘"；超管控制台无回归 bug
- **Beta 出口**：完整 RBAC 可视化 + Webhook 可配可测 + NL2SQL 在 5 个 demo 数据集上通过率 ≥ 80%
- **GA 出口**：Helm 一键部署成功；License 过期降级行为正确；客户运维手册通过 1 次新人盲测

---

## 4. v2 预留接口（方向 B：数据 API 资产平台）

为了 v2 不返工，v1 设计时**必须**保留：

| v1 现状 | v2 扩展点 |
|---|---|
| API Key 已支持 `allowed_resources/actions` scope | v2 加一个 `is_public_asset` 标记 + 资产目录元数据 |
| `/query` / `/transaction` 高危原始 SQL 通道：路由组自带 `auth + require_superadmin + dynamic_db` 三层中间件，**不依赖任何全局兜底**；handler 通过 `AuditDetailSink` 把 sql_type / sql_len / read_only / op_count / blocked_reason 注入 `audit_logs.request_body`（JSONB），并把 `action` 列升级为 `RAW_SQL_QUERY` / `RAW_SQL_BLOCKED` / `RAW_SQL_TXN`；`dynamic_db_middleware` 同时把反查到的 `tenant_id` 通过 `CurrentTenantId` 扩展暴露，`audit_middleware` 写入 `audit_logs.tenant_id`，按租户拉日志可直接 `WHERE tenant_id = ?`；与 `tracing::warn target=raw_sql_audit` 双轨；`is_dangerous_operation()` 黑名单 + `read_only` 标记 + `dynamic_db` 强制连接池切换是仅有的三道护栏 —— 详见 `README.md → 2.1 /query / /transaction 的访问控制细节` | v2 对接 NL2SQL 走它的"二次确认 + 审计"通道（直接复用 `AuditDetailSink`） |
| Auto API 已经收敛到走 RBAC 的 `/api/v1/{database_id}/{schema}/{table}`（`auth + dynamic_db + rbac` 三层中间件，按 permissions/conditions 校验行/列）；旧版 `/api/:schema/:table` 保留为「**超管直连 CRUD / 故意旁路 RBAC**」的运维接口，挂 `deprecated_legacy_crud_middleware` 注入 RFC 8594 弃用响应头 + 结构化 `legacy_api` 审计日志，前端 `tableAPI` 完成迁移后转 410 Gone | v2 在新版上叠加 "资产/产品维度" 路由组（同 `auth + rbac` 链路，无需重写 handler） |
| RateLimiter 已支持 tenant / user / endpoint / ip 四维规则（`management.rate_limit_rules`，30s 热加载，CRUD 后立即生效）；Redis 故障/缺失时按 `RATE_LIMIT_FALLBACK_MODE`（degraded/closed/open，默认 degraded）走本地兑底，与 Redis 强解耦不再 fail-open；多实例部署需配 `REQUIRE_REDIS=true` 让 Redis 缺失启动 fail-fast | v2 加 "按 API Key / 资产维度" 限流 |
| Webhook 出口已模块化 | v2 加目的地适配器（Kafka/RabbitMQ/Slack） |
| 审计已按项目维度聚合 | v2 直接复用做 "消费方调用报表" |
| LlmProvider trait | v2 用同一套接 NL2SQL 给资产消费方 |
| `POST/GET/PATCH/DELETE /api/admin/scheduled-tasks/*` 任务 CRUD / 触发 / 历史；`auth + require_superadmin (or tenant admin)`；执行身份每次重读 `is_superadmin` | v2 在同一组路由上叠加项目维度大盘 + 业务事件触发的事件驱动任务（与 webhook 边界划清） |

### v2 不做的事（明确边界）

- 不做计费引擎（继续走私有化 License）
- 不做 API 市场（开放交易），保持"内部资产共享"定位
- 不做协议转换（GraphQL / gRPC），保持 REST

---

## 5. 不做的事（明确不做，避免返工）

| 不做的事 | 原因 |
|---|---|
| 自动化部署 / IaC 平台 | 内核 0 存量；客户自己有 K8s + GitOps 实践 |
| 多 Region / 跨集群编排 | 客户场景未要求；引入会拖慢主线 |
| PG 自动 failover / Patroni 集成 | 让 CloudNativePG 干，不重复造轮子 |
| 全功能 APM | Prometheus/Loki 比自研强 10 倍，提供对接即可 |
| 通用 API 网关（管别人的 API） | 偏离主航道，方向 9 在矩阵里得分最低 |
| GraphQL / gRPC 端点 | 与 REST 主线冲突；客户没明确要 |
| AI Agent 自主执行 | 安全风险高，v1+v2 都不做 |

---

## 6. 风险与开放问题

### 6.1 已识别风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| Tenant→Project 重命名导致现有客户回归 | 中 | 保留 tenant 兼容字段，前端做 alias 显示 |
| AI 在私有化客户处无 LLM 可用 | 中 | M7 在 GA 前就支持自部署 vLLM 的部署文档 |
| Helm Chart 在客户的特殊 K8s 版本上失败 | 中 | M8 GA 前在 3 个主流 K8s 版本（1.24/1.27/1.30）测试 |
| 现有 Next.js 控制台改造引入回归 | 中 | M0 阶段先做完整 e2e 回归测试集 |
| License 颁发与续期流程未定 | 低 | M8 单独写一份《License 运营手册》 |

### 6.2 开放问题（待与用户确认）

- [ ] 现有客户 / 试点客户名单与 PG 版本范围
- [ ] License 颁发由谁负责（销售？技术？）
- [ ] AI 助手对话是否要支持多轮上下文（v1 单轮 vs 多轮）
- [ ] 项目工作空间是否需要"邀请外部成员"功能（涉及 SSO 域校验）

---

## 7. 衡量指标（GA 后 3 个月评估）

| 指标 | 目标 |
|---|---|
| 单客户内活跃项目数 | ≥ 5 |
| 开发者从注册到第一个成功 API 调用 | < 30 分钟 |
| 运维同事在客户处的日常介入次数 | < 1 次 / 周 / 客户 |
| AI 助手 NL2SQL 接受率 | ≥ 60% |
| 客户私有化部署平均耗时 | < 2 小时 |

---

## 8. 后续行动

1. **本文档评审**（用户）→ 改动 / 通过
2. **进入 writing-plans 技能** → 把 M0/MVP 拆成可执行的工程任务清单
3. **M0 启动** → 项目模型 + 中间件 + 控制台拆分

---

*本规划是对 `VISION.md` 北极星的具体落地路径，不替代它。所有命名、模型、API 命名以最终代码为准。*
