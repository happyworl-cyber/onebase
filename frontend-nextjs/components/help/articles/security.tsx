import { HelpSection } from '@/components/help/HelpArticle'

export default function SecurityArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「安全」决定谁能进项目、能看哪些行、能调哪些函数、外部调用怎么鉴权。</p>
      </HelpSection>
      <HelpSection title="身份与角色">
        <p>
          「角色」是项目内 RBAC。「身份提供方」把外部登录连进来。
          成员名单在设置里的「成员管理」，不在本组。
        </p>
      </HelpSection>
      <HelpSection title="数据与函数">
        <p>「RLS」用 PostgreSQL 行级策略限制行可见性。「RPC ACL」控制哪些角色能调哪些函数。</p>
      </HelpSection>
      <HelpSection title="调用入口">
        <p>
          「API Key」发给外部系统，Key 以 <code className="font-mono text-xs">ob_</code> 开头。
          「网关策略」管对外域名上的访问控制。走网关时，调用方鉴权方式见「API 对接」。
        </p>
      </HelpSection>
    </>
  )
}
