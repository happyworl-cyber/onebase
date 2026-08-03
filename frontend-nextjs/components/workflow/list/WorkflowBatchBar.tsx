'use client'

export type BatchModalType = 'export' | 'status' | 'delete' | null

interface WorkflowBatchBarProps {
  visible: boolean
  count: number
  onExport: () => void
  onStatus: () => void
  onDelete: () => void
  onClear: () => void
}

export default function WorkflowBatchBar({
  visible,
  count,
  onExport,
  onStatus,
  onDelete,
  onClear,
}: WorkflowBatchBarProps) {
  return (
    <div className={`workflow-batch-bar ${visible ? 'show' : ''}`}>
      <div className="workflow-batch-bar-num">{count}</div>
      <span className="workflow-batch-bar-label">已选中</span>
      <button type="button" className="workflow-batch-btn workflow-batch-btn-export" onClick={onExport}>
        <i className="fas fa-arrow-down-to-line" />
        导出
      </button>
      <div className="workflow-batch-sep" />
      <button type="button" className="workflow-batch-btn workflow-batch-btn-status" onClick={onStatus}>
        <i className="fas fa-toggle-on" />
        修改状态
      </button>
      <div className="workflow-batch-sep" />
      <button type="button" className="workflow-batch-btn workflow-batch-btn-del" onClick={onDelete}>
        <i className="fas fa-trash" />
        删除
      </button>
      <button type="button" className="workflow-batch-btn-x" onClick={onClear} title="取消批量操作" aria-label="取消批量操作">
        <i className="fas fa-xmark" />
      </button>
    </div>
  )
}
