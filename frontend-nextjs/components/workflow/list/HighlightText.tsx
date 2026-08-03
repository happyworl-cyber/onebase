'use client'

import { Fragment } from 'react'
import { cn } from '@/lib/utils'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把搜索关键词按空格拆成去重后的 term 列表（与后端多关键词 AND 分词一致）。 */
export function searchTerms(query?: string | null): string[] {
  const q = (query ?? '').trim()
  if (!q) return []
  return Array.from(new Set(q.split(/\s+/).filter(Boolean)))
}

interface HighlightTextProps {
  text: string
  query?: string | null
  /** 额外作用到 <mark> 上的样式 */
  markClassName?: string
}

/**
 * 在 text 中高亮命中搜索关键词的子串（大小写不敏感、多关键词）。
 * 无关键词或无命中时按原文渲染，不引入额外节点开销。
 */
export default function HighlightText({ text, query, markClassName }: HighlightTextProps) {
  const terms = searchTerms(query)
  if (!text || terms.length === 0) return <>{text}</>

  const re = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  const nodes: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(
      <mark
        key={`${m.index}-${m[0]}`}
        className={cn('rounded-[2px] bg-amber-200 px-0.5 text-slate-900', markClassName)}
      >
        {m[0]}
      </mark>,
    )
    last = m.index + m[0].length
    if (m.index === re.lastIndex) re.lastIndex++
  }
  if (last < text.length) nodes.push(text.slice(last))

  return (
    <>
      {nodes.map((n, i) => (
        <Fragment key={i}>{n}</Fragment>
      ))}
    </>
  )
}
