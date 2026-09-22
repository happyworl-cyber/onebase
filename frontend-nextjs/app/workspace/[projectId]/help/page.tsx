'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import HelpShell from '@/components/help/HelpShell'
import { HELP_ARTICLES, HELP_GROUPS } from '@/lib/helpCatalog'

export default function HelpIndexPage() {
  const params = useParams<{ projectId: string }>()
  const t = useTranslations('wsHelp')
  const tCat = useTranslations('helpCatalog')
  const base = `/workspace/${params.projectId}`

  return (
    <HelpShell base={base} slug={null}>
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{t('title')}</h1>
          <p className="mt-1 text-sm text-gray-600">
            {t('subtitle')}
          </p>
        </div>
        {HELP_GROUPS.map((group) => (
          <section key={group.id} className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-900">{tCat(group.label)}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {HELP_ARTICLES.filter((a) => a.group === group.id).map((article) => (
                <Link
                  key={article.slug}
                  href={`${base}/help/${article.slug}`}
                  className="block rounded-lg border border-gray-200 bg-white p-3 hover:border-blue-200 hover:bg-blue-50/40"
                >
                  <div className="text-[13px] font-medium text-gray-900">{tCat(article.title)}</div>
                  <div className="mt-1 text-xs text-gray-600 leading-relaxed">{tCat(article.summary)}</div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </HelpShell>
  )
}
