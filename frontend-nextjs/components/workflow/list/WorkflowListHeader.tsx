'use client'

import { cn } from '@/lib/utils'
import { useTranslations } from 'next-intl'
import { COMPACT_LIST_ACTIONS_CLASS, COMPACT_LIST_HEADER_GRID_CLASS } from './constants'

export default function WorkflowListHeader() {
  const t = useTranslations('wfList')
  return (
    <div
      className={cn(
        COMPACT_LIST_HEADER_GRID_CLASS,
        'py-2.5 border-b border-slate-100 bg-slate-50/80 text-xs font-medium uppercase tracking-wider text-slate-500 sticky top-0 z-10',
      )}
    >
      <span aria-hidden className="w-7" />
      <span>{t('colWorkflow')}</span>
      <span className="justify-self-start">{t('colTrigger')}</span>
      <span className="hidden sm:block justify-self-start">{t('colStatus')}</span>
      <span className="hidden md:block justify-self-start">{t('colAuthor')}</span>
      <span className="hidden md:block justify-self-start">{t('colLastEditor')}</span>
      <span className="hidden md:block justify-self-start">{t('colUpdated')}</span>
      <span className={cn(COMPACT_LIST_ACTIONS_CLASS, 'text-right')}>{t('colActions')}</span>
    </div>
  )
}
