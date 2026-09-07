'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_ITEMS = [
  {
    name: '概览',
    icon: 'fa-dashboard',
    href: '/partner',
  },
  {
    name: 'License 签发',
    icon: 'fa-certificate',
    href: '/partner/licenses',
  },
  {
    name: '佣金记录',
    icon: 'fa-coins',
    href: '/partner/commissions',
  },
  {
    name: '对账单',
    icon: 'fa-file-invoice-dollar',
    href: '/partner/statements',
  },
]

export default function PartnerSidebar() {
  const pathname = usePathname()

  return (
    <div className="w-64 bg-gray-900 h-screen flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center justify-center border-b border-gray-800">
        <h1 className="text-xl font-bold text-white">代理商控制台</h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors
                ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                }
              `}
            >
              <i className={`fas ${item.icon} w-5 mr-3`}></i>
              {item.name}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-gray-800">
        <Link
          href="/workspace"
          className="flex items-center px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
        >
          <i className="fas fa-arrow-left mr-3"></i>
          返回工作台
        </Link>
      </div>
    </div>
  )
}
