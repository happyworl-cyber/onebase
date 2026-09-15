import { HelpSection } from '@/components/help/HelpArticle'

export default function AutomationArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「自动化」是会在库内或调度器里替你执行的逻辑，和一次性的 SQL 查询不同。</p>
      </HelpSection>
      <HelpSection title="函数与触发器">
        <p>
          「函数」是 PostgreSQL 函数，可被 REST/RPC 或触发器调用。「触发器」挂在表的 INSERT / UPDATE / DELETE 上，行变更时自动跑。
        </p>
      </HelpSection>
      <HelpSection title="工作流与定时任务">
        <p>
          「工作流」在画布上编排 HTTP、数据库、代码等节点，可被 API、其它工作流或定时任务触发。
          「定时任务」按 cron 启动工作流或其它已支持的任务类型。
        </p>
      </HelpSection>
      <HelpSection title="会话规则">
        <p>「会话规则」在数据库会话建立时注入 GUC / 连接行为，适合按请求设置角色或搜索路径。细节在该页配置。</p>
      </HelpSection>
    </>
  )
}
