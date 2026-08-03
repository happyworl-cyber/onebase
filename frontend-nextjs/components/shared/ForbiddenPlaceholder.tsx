'use client'

/**
 * 403 占位组件：子页面 catch 到 403 时渲染，替代红色 toast 提供更友好的反馈。
 *
 * 设计动机（W1 §3.3）：
 *   - 拦截器层 403 已经默认静默
 *   - 页面拿到 err.response.status === 403 应该走 in-page 占位，而不是再 toast
 *   - 文案带"角色 + 资源"两段，让用户知道是权限不够（而非系统错误）
 *
 * 用法：
 *   const { data, error } = useSWR(...)
 *   if (error?.response?.status === 403) {
 *     return <ForbiddenPlaceholder
 *       reason={`你的角色 (${userRole}) 没有访问此内容的权限`}
 *     />
 *   }
 */
export interface ForbiddenPlaceholderProps {
  /** 一段简短的原因说明（中文），默认通用文案 */
  reason?: string
  /** 可选的下一步操作链接（如返回项目首页） */
  cta?: {
    label: string
    href: string
  }
}

export default function ForbiddenPlaceholder({
  reason = '当前账号无访问此内容的权限',
  cta,
}: ForbiddenPlaceholderProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-4">
        <i className="fas fa-lock text-2xl text-amber-600"></i>
      </div>
      <h2 className="text-base font-medium text-gray-900 mb-2">权限不足</h2>
      <p className="text-sm text-gray-500 max-w-md">{reason}</p>
      {cta && (
        <a
          href={cta.href}
          className="mt-4 inline-block text-sm text-blue-600 hover:underline"
        >
          {cta.label}
        </a>
      )}
      <p className="mt-6 text-xs text-gray-400">
        如认为权限设置有误，请联系项目管理员或平台超管。
      </p>
    </div>
  )
}
