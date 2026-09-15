import { HelpSection } from '@/components/help/HelpArticle'

export default function SettingsArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「设置」是项目级配置，不直接改表数据。部分项只有 owner / admin 能改。</p>
      </HelpSection>
      <HelpSection title="项目与人">
        <p>「项目信息」改名称等基本资料。「成员管理」加人、改角色、移出成员。</p>
      </HelpSection>
      <HelpSection title="密钥与变量">
        <p>
          「环境变量」给工作流运行时读。「凭证管理」存外部账号（含云日志用的密钥），密文不回显。
          「云日志源」指向凭证并填写 SLS 项目/Logstore，供诊断里的云日志页使用。
        </p>
      </HelpSection>
      <HelpSection title="连接与网关">
        <p>「数据库连接」是本项目连哪台 PostgreSQL。「网关域名」配置对外访问的网关基址。</p>
      </HelpSection>
    </>
  )
}
