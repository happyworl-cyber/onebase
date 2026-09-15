import { HelpSection } from '@/components/help/HelpArticle'

export default function ApiAndRpcArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>表会自动暴露为 REST。数据库函数通过 RPC 调用。本页只讲在工作区里从哪看、怎么试；完整 curl 在 REST API 页。</p>
      </HelpSection>
      <HelpSection title="REST API">
        <p>
          「REST API」给出当前 schema 下表的读写端点、过滤/排序说明，以及可分享的公开文档链接。
          不要在帮助里找方法全集，以那一页为准。
        </p>
      </HelpSection>
      <HelpSection title="RPC 调用器">
        <p>「RPC 调用器」选一个函数、填参数并执行，用来确认函数在权限打开后能被外部调用。适合调试，不替代业务客户端。</p>
      </HelpSection>
    </>
  )
}
