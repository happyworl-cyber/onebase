import { HelpSection } from '@/components/help/HelpArticle'

export default function DatabaseArticle() {
  return (
    <>
      <HelpSection title="这是什么">
        <p>「数据库」分组是对当前项目主连接里 PostgreSQL 对象的直接操作，不是对外 API 文档。</p>
      </HelpSection>
      <HelpSection title="结构">
        <p>
          「表」看数据和行编辑。「表设计器」可视化建表或改结构。「关系图」看表之间的关系。
          「Schema 浏览器」按 schema 浏览对象。「索引」和「扩展」分别管性能对象与 PG extension。
        </p>
      </HelpSection>
      <HelpSection title="查询与写入">
        <p>
          「SQL 编辑器」跑任意 SQL。「事务编辑器」把多条语句放进同一事务。写操作以你在项目里的角色为准。
        </p>
      </HelpSection>
      <HelpSection title="导入与备份">
        <p>「数据导入」把文件灌进表。「备份与恢复」导出或找回库数据。大操作前先确认连的是目标库。</p>
      </HelpSection>
    </>
  )
}
