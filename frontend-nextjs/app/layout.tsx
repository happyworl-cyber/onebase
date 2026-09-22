import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import './globals.css'
import AiAssistantPanel from '@/components/AiAssistantPanel'
import I18nErrorBridge from '@/components/I18nErrorBridge'
import { AI_ASSISTANT_ENABLED } from '@/lib/aiAssistant'

export const metadata: Metadata = {
  title: 'PlaneOS - Enterprise Data & Automation Platform',
  description: 'Enterprise Database Management Platform',
  icons: {
    icon: '/icon.svg',
  },
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // 语言与词条在服务端解析（见 i18n/request.ts），随 HTML 一起下发，
  // 客户端组件通过 NextIntlClientProvider 拿到同一份消息 —— 服务端 / 客户端
  // 一致，不会 hydration 抖动。
  const locale = await getLocale()
  const messages = await getMessages()

  return (
    <html lang={locale}>
      <head>
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"
        />
      </head>
      <body className="bg-gray-50 antialiased font-sans">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <I18nErrorBridge />
          {children}
          {AI_ASSISTANT_ENABLED && <AiAssistantPanel />}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
