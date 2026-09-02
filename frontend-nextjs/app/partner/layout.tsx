'use client'

import PartnerSidebar from '@/components/partner/PartnerSidebar'

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-gray-50">
      <PartnerSidebar />
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  )
}
