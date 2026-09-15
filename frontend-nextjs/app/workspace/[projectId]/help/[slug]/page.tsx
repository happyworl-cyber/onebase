'use client'

import { useParams } from 'next/navigation'
import HelpArticle from '@/components/help/HelpArticle'
import HelpShell from '@/components/help/HelpShell'
import { getHelpArticleBody } from '@/components/help/articles'
import { getHelpArticle } from '@/lib/helpCatalog'

export default function HelpArticlePage() {
  const params = useParams<{ projectId: string; slug: string }>()
  const base = `/workspace/${params.projectId}`
  const slug = params.slug
  const article = getHelpArticle(slug)
  const Body = getHelpArticleBody(slug)

  return (
    <HelpShell base={base} slug={slug}>
      <HelpArticle base={base} article={article && Body ? article : undefined}>
        {article && Body ? <Body /> : null}
      </HelpArticle>
    </HelpShell>
  )
}
