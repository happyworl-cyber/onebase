import { HelpSection } from '@/components/help/HelpArticle'

export default function DiagnosticsArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「诊断与监控」只读观测：看现在是否健康、一次请求走过哪里、哪条 SQL 慢或堵住。</p>
      </HelpSection>
      <HelpSection title="看现状">
        <p>「监控大盘」看项目级指标与趋势。先看这里，再决定要不要下钻日志。</p>
      </HelpSection>
      <HelpSection title="三类日志">
        <p>
          「执行日志」是平台记下的工作流/任务执行。「操作日志」是谁在工作区做了什么。
          「云日志」按项目配置的日志源（如阿里云 SLS）代查，用来对 <code className="font-mono text-xs">x_request_id</code>。
        </p>
      </HelpSection>
      <HelpSection title="语句与阻塞">
        <p>「语句分析」看 SQL 形态与耗时。「慢查询」列出超阈值语句。「锁与阻塞」看谁堵住了谁。</p>
      </HelpSection>
    </>
  )
}
