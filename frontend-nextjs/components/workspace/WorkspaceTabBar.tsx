'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useWorkspaceTabs } from '@/lib/workspaceTabs'

/**
 * 工作区多 Tab 栏。放在 ProjectTopbar 与内容区之间，横跨内容区上方。
 *
 * 交互：
 *   - 点 Tab   → setActive + router.push（真实导航，URL 同步、前进后退可用）
 *   - × / 中键 → closeTab（关激活项时由 store 激活相邻项，这里再 push 过去）
 *   - 右键     → 弹上下文菜单（关闭 / 关闭其他 / 关闭全部），不再一键关掉其它
 *
 * 保活的 DOM 由 KeepAliveOutlet 负责；本组件只管「列表 + 导航意图」。
 */

interface Props {
  /** 项目 base：`/workspace/:projectId` */
  base: string
}

interface MenuState {
  path: string
  x: number
  y: number
}

export default function WorkspaceTabBar({ base }: Props) {
  const router = useRouter()
  const tabs = useWorkspaceTabs((s) => s.tabs)
  const activePath = useWorkspaceTabs((s) => s.activePath)
  const setActive = useWorkspaceTabs((s) => s.setActive)
  const closeTab = useWorkspaceTabs((s) => s.closeTab)
  const closeOthers = useWorkspaceTabs((s) => s.closeOthers)
  const closeAll = useWorkspaceTabs((s) => s.closeAll)

  const [menu, setMenu] = useState<MenuState | null>(null)

  // 打开菜单后：点击别处 / 滚动 / Esc 都关闭菜单。
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (tabs.length === 0) return null

  const go = (path: string) => {
    setActive(path)
    router.push(`${base}${path}`)
  }

  const handleClose = (path: string) => {
    // closeTab 会算出关闭后应激活的相邻 Tab；读取最新 activePath 再导航过去。
    closeTab(path)
    const next = useWorkspaceTabs.getState().activePath
    router.push(`${base}${next}`)
  }

  const menuTab = menu ? tabs.find((t) => t.path === menu.path) : null

  return (
    <div className="h-9 flex items-stretch bg-gray-50 border-b border-gray-200 overflow-x-auto overflow-y-hidden">
      {tabs.map((tab) => {
        const active = tab.path === activePath
        return (
          <div
            key={tab.path}
            onClick={() => go(tab.path)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.stopPropagation()
                handleClose(tab.path)
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ path: tab.path, x: e.clientX, y: e.clientY })
            }}
            title={tab.title}
            className={`group flex items-center gap-1.5 pl-3 pr-2 max-w-[180px] border-r border-gray-200 cursor-pointer select-none text-[13px] whitespace-nowrap ${
              active
                ? 'bg-white text-blue-600 font-medium border-b-2 border-b-blue-500 -mb-px'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            <i className={`${tab.icon} text-[11px] shrink-0 ${active ? 'text-blue-500' : 'text-gray-400'}`} />
            <span className="truncate">{tab.title}</span>
            <button
              type="button"
              aria-label="关闭标签"
              onClick={(e) => {
                e.stopPropagation()
                handleClose(tab.path)
              }}
              className={`w-4 h-4 flex items-center justify-center rounded shrink-0 text-gray-400 hover:bg-gray-200 hover:text-gray-600 ${
                active ? '' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <i className="fas fa-times text-[10px]" />
            </button>
          </div>
        )
      })}

      {menu && menuTab && (
        <div
          className="fixed z-50 min-w-[140px] py-1 bg-white border border-gray-200 rounded-md shadow-lg text-[13px] text-gray-700"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100"
            onClick={() => {
              handleClose(menu.path)
              setMenu(null)
            }}
          >
            关闭
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={tabs.length <= 1}
            onClick={() => {
              closeOthers(menu.path)
              go(menu.path)
              setMenu(null)
            }}
          >
            关闭其他
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100"
            onClick={() => {
              closeAll()
              router.push(base)
              setMenu(null)
            }}
          >
            关闭全部
          </button>
        </div>
      )}
    </div>
  )
}
