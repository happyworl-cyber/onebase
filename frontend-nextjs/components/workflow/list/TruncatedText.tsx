'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import HighlightText from './HighlightText'

interface TruncatedTextProps {
  text: string
  as?: 'span' | 'p'
  className?: string
  /** 单行 truncate（默认）；false 时配合 clampClass 多行截断 */
  singleLine?: boolean
  clampClass?: string
  /** 命中高亮的搜索关键词（可选） */
  highlight?: string | null
}

/** 文本截断时才有 title 悬浮提示 */
export default function TruncatedText({
  text,
  as: Tag = 'span',
  className,
  singleLine = true,
  clampClass,
  highlight,
}: TruncatedTextProps) {
  const ref = useRef<HTMLSpanElement | HTMLParagraphElement>(null)
  const [overflowed, setOverflowed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const check = () => {
      if (singleLine) {
        setOverflowed(el.scrollWidth > el.clientWidth + 1)
      } else {
        setOverflowed(el.scrollHeight > el.clientHeight + 1)
      }
    }

    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, singleLine])

  return (
    <Tag
      ref={ref}
      title={overflowed ? text : undefined}
      className={cn(singleLine && 'truncate min-w-0', !singleLine && clampClass, className)}
    >
      {highlight ? <HighlightText text={text} query={highlight} /> : text}
    </Tag>
  )
}
