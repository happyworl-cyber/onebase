'use client'

import { createContext, useContext, useState, useCallback, useEffect, useMemo, ReactNode } from 'react'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: string
  type: ToastType
  message: string
  duration?: number
}

interface ToastContextType {
  toasts: Toast[]
  addToast: (type: ToastType, message: string, duration?: number) => void
  removeToast: (id: string) => void
  success: (message: string, duration?: number) => void
  error: (message: string, duration?: number) => void
  warning: (message: string, duration?: number) => void
  info: (message: string, duration?: number) => void
}

const ToastContext = createContext<ToastContextType | undefined>(undefined)

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}

interface ToastProviderProps {
  children: ReactNode
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const addToast = useCallback((type: ToastType, message: string, duration = 4000) => {
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 9)
    const newToast: Toast = { id, type, message, duration }
    
    setToasts((prev) => [...prev, newToast])
    
    if (duration > 0) {
      setTimeout(() => {
        removeToast(id)
      }, duration)
    }
  }, [removeToast])

  const success = useCallback((message: string, duration?: number) => {
    addToast('success', message, duration)
  }, [addToast])

  const error = useCallback((message: string, duration?: number) => {
    addToast('error', message, duration ?? 6000) // 错误消息持续更长时间
  }, [addToast])

  const warning = useCallback((message: string, duration?: number) => {
    addToast('warning', message, duration)
  }, [addToast])

  const info = useCallback((message: string, duration?: number) => {
    addToast('info', message, duration)
  }, [addToast])

  const contextValue = useMemo(() => ({
    toasts,
    addToast,
    removeToast,
    success,
    error,
    warning,
    info,
  }), [toasts, addToast, removeToast, success, error, warning, info])

  // 把当前 ToastProvider 的能力暴露给非 React 调用方（如 axios 拦截器）。
  useEffect(() => {
    setToastFn(contextValue)
  }, [contextValue])

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  )
}

interface ToastContainerProps {
  toasts: Toast[]
  removeToast: (id: string) => void
}

function ToastContainer({ toasts, removeToast }: ToastContainerProps) {
  return (
    <div
      className="fixed bottom-4 z-[10000] flex flex-col-reverse gap-2 pointer-events-none"
      style={{ right: 'calc(1rem + var(--ai-panel-offset, 0px))' }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  )
}

interface ToastItemProps {
  toast: Toast
  onClose: () => void
}

function ToastItem({ toast, onClose }: ToastItemProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [isLeaving, setIsLeaving] = useState(false)

  useEffect(() => {
    // 入场动画
    requestAnimationFrame(() => {
      setIsVisible(true)
    })
  }, [])

  const handleClose = () => {
    setIsLeaving(true)
    setTimeout(onClose, 200)
  }

  const icons = {
    success: 'fa-check-circle',
    error: 'fa-exclamation-circle',
    warning: 'fa-exclamation-triangle',
    info: 'fa-info-circle',
  }

  const colors = {
    success: {
      bg: 'bg-green-50',
      border: 'border-green-200',
      icon: 'text-green-500',
      text: 'text-green-800',
      progressBar: 'bg-green-400',
    },
    error: {
      bg: 'bg-red-50',
      border: 'border-red-200',
      icon: 'text-red-500',
      text: 'text-red-800',
      progressBar: 'bg-red-400',
    },
    warning: {
      bg: 'bg-yellow-50',
      border: 'border-yellow-200',
      icon: 'text-yellow-500',
      text: 'text-yellow-800',
      progressBar: 'bg-yellow-400',
    },
    info: {
      bg: 'bg-blue-50',
      border: 'border-blue-200',
      icon: 'text-blue-500',
      text: 'text-blue-800',
      progressBar: 'bg-blue-400',
    },
  }

  const style = colors[toast.type]

  return (
    <div
      className={`
        pointer-events-auto min-w-[320px] max-w-[420px] rounded-lg border shadow-lg overflow-hidden
        ${style.bg} ${style.border}
        transform transition-all duration-200 ease-out
        ${isVisible && !isLeaving ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0'}
      `}
    >
      <div className="p-4 flex items-start gap-3">
        <i className={`fas ${icons[toast.type]} ${style.icon} text-lg mt-0.5 flex-shrink-0`}></i>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium ${style.text} break-words`}>{toast.message}</p>
        </div>
        <button
          onClick={handleClose}
          className={`${style.text} hover:opacity-70 transition-opacity p-1 -m-1 flex-shrink-0`}
        >
          <i className="fas fa-times text-sm"></i>
        </button>
      </div>
      
      {/* 进度条 */}
      {toast.duration && toast.duration > 0 && (
        <div className="h-1 w-full bg-black/5">
          <div
            className={`h-full ${style.progressBar} transition-all ease-linear`}
            style={{
              animation: `shrink ${toast.duration}ms linear forwards`,
            }}
          />
        </div>
      )}
      
      <style jsx>{`
        @keyframes shrink {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  )
}

// 给"不在 React 组件中"的代码（axios 拦截器、全局错误处理等）使用。
// ToastProvider 挂载后会通过 useEffect 调用 setToastFn 自动注册。
let toastFn: ToastContextType | null = null

export function setToastFn(fn: ToastContextType) {
  toastFn = fn
}

export function showToast(type: ToastType, message: string, duration?: number) {
  if (toastFn) {
    toastFn.addToast(type, message, duration)
  } else {
    // ToastProvider 还未挂载（极少见，仅在登录前触发的请求出错时）→ 退化到 console。
    // eslint-disable-next-line no-console
    console.warn(`[toast:${type}] ${message}`)
  }
}

