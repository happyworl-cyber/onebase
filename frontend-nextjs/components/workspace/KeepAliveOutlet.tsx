'use client'

import { isWorkflowVersionsPath, tabIdentity } from '@/components/workspace/workspaceNav'
import { ReactNode, useRef } from 'react'

/**
 * 多 Tab 的保活渲染器。
 *
 * 机制：维护 `Map<relPath, ReactNode>`。
 *   - 某路径**首次进入**时缓存它对应的 `children` 元素；
 *   - 之后再切回该路径时**复用同一元素引用**（不拿 Next 新生成的 children 覆盖）。
 *     同一引用 → React 不卸载该子树 → 组件状态 / 滚动 / 在途请求全部保留。
 *   - 非激活面板用 `hidden`（display:none）隐藏但仍挂载；只有 Tab 被关闭
 *     （从 openPaths 移除）时才从缓存删除 → 真正卸载销毁。
 *
 * 可见性以 `currentPath`（来自 URL）为唯一信源，保证显示内容永远与地址栏一致；
 * store 里的 activePath 只用于 Tab 栏高亮，二者在一次导航后即对齐。
 */

interface Props {
  /** 当前 URL 对应的相对路径（'' = 项目首页），始终与 children 匹配 */
  currentPath: string
  /** 已打开的 Tab 路径列表（来自 tabs store） */
  openPaths: string[]
  /** Next 传入的当前路由页面元素 */
  children: ReactNode
}

export default function KeepAliveOutlet({ currentPath, openPaths, children }: Props) {
  const cacheRef = useRef<Map<string, ReactNode>>(new Map())
  const cache = cacheRef.current

  const cacheKey = tabIdentity(currentPath)

  if (isWorkflowVersionsPath(currentPath) || !cache.has(cacheKey)) {
    cache.set(cacheKey, children)
  }

  const renderPaths = Array.from(
    new Set<string>([...openPaths.map(tabIdentity), cacheKey]),
  )

  for (const key of Array.from(cache.keys())) {
    if (!renderPaths.includes(key)) cache.delete(key)
  }

  return (
    <>
      {renderPaths.map((path) => {
        const active = path === cacheKey
        const node = cache.get(path) ?? (active ? children : null)
        return (
          <div key={path} hidden={!active} className="h-full overflow-auto p-6">
            {node}
          </div>
        )
      })}
    </>
  )
}
