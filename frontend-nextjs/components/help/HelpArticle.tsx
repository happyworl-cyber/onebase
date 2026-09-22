import type { ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { HelpArticleMeta } from '@/lib/helpCatalog'

export function HelpSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      <div className="space-y-2 text-sm text-gray-700 leading-relaxed">{children}</div>
    </section>
  )
}

export function HelpCode({ children }: { children: string }) {
  return (
    <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 text-xs overflow-x-auto leading-relaxed">
      {children}
    </pre>
  )
}

function relatedHref(base: string, href: string): string {
  return href === '' ? base : `${base}${href}`
}

export default function HelpArticle({
  base,
  article,
  children,
}: {
  base: string
  article: HelpArticleMeta | undefined
  children?: ReactNode
}) {
  const t = useTranslations('helpArticleShell')
  const tCat = useTranslations('helpCatalog')

  if (!article) {
    return (
      <div>
        <h1 className="text-lg font-semibold text-gray-900 mb-2">{t('notFoundTitle')}</h1>
        <p className="text-sm text-gray-600">{t('notFoundBody')}</p>
      </div>
    )
  }

  return (
    <article className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold text-gray-900">{tCat(article.title)}</h1>
        <p className="text-sm text-gray-600">{tCat(article.summary)}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {article.related.map((rel) => (
            <Link
              key={`${rel.href}:${rel.label}`}
              href={relatedHref(base, rel.href)}
              className="inline-flex items-center rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              {t('relatedLink', { label: tCat(rel.label) })}
            </Link>
          ))}
        </div>
      </header>
      <div className="space-y-5">{children}</div>
    </article>
  )
}
