'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useParams } from 'next/navigation'
import { useCurrentProjectCapabilities } from '@/lib/permissions'
import SchemaSelector from '@/components/SchemaSelector'
import { NAV_GROUPS } from '@/components/workspace/workspaceNav'

/**
 * 工作空间左侧栏（W1 spec §3.2.6，W4 落地后实际可访问页面集）。
 *
 * IA：按对象类型分组（Supabase 风格），不再按功能种类堆。
 *
 * 导航交互（2026-06）：单栏 + 一级分组内联下拉（手风琴，同时只展开一个）。
 * 例如「自动化」展开后显示：函数 / 触发器 / 工作流 / 定时任务 / 会话规则。
 *
 * 能力门槛 W4 改成"按 item 自带 visibleIf"，因为「设置」分组里：
 *   - 项目信息（PATCH /api/projects/:id）只 owner+
 *   - 成员管理（CRUD on members）admin+ 就够
 *   - 数据库连接走 connections handlers，沿用旧的 owner+ 兜底
 * 整组的 visibleIf 用来"该组下没有任何 item 可见就把分组标题一起隐藏"。
 *
 * 历史注意：
 *   - W3 把 API Key 从 /api 拆到 /security/api-keys 单独的写操作页（admin+）
 *   - W3 加了"诊断"分组，把 query / transaction / query-analyzer /
 *     slow-queries 收编到 database 之下
 *   - W5（本次重构）：分组按"语义同类"再调整一遍：
 *       · 抽独立「自动化」组：把"函数 / 触发器"从「数据库」搬出来，与原本
 *         窝在「事件」组里的"定时任务"合并——这三个本质上都是"在 DB 里跑
 *         的执行逻辑"，归同一组心智更顺。
 *       · 原「事件」组改名「集成」，只保留对外通道：Webhook（推）+ ES 代理
 *         （转发）；定时任务搬走后该组语义干净。
 *       · 原「监控」组（只有 1 个监控大盘）合并进「诊断」并整体改名
 *         「诊断与监控」——避免单子项独占顶级位置。
 *   - W6（2026-07，本次）：按"操作 vs 观测"再校准，并补齐漏挂的入口：
 *       · SQL 编辑器 / 事务编辑器从「诊断与监控」搬回「数据库」——它们是对库
 *         的写操作工具，不该混在只读观测组里；诊断组自此纯观测。
 *       · 补齐一批"页面已实现但侧栏无入口"（此前只能靠旧 /dashboard 链接进入）
 *         的项：数据库组新增 Schema 浏览器 / 索引 / 扩展 / 数据导入 / 备份与恢复；
 *         集成组新增「实时推送」（sse-routes）。
 */

// NAV_GROUPS 及其类型已抽到 `@/components/workspace/workspaceNav`，
// 供侧栏与多 Tab 栏共用同一份「路径 → 标题 / 图标」信源。分组调整历史见上方注释。

export default function WorkspaceSidebar() {
  const pathname = usePathname()
  const params = useParams<{ projectId: string }>()
  const caps = useCurrentProjectCapabilities()
  const base = `/workspace/${params.projectId}`

  // 两层过滤：先过 item，再决定该 group 还要不要显示。
  //  - group 自带 visibleIf → 直接尊重它
  //  - 否则按"过滤后还有 item 剩下"判定（自动隐藏空组）
  const renderable = NAV_GROUPS.map((g) => {
    const items = g.items.filter((it) => !it.visibleIf || it.visibleIf(caps))
    return { ...g, items }
  }).filter((g) => {
    if (g.visibleIf) return g.visibleIf(caps)
    return g.items.length > 0
  })

  const fullHref = (href: string) => `${base}${href}`
  // 所有可见 item 的 href，供下方"最长匹配优先"判定使用
  const allItemHrefs = renderable.flatMap((g) => g.items.map((it) => it.href))
  // item 命中判定：首页（href=''）必须精确匹配 base，否则深层路由（/database/...）
  // 都会把首页也点亮；其它页面允许前缀匹配，覆盖详情页 /xxx/:id 等子路由。
  // 前缀匹配取"最长匹配优先"：/settings 与 /settings/env-vars 同时命中时只亮后者，
  // 避免父路径项（项目信息）在设置组子页面里常亮。
  const isItemActive = (href: string) => {
    const full = fullHref(href)
    if (href === '') return pathname === full
    const matched = pathname === full || pathname.startsWith(full + '/')
    if (!matched) return false
    // 存在另一个更长且同样命中的 item ⇒ 让位给更精确的那个
    return !allItemHrefs.some((other) => {
      if (other === href || other.length <= href.length) return false
      const otherFull = fullHref(other)
      return pathname === otherFull || pathname.startsWith(otherFull + '/')
    })
  }
  // 单 item 的组（如「概览」）当成主栏里的直达入口，不展开下拉。
  const isLeafGroup = (g: (typeof renderable)[number]) => g.items.length === 1

  // 内联下拉（手风琴）：同时只展开一个一级分组；路由变化时自动展开当前页所在组。
  const groupOfPathname =
    renderable.find((g) => !isLeafGroup(g) && g.items.some((it) => isItemActive(it.href)))?.label ?? null
  const [expandedGroup, setExpandedGroup] = useState<string | null>(groupOfPathname)

  useEffect(() => {
    if (groupOfPathname) setExpandedGroup(groupOfPathname)
  }, [groupOfPathname])

  const toggleGroup = (label: string) => {
    setExpandedGroup((prev) => (prev === label ? null : label))
  }

  return (
    <aside className="w-[200px] flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
      {/* Schema 选择器 —— 几乎所有"数据库 / 自动化"页面都隐含一个 currentSchema
          上下文（表 / 函数 / 触发器 / 索引 / 关系图等）。放在主栏顶部常驻：
          1) 切到本工作区就能立刻看到当前 schema；
          2) 所有页面的 useAppStore().currentSchema 共享同一信源；
          3) 选择器内部已 dispatch `schema-changed`，子页面会自动 reload。 */}
      <div className="px-2 pt-3 pb-2 border-b border-gray-100">
        <SchemaSelector />
      </div>
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {renderable.map((group) => {
          const leaf = isLeafGroup(group)
          const item = group.items[0]
          const expanded = expandedGroup === group.label
          const groupActive = leaf
            ? isItemActive(item.href)
            : group.items.some((it) => isItemActive(it.href))

          if (leaf) {
            return (
              <Link
                key={group.label}
                href={fullHref(item.href)}
                className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors ${
                  groupActive
                    ? 'bg-blue-50 text-blue-600 font-medium'
                    : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <i
                  className={`${group.icon} w-4 text-center text-xs flex-shrink-0 ${
                    groupActive ? 'text-blue-600' : 'text-gray-400'
                  }`}
                />
                <span className="truncate">{group.label}</span>
              </Link>
            )
          }

          return (
            <div key={group.label}>
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors duration-150 ${
                  groupActive
                    ? 'bg-blue-50/60 text-blue-700 font-medium'
                    : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <i
                  className={`${group.icon} w-4 text-center text-xs flex-shrink-0 ${
                    groupActive ? 'text-blue-600' : 'text-gray-400'
                  }`}
                />
                <span className="flex-1 text-left truncate">{group.label}</span>
                <i
                  className={`fas fa-chevron-right text-[9px] flex-shrink-0 transition-transform duration-200 ease-out ${
                    expanded ? 'rotate-90 text-blue-400' : 'text-gray-300'
                  }`}
                />
              </button>
              <div
                className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                  expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                }`}
              >
                <div className="overflow-hidden min-h-0">
                  <div
                    className={`mt-0.5 ml-2 pl-2 border-l border-gray-100 space-y-0.5 transition-opacity duration-200 ease-out ${
                      expanded ? 'opacity-100 delay-75' : 'opacity-0'
                    }`}
                  >
                    {group.items.map((sub, idx) => {
                      const active = isItemActive(sub.href)
                      return (
                        <Link
                          key={sub.href}
                          href={fullHref(sub.href)}
                          style={{ transitionDelay: expanded ? `${idx * 25 + 40}ms` : '0ms' }}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] transition-all duration-200 ease-out ${
                            expanded ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
                          } ${
                            active
                              ? 'bg-blue-50 text-blue-600 font-medium'
                              : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                          }`}
                        >
                          <i
                            className={`${sub.icon} w-3.5 text-center text-[10px] flex-shrink-0 ${
                              active ? 'text-blue-600' : 'text-gray-400'
                            }`}
                          />
                          <span className="truncate">{sub.label}</span>
                        </Link>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
