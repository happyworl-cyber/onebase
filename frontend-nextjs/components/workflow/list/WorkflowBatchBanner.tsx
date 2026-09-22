'use client'

import type { RefObject } from 'react'
import { useTranslations } from 'next-intl'

interface WorkflowBatchBannerProps {
  visible: boolean
  selectedCount: number
  pageCount: number
  allPageSelected: boolean
  onTogglePageAll: () => void
  onClear: () => void
  bannerCheckboxRef?: RefObject<HTMLInputElement>
}

export default function WorkflowBatchBanner({
  visible,
  selectedCount,
  pageCount,
  allPageSelected,
  onTogglePageAll,
  onClear,
  bannerCheckboxRef,
}: WorkflowBatchBannerProps) {
  const t = useTranslations('wfList')
  return (
    <div className={`workflow-batch-banner ${visible ? 'show' : ''}`}>
      <input
        ref={bannerCheckboxRef}
        type="checkbox"
        className="workflow-batch-banner-check"
        checked={allPageSelected}
        onChange={onTogglePageAll}
        aria-label={t('selectAllPage')}
      />
      <span className="text-[11.5px] font-semibold text-indigo-700">{t('selectedN', { n: selectedCount })}</span>
      <button
        type="button"
        onClick={onTogglePageAll}
        className="text-[11px] text-indigo-600 underline font-medium bg-transparent border-none cursor-pointer hover:text-indigo-800"
      >
        {allPageSelected ? t('cancelSelectAll') : t('selectAllPageN', { n: pageCount })}
      </button>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onClear}
        className="text-[11px] text-slate-500 font-semibold bg-transparent border-none cursor-pointer hover:text-slate-700"
      >
        {t('clearSelection')}
      </button>
    </div>
  )
}
