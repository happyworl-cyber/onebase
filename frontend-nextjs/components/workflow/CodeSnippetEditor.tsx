'use client'

import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import dynamic from 'next/dynamic'
import {
  type SnippetLanguage,
  isDarkSnippetLanguage,
  SNIPPET_LANG_LABEL,
  SNIPPET_DEFAULT_ROWS,
} from './codeSnippetLang'

export type { SnippetLanguage }

const ROW_PX = 24

export type CodeSnippetEditorProps = {
  value: string
  onChange?: (value: string) => void
  language: SnippetLanguage
  label: string
  minRows?: number
  readOnly?: boolean
  onBlur?: () => void
  invalid?: boolean
  placeholder?: string
  /** 铺满父容器剩余高度（右侧面板全屏时用） */
  fill?: boolean
}

type MirrorProps = {
  value: string
  onChange?: (value: string) => void
  language: SnippetLanguage
  readOnly?: boolean
  onBlur?: () => void
  placeholder?: string
  height: string
}

const CodeSnippetMirror = dynamic<MirrorProps>(
  () => import('./CodeSnippetMirror').then((m) => m.CodeSnippetMirror),
  { ssr: false },
)

let releaseActiveOverlay: (() => void) | null = null

function acquireOverlay(release: () => void) {
  if (releaseActiveOverlay && releaseActiveOverlay !== release) {
    releaseActiveOverlay()
  }
  releaseActiveOverlay = release
}

function releaseOverlay(release: () => void) {
  if (releaseActiveOverlay === release) releaseActiveOverlay = null
}

class MirrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function fallbackClass(language: SnippetLanguage, invalid?: boolean) {
  const dark = isDarkSnippetLanguage(language)
  return [
    'w-full px-3 py-2 border rounded-lg font-mono text-sm leading-relaxed resize-none',
    dark ? 'bg-gray-900 text-green-400' : 'bg-white text-gray-800',
    invalid ? 'border-red-300 bg-red-50/30' : 'border-gray-200',
  ].join(' ')
}

function SnippetFallback({
  value,
  onChange,
  language,
  readOnly,
  onBlur,
  placeholder,
  rows,
  invalid,
}: {
  value: string
  onChange?: (value: string) => void
  language: SnippetLanguage
  readOnly?: boolean
  onBlur?: () => void
  placeholder?: string
  rows: number
  invalid?: boolean
}) {
  const locked = readOnly || !onChange
  return (
    <textarea
      value={value}
      onChange={(e) => {
        if (locked) return
        onChange?.(e.target.value)
      }}
      onBlur={onBlur}
      spellCheck={false}
      readOnly={locked}
      rows={rows}
      placeholder={placeholder}
      className={fallbackClass(language, invalid)}
    />
  )
}

function FillParentMirror({
  value,
  onChange,
  language,
  readOnly,
  placeholder,
  invalid,
}: {
  value: string
  onChange?: (value: string) => void
  language: SnippetLanguage
  readOnly?: boolean
  placeholder?: string
  invalid?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [heightPx, setHeightPx] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = () => setHeightPx(el.clientHeight)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={ref} className="h-full min-h-0">
      <MirrorBoundary
        fallback={
          <SnippetFallback
            value={value}
            onChange={onChange}
            language={language}
            readOnly={readOnly}
            onBlur={undefined}
            placeholder={placeholder}
            rows={24}
            invalid={invalid}
          />
        }
      >
        {heightPx > 0 ? (
          <CodeSnippetMirror
            value={value}
            onChange={onChange}
            language={language}
            readOnly={readOnly}
            placeholder={placeholder}
            height={`${heightPx}px`}
          />
        ) : null}
      </MirrorBoundary>
    </div>
  )
}

function ExpandControl({
  onClick,
  label,
}: {
  onClick: () => void
  label: string
}) {
  // fieldset[disabled] 会禁用 <button>，只读时仍要能放大，所以不用 form control。
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="px-1.5 py-0.5 rounded text-[11px] text-gray-500 hover:bg-gray-100 hover:text-gray-800 cursor-pointer select-none"
      aria-label={`全屏编辑${label}`}
    >
      全屏
    </div>
  )
}

export default function CodeSnippetEditor({
  value,
  onChange,
  language,
  label,
  minRows,
  readOnly = false,
  onBlur,
  invalid,
  placeholder,
  fill = false,
}: CodeSnippetEditorProps) {
  const reactId = useId()
  const [expanded, setExpanded] = useState(false)
  const [mounted, setMounted] = useState(false)
  const onBlurRef = useRef(onBlur)
  onBlurRef.current = onBlur

  const rows = minRows ?? SNIPPET_DEFAULT_ROWS[language]
  const paneHeight = `${rows * ROW_PX}px`

  useEffect(() => {
    setMounted(true)
  }, [])

  const closeExpanded = useCallback(() => {
    setExpanded(false)
    onBlurRef.current?.()
    releaseOverlay(closeExpanded)
  }, [])

  const openExpanded = useCallback(() => {
    acquireOverlay(closeExpanded)
    setExpanded(true)
  }, [closeExpanded])

  useEffect(() => {
    if (!expanded) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      closeExpanded()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey, true)
    }
  }, [expanded, closeExpanded])

  const fallback = (
    <SnippetFallback
      value={value}
      onChange={onChange}
      language={language}
      readOnly={readOnly}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={rows}
      invalid={invalid}
    />
  )

  const pane = (
    <MirrorBoundary fallback={fallback}>
      <CodeSnippetMirror
        value={value}
        onChange={onChange}
        language={language}
        readOnly={readOnly}
        onBlur={expanded ? undefined : onBlur}
        placeholder={placeholder}
        height={paneHeight}
      />
    </MirrorBoundary>
  )

  const border = invalid ? 'border-red-300' : 'border-gray-200'
  const chrome = isDarkSnippetLanguage(language) ? 'bg-gray-900' : 'bg-white'

  const overlay =
    mounted && expanded
      ? createPortal(
          <div
            className="fixed z-[80] flex items-center justify-center"
            style={{ top: 0, left: 0, right: 'var(--ai-panel-offset, 0px)', bottom: 0 }}
          >
            <div className="absolute inset-0 bg-black/50" onClick={closeExpanded} />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${reactId}-title`}
              className="relative flex flex-col bg-white overflow-hidden w-full h-full"
            >
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
                <h3 id={`${reactId}-title`} className="text-sm font-semibold text-gray-900">
                  {label}
                </h3>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={closeExpanded}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      closeExpanded()
                    }
                  }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 cursor-pointer"
                  aria-label="退出全屏"
                >
                  ×
                </div>
              </div>
              <div className={`flex-1 min-h-0 ${chrome}`}>
                <FillParentMirror
                  value={value}
                  onChange={onChange}
                  language={language}
                  readOnly={readOnly}
                  placeholder={placeholder}
                  invalid={invalid}
                />
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  const inlineEditor = fill ? (
    <FillParentMirror
      value={value}
      onChange={onChange}
      language={language}
      readOnly={readOnly}
      placeholder={placeholder}
      invalid={invalid}
    />
  ) : (
    pane
  )

  return (
    <div className={`border rounded-lg overflow-hidden ${border} ${chrome}${fill ? ' flex flex-col h-full min-h-0' : ''}`}>
      <div className="flex items-center justify-between px-2 py-1 border-b border-gray-200/80 bg-gray-50 shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          {SNIPPET_LANG_LABEL[language]}
        </span>
        <ExpandControl onClick={openExpanded} label={label} />
      </div>
      <div
        style={fill ? undefined : { height: paneHeight }}
        className={`nowheel min-h-0 overflow-hidden${fill ? ' flex-1' : ''}`}
      >
        {inlineEditor}
      </div>
      {overlay}
    </div>
  )
}
