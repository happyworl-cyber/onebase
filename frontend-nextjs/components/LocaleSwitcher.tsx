'use client'

import { useLocale } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState, useRef, useEffect } from 'react'
import { LOCALES, LOCALE_LABELS, LOCALE_COOKIE, type Locale } from '@/i18n/config'

/**
 * 语言切换器。写 cookie 后 router.refresh() 让服务端按新语言重渲。
 * 语言存 cookie（一年有效），下次访问自动沿用。
 */
export default function LocaleSwitcher({ className = '' }: { className?: string }) {
  const locale = useLocale() as Locale
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  function choose(next: Locale) {
    setOpen(false)
    if (next === locale) return
    // max-age 一年；path=/ 让所有页面共享
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
    router.refresh()
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.5 3.5 6 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-6-3.5-9s1-6.5 3.5-9z" />
        </svg>
        <span>{LOCALE_LABELS[locale]}</span>
        <svg viewBox="0 0 20 20" className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="currentColor">
          <path d="M5.5 7.5L10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-36 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => choose(l)}
              className={`block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 ${
                l === locale ? 'font-medium text-primary-700' : 'text-slate-700'
              }`}
            >
              {LOCALE_LABELS[l]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
