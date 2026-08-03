# 成长动画 SSE — 业务前端接入参考

> 本文件供**业务前端团队**（独立仓库）拷贝参考。OneBase 只提供端点契约 + 这段参考代码 +
> 监控页；动画队列、claim/ack 业务逻辑由业务前端自行实现。

## 1. 端点契约

> 成长动画现为**通用对外端点**的一个配置（slug=`growth-animation`），由后台「实时推送规则 →
> 对外端点」页维护，不再是硬编码路由。下面的 URL 即该配置渲染出的对外地址。

### 唤醒流（SSE）

```
GET /events/growth-animation            # 推荐：一条连接覆盖该用户全部社区
GET /events/growth-animation?projectId=1 # 可选：只订阅单个社区
```

- **鉴权**：无需 JWT。用户身份由**上游网关注入的 `X-Way-UID`** 头确定；浏览器 `EventSource`
  不能自定义头，故该头必须由网关在转发到 OneBase 时注入（前端无需也无法自带）。
- **事件**：
  - `event: connected`，`data: {"ok":true}`（带 `projectId` 时附 `"projectId":N`）——连接确认。
  - `event: growth_animation_available`，`data: {"eventId":123,"projectId":1,"eventType":"level_unlock"}`
    ——有新唤醒。**前端按 `data.projectId` 路由到对应社区**。
  - 注释心跳 `: heartbeat`（每 25s）——浏览器自动忽略。
- **错误**：缺 `X-Way-UID` → 401；`projectId` 传了但非整数 → 400。

### claim / ack（RPC）

收到唤醒后，经 OneBase 的 PostgREST 风格 RPC 调业务 DB 函数：

```
POST /api/v1/{databaseId}/rpc/{fn_name}
```

- 抢 lease：`console_claim_growth_animation_events`（只有抢到的浏览器播放，避免多端重复）；
- 播放完成：`console_ack_growth_animation_event`。

> 这些函数由业务方在 DB 侧实现；`{databaseId}` 与函数名以业务方约定为准。
> 实际请求一般经业务网关转发到 OneBase（网关注入 `X-Way-UID` 等身份头）。

## 2. 参考 Hook（React + TypeScript）

```tsx
import { useEffect, useRef } from 'react'

type GrowthEvent = { eventId: number; projectId: number; eventType: string }

// 一条连接覆盖该用户全部社区；onWake 回调里按 projectId 路由到对应社区。
export function useGrowthAnimationStream(
  baseUrl: string,
  onWake: (ev: GrowthEvent) => void
) {
  const onWakeRef = useRef(onWake)
  onWakeRef.current = onWake

  useEffect(() => {
    // 不传 projectId：通配订阅 way:{wayUid}:growth:*
    const es = new EventSource(`${baseUrl}/events/growth-animation`, {
      withCredentials: true, // 若网关用 cookie 透传身份
    })

    es.addEventListener('growth_animation_available', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as GrowthEvent
        onWakeRef.current(data)
      } catch {
        /* 忽略脏消息 */
      }
    })

    es.onerror = () => {
      // EventSource 默认自动重连；如需退避/熔断可在此扩展。
    }

    return () => es.close()
  }, [baseUrl])
}
```

使用：

```tsx
useGrowthAnimationStream(API_BASE, (ev) => {
  // 1) 仅处理当前激活社区（按 projectId 路由）
  if (ev.projectId !== currentProjectId) return
  // 2) 抢 lease（claim）
  claimAndPlay(ev)
})

async function claimAndPlay(ev: GrowthEvent) {
  const claimed = await rpc(databaseId, 'console_claim_growth_animation_events', {
    project_id: ev.projectId,
  })
  if (!claimed?.length) return // 没抢到 → 别的端在播
  await playAnimations(claimed)
  for (const item of claimed) {
    await rpc(databaseId, 'console_ack_growth_animation_event', { event_id: item.eventId })
  }
}
```

## 3. 多标签页（业务前端职责，非 OneBase）

同一社区开多个标签页时，每个标签都会各自建一条 `EventSource`（浏览器原生限制）。
若想全用户只保留一条流并在标签间共享，业务前端可用 `BroadcastChannel` 或 `SharedWorker`
做主从选举：仅"主标签"持流，收到唤醒后经 `BroadcastChannel` 广播给其它标签。OneBase
侧不处理这一层。`console_claim_*` 的 lease 本身也能兜底防止多端重复播放。

## 4. 上线前对接清单

- [ ] 网关在 `/events/growth-animation` 注入可信 `X-Way-UID`（剥离客户端自带值）。
- [ ] 业务 DB 已建 `gamesq.growth_animation_event` 表、`NOTIFY growth_animation_available` 触发器、
      `console_claim/ack/requeue_*` 函数。
- [ ] 运维在 `management.sse_notify_bridges` 插入成长动画那一行（见迁移
      `024_sse_notify_bridges.sql` 末尾示例 INSERT，把 `<BUSINESS_DB_ID>` 换成实际业务库 id）。
- [ ] OneBase 监控页「实时推送规则 → 推送监控」可见对应 listener 已连接、收到/推送计数增长。
```
