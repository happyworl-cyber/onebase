'use client'

import PartnerSidebar from '@/components/partner/PartnerSidebar'
import { ToastProvider } from '@/components/Toast'

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="flex h-screen bg-gray-50">
        <PartnerSidebar />
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </div>
    </ToastProvider>
  )
}
