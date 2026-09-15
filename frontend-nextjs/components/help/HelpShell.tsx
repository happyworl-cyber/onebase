import type { ReactNode } from 'react'
import HelpToc from '@/components/help/HelpToc'

export default function HelpShell({
  base,
  slug,
  children,
}: {
  base: string
  slug: string | null
  children: ReactNode
}) {
  return (
    <div className="flex gap-6 min-h-full items-start">
      <HelpToc base={base} slug={slug} />
      <div className="flex-1 min-w-0 max-w-3xl">{children}</div>
    </div>
  )
}
