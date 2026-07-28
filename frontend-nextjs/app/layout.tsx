import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'OneBase - PostgreSQL 管理平台',
  description: 'Enterprise Database Management Platform',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <head>
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"
        />
      </head>
      <body className="bg-gray-50 antialiased font-sans">{children}</body>
    </html>
  )
}

