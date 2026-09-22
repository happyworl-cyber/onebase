'use client'

import { useTranslations } from 'next-intl'

export type BatchModalType = 'export' | 'status' | 'delete' | 'move' | null

interface WorkflowBatchBarProps {
  visible: boolean
  count: number
  onExport: () => void
  onStatus: () => void
  onMove: () => void
  onDelete: () => void
  onClear: () => void
}

export default function WorkflowBatchBar({
  visible,
  count,
  onExport,
  onStatus,
  onMove,
  onDelete,
  onClear,
}: WorkflowBatchBarProps) {
  const t = useTranslations('wfList')
  return (
    <div className={`workflow-batch-bar ${visible ? 'show' : ''}`}>
      <div className="workflow-batch-bar-num">{count}</div>
      <span className="workflow-batch-bar-label">{t('selected')}</span>
      <button type="button" className="workflow-batch-btn workflow-batch-btn-export" onClick={onExport}>
        <i className="fas fa-arrow-down-to-line" />
        {t('export')}
      </button>
      <div className="workflow-batch-sep" />
      <button type="button" className="workflow-batch-btn workflow-batch-btn-status" onClick={onStatus}>
        <i className="fas fa-toggle-on" />
        {t('changeStatus')}
      </button>
      <div className="workflow-batch-sep" />
      <button type="button" className="workflow-batch-btn workflow-batch-btn-status" onClick={onMove}>
        <i className="fas fa-folder-tree" />
        {t('move')}
      </button>
      <div className="workflow-batch-sep" />
      <button type="button" className="workflow-batch-btn workflow-batch-btn-del" onClick={onDelete}>
        <i className="fas fa-trash" />
        {t('delete')}
      </button>
      <button type="button" className="workflow-batch-btn-x" onClick={onClear} title={t('cancelBatch')} aria-label={t('cancelBatch')}>
        <i className="fas fa-xmark" />
      </button>
    </div>
  )
}
