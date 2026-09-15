import { HelpSection } from '@/components/help/HelpArticle'

export default function IntegrationsArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「集成」把项目连到外部系统，或把变更推出去。工作流节点会引用这里配好的连接。</p>
      </HelpSection>
      <HelpSection title="数据源">
        <p>「数据源」是项目内共享的数据库连接，给工作流里的数据库节点用，避免把主机密码写进每个流程。</p>
      </HelpSection>
      <HelpSection title="往外推">
        <p>
          「Webhook」在事件发生时 HTTP 推到你的 URL。「实时推送」把表变更写到 SSE topic，浏览器用 EventSource 订。
          订阅格式与字段以实时推送页的「使用说明」为准。
        </p>
      </HelpSection>
      <HelpSection title="外部存储与消息">
        <p>「ES 代理」「Redis」「Kafka」「对象存储」分别登记对应连接，供工作流或代理接口使用。先在这里建连接，再在工作流节点里选用。</p>
      </HelpSection>
    </>
  )
}
