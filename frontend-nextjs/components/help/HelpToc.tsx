import Link from 'next/link'
import { HELP_ARTICLES, HELP_GROUPS } from '@/lib/helpCatalog'

export default function HelpToc({
  base,
  slug,
}: {
  base: string
  slug: string | null
}) {
  return (
    <nav className="w-[200px] flex-shrink-0">
      <div className="sticky top-0 space-y-4">
        <Link
          href={`${base}/help`}
          className={`block text-[13px] font-medium ${
            slug === null ? 'text-blue-600' : 'text-gray-700 hover:text-gray-900'
          }`}
        >
          使用帮助
        </Link>
        {HELP_GROUPS.map((group) => (
          <div key={group.id}>
            <div className="px-0.5 mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {HELP_ARTICLES.filter((a) => a.group === group.id).map((article) => {
                const active = slug === article.slug
                return (
                  <li key={article.slug}>
                    <Link
                      href={`${base}/help/${article.slug}`}
                      className={`block rounded-md px-2.5 py-1.5 text-[13px] ${
                        active
                          ? 'bg-blue-50 text-blue-600 font-medium'
                          : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                      }`}
                    >
                      {article.title}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  )
}
