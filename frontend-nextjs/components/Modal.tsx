'use client'

import { useEffect, useState, ReactNode } from 'react'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  closeOnOverlayClick?: boolean
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-6xl',
}

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  closeOnOverlayClick = true,
}: ModalProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true)
      // 使用 requestAnimationFrame 确保动画效果
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsAnimating(true)
        })
      })
    } else {
      setIsAnimating(false)
      const timer = setTimeout(() => {
        setIsVisible(false)
      }, 200) // 等待动画完成
      return () => clearTimeout(timer)
    }
  }, [isOpen])

  // 按 Escape 键关闭
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  // 防止滚动穿透
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  if (!isVisible) return null

  return (
    // right 预留 AI 助手面板宽度（--ai-panel-offset，关闭时为 0），让弹窗在面板左侧的
    // 可见区域内居中，避免被面板遮挡。
    <div
      className="fixed z-50 flex items-center justify-center"
      style={{ top: 0, left: 0, right: 'var(--ai-panel-offset, 0px)', bottom: 0 }}
    >
      {/* 遮罩层 */}
      <div
        className={`absolute inset-0 bg-black transition-opacity duration-200 ${
          isAnimating ? 'bg-opacity-50' : 'bg-opacity-0'
        }`}
        onClick={closeOnOverlayClick ? onClose : undefined}
      />

      {/* 弹窗内容 */}
      <div
        className={`
          relative w-full ${sizeClasses[size]} mx-4 bg-white rounded-xl shadow-2xl
          transform transition-all duration-200 ease-out
          ${isAnimating 
            ? 'opacity-100 scale-100 translate-y-0' 
            : 'opacity-0 scale-95 -translate-y-4'
          }
          max-h-[90vh] flex flex-col
        `}
      >
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <i className="fas fa-times"></i>
          </button>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>

        {/* 底部 */}
        {footer && (
          <div className="px-6 py-4 border-t border-gray-100 flex-shrink-0 bg-gray-50 rounded-b-xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

// 确认对话框组件
interface ConfirmDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  type?: 'danger' | 'warning' | 'info'
  loading?: boolean
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  type = 'danger',
  loading = false,
}: ConfirmDialogProps) {
  const typeStyles = {
    danger: {
      icon: 'fa-exclamation-triangle',
      iconBg: 'bg-red-100',
      iconColor: 'text-red-600',
      buttonClass: 'bg-red-500 hover:bg-red-600 text-white',
    },
    warning: {
      icon: 'fa-exclamation-circle',
      iconBg: 'bg-yellow-100',
      iconColor: 'text-yellow-600',
      buttonClass: 'bg-yellow-500 hover:bg-yellow-600 text-white',
    },
    info: {
      icon: 'fa-info-circle',
      iconBg: 'bg-blue-100',
      iconColor: 'text-blue-600',
      buttonClass: 'bg-blue-500 hover:bg-blue-600 text-white',
    },
  }

  const style = typeStyles[type]

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <div className="flex flex-col items-center text-center">
        <div className={`w-16 h-16 ${style.iconBg} rounded-full flex items-center justify-center mb-4`}>
          <i className={`fas ${style.icon} text-2xl ${style.iconColor}`}></i>
        </div>
        <p className="text-gray-600 mb-6">{message}</p>
        <div className="flex space-x-3 w-full">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`flex-1 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${style.buttonClass}`}
          >
            {loading ? (
              <>
                <i className="fas fa-spinner fa-spin mr-2"></i>
                处理中...
              </>
            ) : (
              confirmText
            )}
          </button>
        </div>
      </div>
    </Modal>
  )
}

