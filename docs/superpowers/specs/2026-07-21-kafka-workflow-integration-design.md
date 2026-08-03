# Kafka 连接与工作流集成设计

> 状态：design approved（2026-07-21），待 spec review。
>
> 对齐参考：Redis 连接注册表（`management.redis_connections` + `redis` 节点）、工作流 NOTIFY 触发器（`workflow_notify_trigger`）。
>
> 相关上游：`docs/superpowers/specs/2026-05-13-platform-evolution-design.md`（目的地适配器 wishlist 中的 Kafka）。

## 1. 目标与非目标

### 1.1 目标

让租户登记自有 Kafka 集群，并在工作流中：

1. **生产消息**：通过专用 `kafka` 节点 `produce` 到指定 topic
2. **消费触发**：`trigger_type = "kafka"` 的常驻 consumer 收到消息后启动工作流（at-least-once）
3. **连接管理**：CRUD、健康检查、`list_topics` 探测（管理页），密钥加密存储

### 1.2 非目标（首期）

| 不做 | 说明 |
|---|---|
| mTLS 客户端证书 | 首期 SASL/PLAIN\|SCRAM + 可选 TLS；证书认证后续 |
| Schema Registry / Avro / Protobuf | value 按 `json` 或 `text` 处理 |
| 事务消息 / 精确一次 | 固定 at-least-once；工作流需幂等 |
| 工作流节点内长轮询 consume | 消费只走触发器 |
| Kafka Streams / Connect | 超出平台范围 |
| 任意 Admin API | 仅 `list_topics` + health |
| 塞进 `wf_datasources` | SQL datasource 路径不适合 messaging |
| 修改 provision-webhook 允许 `kafka` 资源 | 与本能力无关；保持现状拒绝即可 |

## 2. 关键决定（来自 brainstorming）

| 决定 | 选项 | 理由 |
|---|---|---|
| 能力范围 | **Produce + Kafka 触发工作流** | 覆盖出站与入站事件驱动 |
| 认证 | **SASL/PLAIN\|SCRAM + 可选 TLS**；mTLS 后续 | 覆盖常见生产配置，对齐 Redis 密码加密模式 |
| 投递语义 | **At-least-once**（成功后再 commit） | 失败可重试；调用方保证幂等 |
| 节点操作 | **节点仅 `produce`**；管理页 `list_topics`/health | 与 Redis allowlist 思路一致 |
| 架构路径 | **Redis 同构：连接注册表 + 节点 + 触发器** | 不复用 `wf_datasources`；触发器对齐 `notify`/`cron` |

## 3. 架构

### 3.1 模块布局

```
migrations/<next>_kafka_connections.sql   # 使用仓库当前下一个 migration 序号

src/kafka_ds/
├── mod.rs              fetch_active / fetch_active_for_tenant
├── models.rs           KafkaConnection（secrets skip_serializing）
├── client_cache.rs     producer cache + invalidate
└── commands.rs         allowlisted ops: produce, list_topics

src/kafka_handlers.rs           管理 CRUD + health + topics + 可选 exec
src/workflow_kafka_trigger.rs   常驻 consumer 管理（对齐 notify trigger）

src/workflow_engine.rs          NodeType::Kafka + exec_kafka_node
src/workflow_handlers.rs        允许 trigger_type = "kafka"
src/lib.rs                      pub mod kafka_ds
src/main.rs                     路由注册 + start_kafka_trigger
```

前端：

```
frontend-nextjs/app/workspace/[projectId]/events/kafka-connections/page.tsx
frontend-nextjs/lib/api.ts                      kafkaAPI
frontend-nextjs/components/workspace/workspaceNav.ts
frontend-nextjs/components/workflow/
  NodeTypes.tsx / WorkflowCanvas.tsx / NodeConfigPanel.tsx
  （触发器选择与 TRIGGER_META）
```

### 3.2 数据流

```
[管理 API CRUD] ──→ management.kafka_connections
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   [health/topics]   [kafka 节点 produce]  [kafka 触发器]
          │                │                │
          │                ▼                ▼
          │         producer cache    consumer (group_id)
          │                │                │
          │                ▼                ▼
          │            Kafka cluster   execute_workflow_internal
          │                                 │
          │                                 ▼ Ok
          │                            commit offset
```

## 4. 连接模型与安全

### 4.1 表 `management.kafka_connections`

对齐 `046_redis_connections.sql` 的租户隔离与加密约定：

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `tenant_id` | INTEGER NOT NULL → tenants | 无平台级 Kafka 数据源 |
| `connection_name` | VARCHAR(100) | UNIQUE `(tenant_id, connection_name)` |
| `brokers` | TEXT NOT NULL | bootstrap，逗号分隔，如 `kafka1:9092,kafka2:9092` |
| `security_protocol` | TEXT NOT NULL | `PLAINTEXT` \| `SASL_PLAINTEXT` \| `SASL_SSL` \| `SSL` |
| `sasl_mechanism` | TEXT | 可空；`PLAIN` \| `SCRAM-SHA-256` \| `SCRAM-SHA-512` |
| `sasl_username` | TEXT | 可空 |
| `sasl_password_enc` | TEXT | AES-GCM；无密码为 NULL；**永不序列化给前端** |
| `tls_insecure_skip_verify` | BOOLEAN DEFAULT false | 仅非生产调试；默认 false |
| `connect_timeout_secs` | INTEGER DEFAULT 5 | 1–60 |
| `is_active` | BOOLEAN DEFAULT true | false 时停止使用（含触发器） |
| `created_by` | INTEGER → users | |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

约束要点：

- `SASL_*` 协议要求 `sasl_mechanism` + `sasl_username` 非空（应用层校验；DB CHECK 可选）
- `PLAINTEXT`/`SSL` 时忽略 SASL 字段
- brokers 不允许空白行；至少一段 `host:port`

### 4.2 API

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET/POST | `/api/admin/kafka-connections` | 超管或租户 owner/admin | 列表 / 创建 |
| GET/PATCH/DELETE | `/api/admin/kafka-connections/:id` | 同上 | 详情 / 更新 / 删除 |
| POST | `/api/admin/kafka-connections/:id/health` | 同上 | 建连探测 |
| GET | `/api/admin/kafka-connections/:id/topics` | 同上 | `list_topics` |
| POST | `/api/kafka-connections/:id/exec` | 成员（写操作限制 viewer） | 可选；首期支持 `produce` 探测 |

响应约定：

- 列表/详情返回 `has_password: bool`，不返回 `sasl_password_enc`
- 更新密码：仅当请求体带非空 `sasl_password` 时重加密覆盖；省略则保留原值

### 4.3 客户端缓存

- Producer：按 `connection_id` 缓存；连接 PATCH/DELETE/`is_active=false` 时 `invalidate`
- Consumer：由触发器管理任务持有，不进与 produce 共用的 cache（生命周期不同）
- 建议 Rust crate：`rdkafka`（或当时 workspace 已选定的等价客户端），配置从连接行映射

## 5. 工作流 `kafka` 生产节点

### 5.1 节点类型

- `NodeType::Kafka`，serde `"kafka"`
- 默认配置：`{ "connection_id": 0, "op": "produce", "topic": "", "key": "", "value": "" }`

### 5.2 配置字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `connection_id` | 是 | 租户下 `is_active` 连接 |
| `op` | 是 | 首期仅 `produce` |
| `topic` | 是 | 支持模板 |
| `key` | 否 | 空 = 无 key；支持模板 |
| `value` | 是 | 字符串；若解析后为 JSON 对象/数组则 `serde_json` 序列化后发送；支持模板 |
| `headers` | 否 | `Record<string, string>`；值可模板化 |

### 5.3 执行语义

1. 解析模板（`{{trigger.x}}` / `{{nodeId.field}}`）
2. `fetch_active_for_tenant(connection_id, tenant_id)`；失败则节点失败
3. `dry_run` / `prod_readonly`：mock produce，输出占位 `{ mocked: true, topic, key }`，不触达集群
4. 否则 `commands::produce`；超时建议 10s
5. 成功输出：`{ topic, partition, offset, key }` 供下游引用

不允许：任意 Kafka Admin、consume、flush-all 类操作。

## 6. Kafka 触发器

### 6.1 触发类型

新增 `trigger_type = "kafka"`，同步更新：

- `workflow_handlers` 创建/更新/导入校验白名单
- MCP tools enum（若有）
- 前端 `TRIGGER_META` / 创建与编辑表单

### 6.2 `trigger_config`

| 字段 | 默认 | 说明 |
|---|---|---|
| `connection_id` | 必填 | Kafka 连接 |
| `topic` | 必填 | 订阅 topic |
| `group_id` | `onebase-wf-{workflow_id}` | 允许自定义；同 group 多副本靠分区再平衡 |
| `auto_offset_reset` | `latest` | 或 `earliest` |
| `value_format` | `json` | `json`：解析进 `payload`，失败则 `payload=null` 保留 raw；`text`：`payload` 为字符串 |

### 6.3 运行模型

对齐 `workflow_notify_trigger`：

1. `main` 启动 `workflow_kafka_trigger::start_kafka_trigger(pool)`
2. 每 ~10s 扫描 `trigger_type='kafka' AND is_enabled=true`
3. 解析有效配置；连接必须存在且 `is_active`
4. 按 `(connection_id, topic, group_id)` 去重启停 consumer task
5. 配置变更或工作流禁用 → abort 旧 task 并按需重建

### 6.4 消息处理（at-least-once）

对每条消息（对齐 `workflow_notify_trigger` / `workflow_cron_trigger`）：

1. 组装 `trigger_data`（见下）
2. **直接 `await workflow_handlers::execute_workflow_internal(...)`**（不要 fire-and-forget；必须在 commit 前拿到成功/失败）
3. **仅 `Ok` 时 commit offset**
4. 失败：不 commit；记录日志 + 计数；短退避后再 poll，避免 tight loop 打爆下游

说明：HTTP 端点用的 `run_workflow_detached` 是为客户端断连设计的；Kafka 触发器与 cron/notify 一样走 `execute_workflow_internal`。

多实例部署：不引入分布式锁；依赖同一 `group_id` 的 Kafka 分区分配。

### 6.5 `trigger_data` 形态

```json
{
  "kafka": {
    "connection_id": 1,
    "topic": "orders",
    "partition": 0,
    "offset": 123,
    "key": "optional-key",
    "headers": { "x-trace": "..." },
    "value_raw": "{\"order_id\":1}"
  },
  "payload": { "order_id": 1 }
}
```

模板示例：`{{trigger.payload.order_id}}`、`{{trigger.kafka.topic}}`、`{{trigger.kafka.offset}}`。

## 7. 前端

### 7.1 连接管理

- 导航「集成」下新增 Kafka，路由：`/workspace/{projectId}/events/kafka-connections`
- UI 对齐 Redis 连接页：列表、创建/编辑、启用停用、删除、health、topics 列表
- 表单字段覆盖 §4.1（密码只写不回显）

### 7.2 工作流编辑

- 调色板增加 `kafka` 节点；`KafkaNodeConfig`：连接下拉、topic/key/value/headers
- 触发器类型增加 Kafka：配置 connection、topic、group_id、auto_offset_reset、value_format
- 列表徽章 / 文档说明同步

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 连接不可达 / SASL 失败 | health 返回明确错误；produce 节点失败写入 run 日志 |
| topic 不存在 | produce/consume 失败，错误透出 |
| 触发工作流失败 | 不 commit；退避重试；metrics/log |
| dry_run / prod_readonly | produce mock |
| 跨租户 / 无权限 | 403 |
| 连接停用 | 触发器停止 consumer；节点 produce 失败 |

## 9. 测试要点

- **单元**：`trigger_config` 解析与默认 `group_id`；`trigger_data` 组装（json/text）；allowlist ops；模板解析
- **集成（可 mock client）**：CRUD + 密码加密；produce 节点 dry_run；触发器 enable/disable 启停；失败不 commit
- **手工**：PLAIN + SASL_SSL/SCRAM 真实集群；消息触发工作流；produce 节点写出并可被下游消费验证

## 10. 实现顺序建议

1. Migration + `kafka_ds` models/cache/commands + handlers/routes
2. 前端连接管理页 + `kafkaAPI`
3. `NodeType::Kafka` + 节点 UI + dry_run
4. `workflow_kafka_trigger` + `trigger_type` 白名单 + 前端触发器表单
5. 测试与文档（Workspace 内简短使用说明即可，不另开无关 markdown）

## 11. 验收标准

1. 租户可登记 Kafka 连接（含 SASL + TLS），密码不回显，health/`list_topics` 可用
2. 工作流 `kafka` 节点可 produce；dry_run 不触达集群
3. `trigger_type=kafka` 启用后能消费消息并启动工作流；成功后 offset 前进；失败可重投
4. 连接停用或工作流禁用后 consumer 停止
5. 租户隔离：不能使用其他租户的 `connection_id`
