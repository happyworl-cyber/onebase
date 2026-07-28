import { create } from 'zustand'
import { BRAND_SLUG } from '@/lib/brand'

/** 浏览器标签页会话内，通过 /query 成功执行 SQL 的次数（与 sessionStorage 同步） */
const SESSION_QUERY_EXEC_KEY = `${BRAND_SLUG}_session_query_exec_count`

function readStoredSessionQueryCount(): number {
  if (typeof window === 'undefined') return 0
  try {
    const v = sessionStorage.getItem(SESSION_QUERY_EXEC_KEY)
    if (v == null) return 0
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

// 用户可访问的连接信息（来自后端）
interface UserConnection {
  user_id: number
  username: string
  tenant_id: number
  tenant_name: string
  database_id: number
  connection_name: string
  db_host: string
  db_port: number
  db_name: string
  is_primary: boolean
  user_role: string
}

interface Database {
  id: string
  name: string
  host: string
  port: number
  database: string
  description?: string
}

interface UserInfo {
  id: number
  username: string
  email: string
  role: string  // user, admin 等
  is_superadmin?: boolean  // 超级管理员标识
  created_at: string
}

interface Tenant {
  id: number
  name: string
  slug: string
  database_id: number | null  // tenant_databases 表的 ID
  db_host: string
  db_port: number
  db_name: string
  db_user: string
  is_active: boolean
  created_at: string
}

interface AppState {
  // 用户信息
  currentUser: UserInfo | null
  setCurrentUser: (user: UserInfo | null) => void
  
  // 当前租户（工作区模式）
  currentTenant: Tenant | null
  setCurrentTenant: (tenant: Tenant | null) => void
  
  // 新的多租户连接管理
  currentConnection: UserConnection | null
  setCurrentConnection: (conn: UserConnection | any | null) => void
  userConnections: UserConnection[]
  setUserConnections: (conns: UserConnection[]) => void
  
  // 旧的数据库选择（保留兼容性）
  currentDatabase: Database | null
  setCurrentDatabase: (db: Database | null) => void
  currentSchema: string
  setCurrentSchema: (schema: string) => void
  databases: Database[]
  setDatabases: (dbs: Database[]) => void
  addDatabase: (db: Database) => void
  removeDatabase: (id: string) => void

  /** 本会话（同标签页）内成功走 /query 的执行次数 */
  sessionQueryExecutionCount: number
  syncSessionQueryExecutionFromStorage: () => void
  recordSessionQueryExecution: () => void
  resetSessionQueryExecution: () => void
}

export const useAppStore = create<AppState>()((set, get) => ({
  // 用户信息
  currentUser: typeof window !== 'undefined' && localStorage.getItem('current_user')
    ? JSON.parse(localStorage.getItem('current_user')!)
    : null,
  setCurrentUser: (user) => {
    set({ currentUser: user })
    if (typeof window !== 'undefined') {
      if (user) {
        localStorage.setItem('current_user', JSON.stringify(user))
      } else {
        localStorage.removeItem('current_user')
      }
    }
  },
  
  // 当前租户（工作区模式）
  currentTenant: typeof window !== 'undefined' && localStorage.getItem('current_tenant')
    ? JSON.parse(localStorage.getItem('current_tenant')!)
    : null,
  setCurrentTenant: (tenant) => {
    set({ currentTenant: tenant })
    if (typeof window !== 'undefined') {
      if (tenant) {
        localStorage.setItem('current_tenant', JSON.stringify(tenant))
      } else {
        localStorage.removeItem('current_tenant')
      }
    }
  },
  
  // 新的多租户支持
  currentConnection: typeof window !== 'undefined' && localStorage.getItem('current_connection')
    ? JSON.parse(localStorage.getItem('current_connection')!)
    : null,
  setCurrentConnection: (conn) => {
    set({ currentConnection: conn })
    if (typeof window !== 'undefined') {
      if (conn) {
        localStorage.setItem('current_connection', JSON.stringify(conn))
      } else {
        localStorage.removeItem('current_connection')
      }
      // 通知所有正在监听的页面（schema / tables / query / visualizer 等）
      // 当前连接已切换，让它们重新拉自己跟连接绑定的状态。
      window.dispatchEvent(new Event('database-changed'))
    }
  },
  userConnections: typeof window !== 'undefined' && localStorage.getItem('user_connections')
    ? JSON.parse(localStorage.getItem('user_connections')!)
    : [],
  setUserConnections: (conns) => {
    set({ userConnections: conns })
    if (typeof window !== 'undefined') {
      localStorage.setItem('user_connections', JSON.stringify(conns))
    }
  },
  
  // 旧的实现（保留兼容性）
  currentDatabase: typeof window !== 'undefined' && localStorage.getItem('current_database')
    ? JSON.parse(localStorage.getItem('current_database')!)
    : {
        id: 'default',
        name: 'Default Project',
        host: 'localhost',
        port: 5432,
        database: BRAND_SLUG,
        description: '默认数据库连接',
      },
  setCurrentDatabase: (db) => {
    set({ currentDatabase: db })
    if (typeof window !== 'undefined' && db) {
      localStorage.setItem('current_database', JSON.stringify(db))
    }
  },

  currentSchema: typeof window !== 'undefined' && localStorage.getItem('current_schema')
    ? localStorage.getItem('current_schema')!
    : 'public',
  setCurrentSchema: (schema) => {
    set({ currentSchema: schema })
    if (typeof window !== 'undefined') {
      localStorage.setItem('current_schema', schema)
    }
  },

  databases: typeof window !== 'undefined' && localStorage.getItem('databases')
    ? JSON.parse(localStorage.getItem('databases')!)
    : [
        {
          id: 'default',
          name: 'Default Project',
          host: 'localhost',
          port: 5432,
          database: BRAND_SLUG,
          description: '默认数据库连接',
        },
      ],
  setDatabases: (dbs) => {
    set({ databases: dbs })
    if (typeof window !== 'undefined') {
      localStorage.setItem('databases', JSON.stringify(dbs))
    }
  },
  addDatabase: (db) =>
    set((state) => {
      const newDatabases = [...state.databases, db]
      if (typeof window !== 'undefined') {
        localStorage.setItem('databases', JSON.stringify(newDatabases))
      }
      return { databases: newDatabases }
    }),
  removeDatabase: (id) =>
    set((state) => {
      const newDatabases = state.databases.filter((db) => db.id !== id)
      if (typeof window !== 'undefined') {
        localStorage.setItem('databases', JSON.stringify(newDatabases))
      }
      return { databases: newDatabases }
    }),

  sessionQueryExecutionCount: 0,
  syncSessionQueryExecutionFromStorage: () => {
    const n = readStoredSessionQueryCount()
    if (n !== get().sessionQueryExecutionCount) {
      set({ sessionQueryExecutionCount: n })
    }
  },
  recordSessionQueryExecution: () =>
    set((state) => {
      const persisted = readStoredSessionQueryCount()
      const base = Math.max(state.sessionQueryExecutionCount, persisted)
      const next = base + 1
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.setItem(SESSION_QUERY_EXEC_KEY, String(next))
        } catch {
          /* ignore */
        }
      }
      return { sessionQueryExecutionCount: next }
    }),
  resetSessionQueryExecution: () => {
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.removeItem(SESSION_QUERY_EXEC_KEY)
      } catch {
        /* ignore */
      }
    }
    set({ sessionQueryExecutionCount: 0 })
  },
}))
