import { getRequestConfig } from 'next-intl/server'
import { cookies, headers } from 'next/headers'
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  pickLocaleFromAcceptLanguage,
  type Locale,
} from './config'

/**
 * next-intl 的服务端请求配置。每个请求解析一次当前语言并加载对应词条。
 *
 * 语言解析优先级：cookie（用户显式选择）→ Accept-Language（首次访问）→ 默认。
 * 词条按语言整包加载；缺失的 key 由 next-intl 回退到消息本身的 key，不会崩。
 */
export default getRequestConfig(async () => {
  const cookieLocale = cookies().get(LOCALE_COOKIE)?.value
  const locale: Locale = isLocale(cookieLocale)
    ? cookieLocale
    : pickLocaleFromAcceptLanguage(headers().get('accept-language'))

  let messages
  try {
    messages = (await import(`../messages/${locale}.json`)).default
  } catch {
    messages = (await import(`../messages/${DEFAULT_LOCALE}.json`)).default
  }

  return { locale, messages }
})
