/**
 * 多语言基础配置。
 *
 * 采用「cookie 决定语言、URL 不变」的方案，而不是 next-intl 默认的
 * `/[locale]/...` 路由 —— 后者要求把所有页面搬进 `app/[locale]/`，会与
 * 现有 auth middleware 和 200+ 页面的路径全部冲突。这里语言只存在于
 * cookie（`planeos_locale`），服务端与客户端读同一个值，避免 hydration 抖动。
 */
export const LOCALES = ['en', 'zh', 'ja', 'ko'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

/** 语言的自称（下拉里用母语显示，符合 i18n 惯例）。 */
export const LOCALE_LABELS: Record<Locale, string> = {
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
}

/** 存放当前语言的 cookie 名。中间层与切换器共用。 */
export const LOCALE_COOKIE = 'planeos_locale'

export function isLocale(v: string | undefined | null): v is Locale {
  return !!v && (LOCALES as readonly string[]).includes(v)
}

/**
 * 从 Accept-Language 头挑一个受支持的语言，作为首次访问（无 cookie）时的默认。
 * 只做前缀匹配（zh-CN → zh），匹配不到回退到 DEFAULT_LOCALE。
 */
export function pickLocaleFromAcceptLanguage(header: string | null): Locale {
  if (!header) return DEFAULT_LOCALE
  for (const part of header.split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase()
    const base = tag.split('-')[0]
    if (isLocale(base)) return base
  }
  return DEFAULT_LOCALE
}
