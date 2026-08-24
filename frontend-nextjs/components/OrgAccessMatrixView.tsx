'use client'

import { useEffect, useMemo, useState } from 'react'
import { organizationAPI } from '@/lib/api'

type MatrixProject = {
  id: number
  name: string
  slug: string
}

type MatrixMember = {
  user_id: number
  username: string
  email: string
  org_role: string
}

type MatrixData = {
  organization_id: number
  members: MatrixMember[]
  projects: MatrixProject[]
  cells: Array<{ user_id: number; project_id: number; role: string }>
}

type OrgAccessMatrixViewProps = {
  organizationId: number
  reloadToken?: number
  onAddToProject: (project: MatrixProject, userId: number) => void
}

export default function OrgAccessMatrixView({
  organizationId,
  reloadToken,
  onAddToProject,
}: OrgAccessMatrixViewProps) {
  const [matrix, setMatrix] = useState<MatrixData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showUnassignedOnly, setShowUnassignedOnly] = useState(false)

  useEffect(() => {
    let cancelled = false
    setMatrix(null)
    setError(null)

    organizationAPI
      .memberProjectMatrix(organizationId)
      .then((res) => {
        if (!cancelled) setMatrix(res.data)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.response?.data?.error || err?.message || '加载失败')
        setMatrix(null)
      })

    return () => {
      cancelled = true
    }
  }, [organizationId, reloadToken])

  const cells = useMemo(
    () =>
      new Map(
        (matrix?.cells || []).map((cell) => [
          `${cell.user_id}:${cell.project_id}`,
          cell.role,
        ]),
      ),
    [matrix?.cells],
  )

  const membersWithAnyProject = useMemo(() => {
    const set = new Set<number>()
    for (const cell of matrix?.cells || []) {
      set.add(cell.user_id)
    }
    return set
  }, [matrix?.cells])

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>
  }
  if (!matrix) {
    return (
      <p className="text-sm text-gray-400">
        <i className="fas fa-spinner fa-spin mr-2"></i>加载访问矩阵…
      </p>
    )
  }

  const members = showUnassignedOnly
    ? matrix.members.filter((member) => !membersWithAnyProject.has(member.user_id))
    : matrix.members

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">访问</h1>
          <p className="text-sm text-gray-500 mt-1">
            {matrix.members.length} 位成员 · {matrix.projects.length} 个项目
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
          <input
            type="checkbox"
            className="rounded border-gray-300"
            checked={showUnassignedOnly}
            onChange={(event) => setShowUnassignedOnly(event.target.checked)}
          />
          仅显示未加入任何项目的成员
        </label>
      </header>

      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
            <tr>
              <th className="sticky left-0 z-10 bg-gray-50 px-4 py-3 text-left font-medium min-w-64">
                成员
              </th>
              {matrix.projects.map((project) => (
                <th
                  key={project.id}
                  className="px-4 py-3 text-left font-medium whitespace-nowrap min-w-36"
                  title={project.slug}
                >
                  {project.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {members.map((member) => (
              <tr key={member.user_id} className="hover:bg-gray-50 transition-colors">
                <td className="sticky left-0 bg-white px-4 py-3 min-w-64">
                  <div className="font-medium text-gray-900">{member.username}</div>
                  <div className="text-xs text-gray-400 truncate">{member.email}</div>
                  <div className="text-xs font-mono text-gray-500 mt-0.5">{member.org_role}</div>
                </td>
                {matrix.projects.map((project) => {
                  const role = cells.get(`${member.user_id}:${project.id}`)
                  return (
                    <td key={project.id} className="px-4 py-3 whitespace-nowrap">
                      {role ? (
                        <span className="text-xs font-mono text-gray-700">{role}</span>
                      ) : (
                        <button
                          type="button"
                          className="text-xs text-blue-600 hover:underline"
                          onClick={() => onAddToProject(project, member.user_id)}
                          title={`将 ${member.username} 加入 ${project.name}`}
                        >
                          — 加入
                        </button>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-gray-400"
                  colSpan={Math.max(matrix.projects.length + 1, 1)}
                >
                  {showUnassignedOnly ? '没有未加入项目的成员' : '暂无成员'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
