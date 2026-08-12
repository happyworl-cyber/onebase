# Kafka 管理台创建 Topic 设计

> 状态：implemented（2026-07-23）。
>
> 上游：`docs/superpowers/specs/2026-07-21-kafka-workflow-integration-design.md`（连接注册表 + AdminClient list_topics）。
>
> 范围锁定：仅 JWT 管理台；不做令牌 REST / 工作流节点 / 删除与改配置。

## 1. 目标与非目标

### 1.1 目标

在 Kafka 数据源页的 **Topics** 标签中支持创建 topic，使项目成员无需离开 OneBase 即可为工作流准备 topic（例如 `onebase.ai-close-ticket`）。

1. JWT Admin API：`POST /api/admin/kafka-connections/:id/topics`
2. 请求体：`name` + `num_partitions` + `replication_factor`
3. Topics 页「新建 Topic」表单；成功后刷新列表
4. 鉴权与现有 list topics / 令牌管理相同：能打开该连接页的项目成员

### 1.2 非目标

| 不做 | 说明 |
|---|---|
| `obes_kafka_*` 令牌 create | 本次明确选 A，不扩 ops 白名单 |
| 工作流 Kafka 节点 `create_topic` | 同上 |
| 删除 topic / 改分区 / 改配置 | YAGNI；高级 config 键值对不做 |
| 依赖 broker `auto.create.topics.enable` | 显式 Admin API 创建，行为可预期 |

## 2. 关键决定

| 决定 | 选项 | 理由 |
|---|---|---|
| 入口 | **独立 Admin POST（方案 1）** | 与 `GET .../topics` 对称；不搅令牌/exec |
| 参数 | **name + partitions + RF** | 够用且安全；默认值 UI 填 1/1 |
| 权限 | **项目成员 JWT（与现有 Kafka 页一致）** | 复用 `fetch_connection_authorized` |
| 令牌 / 工作流 | **不做** | 范围 A |

## 3. 架构

```
JWT ──► GET  /api/admin/kafka-connections/:id/topics   （已有 list）
JWT ──► POST /api/admin/kafka-connections/:id/topics   （新增 create）
                       │
                       ▼
         kafka_ds::commands::create_topic
                       │
                       ▼
              rdkafka AdminClient::create_topics
```

模块改动：

```
src/kafka_ds/commands.rs     # + create_topic；校验 name/partitions/rf
src/kafka_handlers.rs        # + create_topic handler（CreateTopicReq）
src/main.rs                  # 同一 path 挂 method_router get+post
frontend-nextjs/lib/api.ts   # kafkaAPI.createTopic
frontend-nextjs/.../kafka-connections/page.tsx  # TopicsTab 表单
```

**刻意不改**：`kafka_ds/auth.rs` 的 `DEFAULT_OPS`、`kafka_app_handlers`、工作流 `NodeType::Kafka` / `SUPPORTED_OPS` 对外令牌面（JWT `exec` 也不新增 `create_topic`，避免误当成通用命令面）。

## 4. API

### 4.1 `POST /api/admin/kafka-connections/:id/topics`

鉴权：与 `list_topics` 相同（`fetch_connection_authorized` + 连接 `is_active`）。

请求 JSON：

```json
{
  "name": "onebase.ai-close-ticket",
  "num_partitions": 3,
  "replication_factor": 1
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `name` | string | trim 后非空；长度 ≤ 249；不允许空白/控制字符；不允许 `.` / `..` 作为完整名；建议允许 `[a-zA-Z0-9._-]`（与常见 Kafka 命名一致；非法字符 → 400） |
| `num_partitions` | integer | `1..=100` |
| `replication_factor` | integer | `1..=10`（超过集群 broker 数时由 Kafka 报错，映射为 4xx/503 可读信息） |

成功 `200`：

```json
{
  "ok": true,
  "topic": "onebase.ai-close-ticket",
  "num_partitions": 3,
  "replication_factor": 1
}
```

错误：

| 情况 | 行为 |
|---|---|
| 参数非法 | `400` + 中文说明 |
| topic 已存在 | `400`「topic 已存在」 |
| 连接不存在/禁用 | `404`（与 list 一致） |
| 无项目权限 | 现有 permissions 错误 |
| Broker 拒绝 / 超时 | `503` 或 `500`，带 Kafka 错误摘要 |

实现注意：`create_topics` 的 per-topic 结果需检查；`TopicAlreadyExists` 显式映射，勿一律 Internal。

## 5. 命令层

`kafka_ds::commands::create_topic(conn, name, num_partitions, replication_factor) -> Result<Value>`：

1. 校验参数（纯逻辑，单测覆盖边界）
2. 用现有 `build_client_config` + `AdminClient`（与 `list_topics` 同源）
3. `NewTopic::new(name, TopicReplication::Fixed(rf)).num_partitions(partitions)`（或等价 rdkafka API）
4. 超时：`connection_timeout(conn)`
5. 返回 §4.1 成功 JSON 的内层字段

不把 `create_topic` 加入 `commands::execute` / `SUPPORTED_OPS`（本次仅 Admin handler 直调）。

## 6. 前端

`TopicsTab`：

- 列表头右侧：现有「刷新」旁增加「新建 Topic」
- 点击展开简易表单（弹层或内联均可；优先轻量内联/小 modal，对齐页内既有风格）
  - 名称（必填）
  - 分区数（默认 `1`）
  - 副本因子（默认 `1`）
- 提交 → `kafkaAPI.createTopic(id, body)` → 成功 toast/提示 → 重新 `listTopics`
- 失败展示 `error` 文案

`lib/api.ts`：`createTopic(id, { name, num_partitions, replication_factor })` → `POST .../topics`。

接入指南（Usage）**不**增加 create curl（令牌面无此能力）。

## 7. 测试

| 层 | 覆盖 |
|---|---|
| 单元 | name / partitions / rf 校验（空名、非法字符、越界） |
| 单元或集成（若环境允许） | TopicAlreadyExists 映射 |
| 手工 | 管理台对「测试Kafka」创建 topic → 刷新可见；无权限/禁用连接拒绝 |

## 8. 验收

1. 项目成员在 Topics 页可创建 topic（名称 + 分区 + 副本）
2. 创建成功后列表出现新 topic，无需出 OneBase
3. 重复创建返回明确「已存在」
4. 令牌 REST / 工作流节点行为不变（无 create）
