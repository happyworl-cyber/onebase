# Provisioner Webhook Mock

本地联调 Onebase P3「运维自动开通」用的最小 HTTP mock。

## 启动

```bash
python3 examples/provisioner-webhook/mock_server.py
```

默认监听 `http://127.0.0.1:9090`。

## Onebase 配置

在 `.env` 中加入：

```env
PROVISION_WEBHOOK_URL=http://127.0.0.1:9090/provision
PROVISION_WEBHOOK_DEPROVISION_URL=http://127.0.0.1:9090/deprovision
PROVISION_WEBHOOK_TOKEN=dev-token
PROVISION_WEBHOOK_TIMEOUT_SECS=120
```

**注意**：mock 返回的 `postgresql.host=127.0.0.1` 仅用于验证 HTTP 契约与写库流程。真实环境应返回运维实际创建的 RDS / 容器地址。

## 测试流程

1. 启动 mock + Onebase 后端
2. 打开 `/workspace/provision`
3. 选择「运维自动开通」→ 完成创建
4. 检查 `tenant_databases` 与项目 `workspace_config.provisioned_via_webhook`
5. 删项目（超管 `/platform`）时若配置了 `PROVISION_WEBHOOK_DEPROVISION_URL`，会回调 deprovision
6. 勾选 Redis 时 mock 会返回 `redis.url` 与 `REDIS_URL` 环境变量

## 异步 poll 联调

```bash
MOCK_ASYNC=1 PROVISION_WEBHOOK_POLL_INTERVAL_SECS=2 python3 examples/provisioner-webhook/mock_server.py
```

或在 slug 使用 `async-` 前缀（如 `async-my-blog`），无需 `MOCK_ASYNC`。

Provisioner 先返回 `202 pending`，Onebase 自动 `action=poll` 直至 mock 返回 `postgresql`。

## 探活

超管在 `/platform/provision-settings` 点击「探活 Provisioner」，后端会对 `PROVISION_WEBHOOK_URL` 发 `{"action":"ping"}`。Mock 会返回 `200 {"ok":true,"message":"pong"}`。
