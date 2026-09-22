'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { LOCALES, LOCALE_LABELS, LOCALE_COOKIE, type Locale } from '@/i18n/config'

/**
 * 内联语言切换（用于各授权后侧栏的用户菜单）。写 cookie（一年）后 router.refresh()
 * 让服务端按新语言重渲；客户端组件经 NextIntlClientProvider 拿到新词条即刻更新。
 */
export default function InlineLocaleSwitcher({ onChosen }: { onChosen?: () => void }) {
  const locale = useLocale() as Locale
  const router = useRouter()
  const t = useTranslations('common')

  function choose(next: Locale) {
    onChosen?.()
    if (next === locale) return
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
    router.refresh()
  }

  return (
    <div className="px-3 py-2">
      <div className="mb-1 flex items-center text-[11px] font-medium uppercase tracking-wide text-gray-400">
        <i className="fas fa-language text-xs w-4 mr-2"></i>
        {t('language')}
      </div>
      <div className="flex flex-wrap gap-1 pl-6">
        {LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => choose(l)}
            className={`rounded px-2 py-1 text-xs transition-colors ${
              l === locale ? 'bg-blue-50 font-medium text-blue-700' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {LOCALE_LABELS[l]}
          </button>
        ))}
      </div>
    </div>
  )
}
