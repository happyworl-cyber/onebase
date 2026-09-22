'use client'

import { useEffect } from 'react'
import { useTranslations, useMessages } from 'next-intl'
import { setErrorTranslator } from '@/lib/i18nBridge'

/**
 * 把 errorCodes 词条注入到 lib/i18nBridge，供 axios 拦截器（React 树外）按后端
 * 错误 code 翻译。语言切换时 messages 变化 → 重新注册对应语言的解析器。
 * 只对 errorCodes 里存在的 code 返回译文，未收录的 code 回退到后端原文。
 */
export default function I18nErrorBridge() {
  const t = useTranslations('errorCodes')
  const messages = useMessages() as Record<string, unknown>

  useEffect(() => {
    const codes = (messages?.errorCodes as Record<string, unknown>) || {}
    setErrorTranslator((code, params) =>
      Object.prototype.hasOwnProperty.call(codes, code) ? t(code, params as any) : null,
    )
    return () => setErrorTranslator(null)
  }, [t, messages])

  return null
}
