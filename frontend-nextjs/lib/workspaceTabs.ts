import { create } from 'zustand'

/**
 * 工作区多 Tab 状态。
 *
 * 每个 Tab 对应一个「相对项目 base 的路径」（relPath，'' = 项目首页）。同一路径
 * 只会有一个 Tab（按 relPath 去重）。Tab 列表按项目隔离，切项目时整体重置。
 *
 * 持久化：按项目 id 存到 sessionStorage —— 刷新(F5)后 Tab 栏可恢复（页面本身的
 * 保活 DOM 在整页刷新后必然丢失，非当前 Tab 点击时再重新加载，这是可接受的）。
 * 沿用 lib/store.ts 的手动 sessionStorage 同步风格，不引入 persist 中间件。
 */

export interface WorkspaceTab {
  /** 相对项目 base 的路径，'' 表示项目首页 */
  path: string
  title: string
  icon: string
}

interface PersistShape {
  tabs: WorkspaceTab[]
  activePath: string
}

const KEY_PREFIX = 'onebase_ws_tabs_'

function storageKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`
}

function readPersisted(projectId: string): PersistShape | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(storageKey(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistShape
    if (!Array.isArray(parsed.tabs)) return null
    return parsed
  } catch {
    return null
  }
}

function persist(projectId: string, state: PersistShape): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(storageKey(projectId), JSON.stringify(state))
  } catch {
    /* 容量/隐私模式失败就放弃持久化，不影响运行 */
  }
}

interface WorkspaceTabsState {
  /** 当前 Tab 归属的项目 id（用于隔离与持久化 key）；未初始化为 null */
  projectId: string | null
  tabs: WorkspaceTab[]
  activePath: string

  /**
   * 绑定/切换项目。projectId 变化时从 sessionStorage 恢复该项目的 Tab；
   * 同一项目重复调用是幂等的（不清空已有 Tab）。
   */
  initProject: (projectId: string) => void
  /** 打开（或激活已存在的）Tab。 */
  openTab: (tab: WorkspaceTab) => void
  /** 仅切换激活 Tab（不改变列表）。 */
  setActive: (path: string) => void
  /** 关闭某个 Tab；若关的是激活项，则激活相邻项（优先右侧）。 */
  closeTab: (path: string) => void
  /** 关闭除某 Tab 外的其它 Tab。 */
  closeOthers: (path: string) => void
  /** 关闭全部 Tab（回到项目首页）。 */
  closeAll: () => void
}

function commit(
  get: () => WorkspaceTabsState,
  patch: Pick<WorkspaceTabsState, 'tabs' | 'activePath'>,
): Pick<WorkspaceTabsState, 'tabs' | 'activePath'> {
  const { projectId } = get()
  if (projectId) persist(projectId, { tabs: patch.tabs, activePath: patch.activePath })
  return patch
}

export const useWorkspaceTabs = create<WorkspaceTabsState>((set, get) => ({
  projectId: null,
  tabs: [],
  activePath: '',

  initProject: (projectId) => {
    if (get().projectId === projectId) return
    const restored = readPersisted(projectId)
    set({
      projectId,
      tabs: restored?.tabs ?? [],
      activePath: restored?.activePath ?? '',
    })
  },

  openTab: (tab) => {
    set((s) => {
      const exists = s.tabs.some((t) => t.path === tab.path)
      const tabs = exists
        ? s.tabs.map((t) => (t.path === tab.path ? { ...t, title: tab.title, icon: tab.icon } : t))
        : [...s.tabs, tab]
      return commit(get, { tabs, activePath: tab.path })
    })
  },

  setActive: (path) => {
    set((s) => {
      if (!s.tabs.some((t) => t.path === path)) return s
      return commit(get, { tabs: s.tabs, activePath: path })
    })
  },

  closeTab: (path) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.path === path)
      if (idx === -1) return s
      const tabs = s.tabs.filter((t) => t.path !== path)

      let activePath = s.activePath
      if (s.activePath === path) {
        // 关的是当前 Tab：优先激活右侧相邻，无则左侧，全空则回首页('')。
        const neighbor = tabs[idx] ?? tabs[idx - 1]
        activePath = neighbor ? neighbor.path : ''
      }
      return commit(get, { tabs, activePath })
    })
  },

  closeOthers: (path) => {
    set((s) => {
      const kept = s.tabs.filter((t) => t.path === path)
      return commit(get, { tabs: kept, activePath: kept.length ? path : '' })
    })
  },

  closeAll: () => {
    set(() => commit(get, { tabs: [], activePath: '' }))
  },
}))
