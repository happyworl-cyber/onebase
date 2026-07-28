'use client'

import { useState } from 'react'

export default function ConnectionWarning() {
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null

  return (
    <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6">
      <div className="flex">
        <div className="flex-shrink-0">
          <i className="fas fa-exclamation-triangle text-yellow-400"></i>
        </div>
        <div className="ml-3 flex-1">
          <p className="text-sm text-yellow-700">
            <strong className="font-medium">注意：</strong>
            当前版本的数据库连接管理仅用于配置管理。实际连接的数据库由后端 <code className="bg-yellow-100 px-1 py-0.5 rounded">.env</code> 文件中的 <code className="bg-yellow-100 px-1 py-0.5 rounded">DATABASE_URL</code> 决定。
            要切换到不同的数据库，请修改后端配置文件并重启服务。
          </p>
          <p className="text-xs text-yellow-600 mt-2">
            💡 提示：多数据库动态切换功能正在开发中
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="flex-shrink-0 ml-3 text-yellow-400 hover:text-yellow-600"
        >
          <i className="fas fa-times"></i>
        </button>
      </div>
    </div>
  )
}

