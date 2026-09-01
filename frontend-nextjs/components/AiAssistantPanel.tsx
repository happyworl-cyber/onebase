'use client'

import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useParams, usePathname } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import {
  buildAskText,
  genRequestId,
  streamAiChat,
  useAiAssistantStore,
  type AiChatMessage,
  type AiSseEvent,
} from '@/lib/aiAssistant'

const STORAGE_OPEN_KEY = 'ai-assistant-open'
const STORAGE_WIDTH_KEY = 'ai-assistant-width'
const STORAGE_FAB_POS_KEY = 'ai-assistant-fab-pos'
const MIN_WIDTH = 360
const MAX_WIDTH = 900
const DEFAULT_WIDTH = 440
const FAB_SIZE = 56
const FAB_EDGE = 8
const FAB_DEFAULT_INSET = 24
const FAB_DRAG_THRESHOLD = 6

type FabPos = { x: number; y: number }
type UiMessage = AiChatMessage & { id: string }

function defaultFabPos(vw: number, vh: number): FabPos {
  return { x: vw - FAB_SIZE - FAB_DEFAULT_INSET, y: vh - FAB_SIZE - FAB_DEFAULT_INSET }
}

function clampFabPos(pos: FabPos, vw: number, vh: number): FabPos {
  return {
    x: Math.min(Math.max(FAB_EDGE, pos.x), Math.max(FAB_EDGE, vw - FAB_SIZE - FAB_EDGE)),
    y: Math.min(Math.max(FAB_EDGE, pos.y), Math.max(FAB_EDGE, vh - FAB_SIZE - FAB_EDGE)),
  }
}

function readSavedFabPos(): FabPos | null {
  try {
    const raw = localStorage.getItem(STORAGE_FAB_POS_KEY)
    if (!raw) return null
    const pos = JSON.parse(raw) as FabPos
    return Number.isFinite(pos?.x) && Number.isFinite(pos?.y) ? pos : null
  } catch {
    return null
  }
}

function safeHref(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed
  try {
    const url = new URL(trimmed)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function renderInline(text: string): ReactNode[] {
  const pattern = /(`[^`\n]+`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*)/g
  const nodes: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const token = match[0]
    const key = `${match.index}-${token}`
    if (token.startsWith('`')) {
      nodes.push(<code key={key} className="rounded bg-gray-100 px-1 py-0.5 text-[0.9em]">{token.slice(1, -1)}</code>)
    } else if (match[2] && match[3]) {
      const href = safeHref(match[3])
      nodes.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-600 underline">
            {match[2]}
          </a>
        ) : (
          <span key={key}>{match[2]}</span>
        ),
      )
    } else if (match[4]) {
      nodes.push(<strong key={key}>{match[4]}</strong>)
    } else {
      nodes.push(<em key={key}>{match[5]}</em>)
    }
    cursor = pattern.lastIndex
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

/** React 默认转义所有文本；这里只识别少量 Markdown，绝不解析或注入 raw HTML。 */
function SafeMarkdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const code: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i])
        i += 1
      }
      blocks.push(
        <div key={`code-${i}`} className="my-2 overflow-hidden rounded-lg border border-gray-200 bg-gray-950">
          {language && <div className="border-b border-gray-700 px-3 py-1 text-[10px] text-gray-400">{language}</div>}
          <pre className="overflow-x-auto p-3 text-xs leading-5 text-gray-100"><code>{code.join('\n')}</code></pre>
        </div>,
      )
      continue
    }
    if (!line.trim()) {
      blocks.push(<div key={`space-${i}`} className="h-2" />)
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      blocks.push(
        <div key={`heading-${i}`} className={`font-semibold text-gray-900 ${heading[1].length === 1 ? 'text-base' : 'text-sm'}`}>
          {renderInline(heading[2])}
        </div>,
      )
      continue
    }
    const list = line.match(/^\s*[-*+]\s+(.+)$/)
    if (list) {
      blocks.push(<div key={`list-${i}`} className="flex gap-2 pl-1"><span>•</span><span>{renderInline(list[1])}</span></div>)
      continue
    }
    const ordered = line.match(/^\s*(\d+)\.\s+(.+)$/)
    if (ordered) {
      blocks.push(<div key={`ordered-${i}`} className="flex gap-2 pl-1"><span>{ordered[1]}.</span><span>{renderInline(ordered[2])}</span></div>)
      continue
    }
    if (line.startsWith('> ')) {
      blocks.push(<blockquote key={`quote-${i}`} className="border-l-2 border-indigo-300 pl-3 text-gray-600">{renderInline(line.slice(2))}</blockquote>)
      continue
    }
    blocks.push(<p key={`p-${i}`}>{renderInline(line)}</p>)
  }
  return <div className="break-words text-sm leading-6">{blocks}</div>
}

export default function AiAssistantPanel() {
  const params = useParams<{ projectId?: string | string[] }>()
  const pathname = usePathname()
  const currentProject = useAppStore((state) => state.currentProject)
  const routeMatch = pathname.match(/^\/workspace\/(\d+)(?:\/|$)/)
  const routeParam = Array.isArray(params?.projectId) ? params.projectId[0] : params?.projectId
  const pathProjectId = routeMatch ? Number(routeMatch[1]) : null
  const paramProjectId = routeParam && /^\d+$/.test(routeParam) ? Number(routeParam) : null
  const isWorkspaceRoute = pathname.startsWith('/workspace/')
  // URL 是权威信源；pathname 与 useParams 必须一致，且 store 已加载同一项目后才可发送。
  const routeProjectId =
    pathProjectId && paramProjectId === pathProjectId ? pathProjectId : null
  const projectReady = routeProjectId !== null && currentProject?.id === routeProjectId
  const projectId = projectReady ? routeProjectId : null
  const projectScopeKey = routeProjectId === null ? 'no-project' : `project:${routeProjectId}`
  const projectContextKey = `${projectScopeKey}:${projectReady ? 'ready' : 'loading'}`
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [isResizing, setIsResizing] = useState(false)
  const [fabPos, setFabPos] = useState<FabPos | null>(null)
  const [draggingFab, setDraggingFab] = useState(false)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelLabel, setModelLabel] = useState<string | null>(null)
  const [unread, setUnread] = useState(false)

  const widthRef = useRef(width)
  const fabPosRef = useRef(fabPos)
  const abortRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const scopeRef = useRef(projectContextKey)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const openRef = useRef(open)
  widthRef.current = width
  fabPosRef.current = fabPos
  openRef.current = open
  scopeRef.current = projectContextKey

  const fabDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origX: number
    origY: number
    moved: boolean
  } | null>(null)

  useEffect(() => {
    const savedWidth = Number(localStorage.getItem(STORAGE_WIDTH_KEY))
    if (savedWidth >= MIN_WIDTH && savedWidth <= MAX_WIDTH) setWidth(savedWidth)
    if (localStorage.getItem(STORAGE_OPEN_KEY) === '1') setOpen(true)
    const savedFab = readSavedFabPos()
    if (savedFab) setFabPos(clampFabPos(savedFab, window.innerWidth, window.innerHeight))
  }, [])

  useEffect(() => {
    const update = () => {
      setViewportWidth(window.innerWidth)
      setFabPos((prev) => prev ? clampFabPos(prev, window.innerWidth, window.innerHeight) : prev)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const isMobile = viewportWidth > 0 && viewportWidth <= 640
  const maxAllowed = viewportWidth > 0
    ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth - 80))
    : MAX_WIDTH
  const effectiveWidth = isMobile ? viewportWidth : Math.min(width, maxAllowed)

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('onebase:ai-panel', {
      detail: { open, width: effectiveWidth, mobile: isMobile },
    }))
    const offset = open && !isMobile ? effectiveWidth : 0
    document.documentElement.style.setProperty('--ai-panel-offset', `${offset}px`)
    return () => document.documentElement.style.setProperty('--ai-panel-offset', '0px')
  }, [open, effectiveWidth, isMobile])

  useEffect(() => {
    useAiAssistantStore.getState().consumeRequest()
  }, [projectScopeKey])

  useEffect(() => {
    generationRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setMessages([])
    setInput('')
    setStreaming(false)
    setError(null)
    setModelLabel(null)
    setUnread(false)
  }, [projectContextKey])

  useEffect(() => {
    if (open) messagesEndRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' })
  }, [messages, streaming, open])

  const stop = useCallback(() => {
    generationRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    setMessages((prev) => prev.map((message, index) =>
      message.role === 'assistant' && !message.content && index === prev.length - 1
        ? { ...message, content: '已停止生成。' }
        : message,
    ))
  }, [])

  const newSession = useCallback(() => {
    stop()
    setMessages([])
    setError(null)
    setModelLabel(null)
    setInput('')
  }, [stop])

  const sendPrompt = useCallback(async (raw: string, reset = false, force = false) => {
    const prompt = raw.trim()
    if (!prompt || (streaming && !force)) return
    if (!projectId) {
      setError(
        isWorkspaceRoute
          ? '项目正在切换或加载，请等待项目上下文就绪后再发送。'
          : '未选择项目。请先进入一个项目，再使用 AI 助手。',
      )
      return
    }
    if (streaming) {
      generationRef.current += 1
      abortRef.current?.abort()
    }

    const existing = reset ? [] : messages
    const userMessage: UiMessage = { id: genRequestId('user'), role: 'user', content: prompt }
    const assistantId = genRequestId('assistant')
    const assistantMessage: UiMessage = { id: assistantId, role: 'assistant', content: '' }
    const requestMessages: AiChatMessage[] = [...existing, userMessage].map(({ role, content }) => ({ role, content }))

    setMessages([...existing, userMessage, assistantMessage])
    setInput('')
    setError(null)
    setStreaming(true)
    const controller = new AbortController()
    const generation = generationRef.current + 1
    generationRef.current = generation
    const requestScope = projectContextKey
    abortRef.current = controller

    const onEvent = (event: AiSseEvent) => {
      if (generationRef.current !== generation || scopeRef.current !== requestScope) return
      if (event.type === 'meta') setModelLabel(`${event.provider} · ${event.model}`)
      if (event.type === 'delta') {
        setMessages((prev) => prev.map((message) =>
          message.id === assistantId ? { ...message, content: message.content + event.text } : message,
        ))
      }
      if (event.type === 'error') {
        setError(event.message || 'AI Provider 返回未知错误')
        setMessages((prev) => prev.map((message) =>
          message.id === assistantId && !message.content
            ? { ...message, content: '抱歉，本次回答未能生成。' }
            : message,
        ))
      }
      if (event.type === 'done') {
        setMessages((prev) => prev.map((message) =>
          message.id === assistantId && !message.content
            ? { ...message, content: 'Provider 未返回文本内容。' }
            : message,
        ))
        if (!openRef.current) setUnread(true)
      }
    }

    try {
      await streamAiChat(projectId, { messages: requestMessages, tools_enabled: true }, onEvent, controller.signal)
    } catch (err) {
      if (
        generationRef.current === generation &&
        scopeRef.current === requestScope &&
        (err as Error)?.name !== 'AbortError'
      ) {
        const message = err instanceof Error ? err.message : 'AI 请求失败，请稍后重试'
        setError(message)
        setMessages((prev) => prev.map((item) =>
          item.id === assistantId && !item.content ? { ...item, content: '抱歉，本次回答未能生成。' } : item,
        ))
      }
    } finally {
      if (
        abortRef.current === controller &&
        generationRef.current === generation &&
        scopeRef.current === requestScope
      ) {
        abortRef.current = null
        setStreaming(false)
      }
    }
  }, [isWorkspaceRoute, messages, projectContextKey, projectId, streaming])

  const openNonce = useAiAssistantStore((state) => state.openNonce)
  const request = useAiAssistantStore((state) => state.request)
  const requestNonce = useAiAssistantStore((state) => state.requestNonce)
  const consumeRequest = useAiAssistantStore((state) => state.consumeRequest)

  useEffect(() => {
    if (openNonce <= 0) return
    setOpen(true)
    setUnread(false)
    localStorage.setItem(STORAGE_OPEN_KEY, '1')
  }, [openNonce])

  useEffect(() => {
    if (!request) return
    const text = buildAskText(request)
    consumeRequest()
    if (request.newSession) newSession()
    void sendPrompt(text, !!request.newSession, true)
    // requestNonce 是外部请求的唯一触发信号。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestNonce])

  useEffect(() => () => abortRef.current?.abort(), [])

  const toggle = useCallback(() => {
    setOpen((previous) => {
      const next = !previous
      if (next) setUnread(false)
      localStorage.setItem(STORAGE_OPEN_KEY, next ? '1' : '0')
      return next
    })
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    localStorage.setItem(STORAGE_OPEN_KEY, '0')
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  useEffect(() => {
    if (!isResizing) return
    const onMove = (event: PointerEvent) => {
      setWidth(Math.min(maxAllowed, Math.max(MIN_WIDTH, window.innerWidth - event.clientX)))
    }
    const onUp = () => {
      setIsResizing(false)
      localStorage.setItem(STORAGE_WIDTH_KEY, String(widthRef.current))
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [isResizing, maxAllowed])

  const onFabPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const current = fabPosRef.current ?? defaultFabPos(window.innerWidth, window.innerHeight)
    fabDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origX: current.x,
      origY: current.y,
      moved: false,
    }
  }

  const onFabPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = fabDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && dx * dx + dy * dy < FAB_DRAG_THRESHOLD ** 2) return
    drag.moved = true
    setDraggingFab(true)
    setFabPos(clampFabPos({ x: drag.origX + dx, y: drag.origY + dy }, window.innerWidth, window.innerHeight))
  }

  const endFabDrag = (event: React.PointerEvent<HTMLButtonElement>, openOnClick: boolean) => {
    const drag = fabDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    fabDragRef.current = null
    setDraggingFab(false)
    if (drag.moved) {
      const pos = fabPosRef.current
      if (pos) localStorage.setItem(STORAGE_FAB_POS_KEY, JSON.stringify(pos))
    } else if (openOnClick) {
      toggle()
    }
  }

  return (
    <Fragment>
      <button
        onPointerDown={onFabPointerDown}
        onPointerMove={onFabPointerMove}
        onPointerUp={(event) => endFabDrag(event, true)}
        onPointerCancel={(event) => endFabDrag(event, false)}
        aria-label="AI 助手"
        title="拖动可挪开；点击打开 AI 助手"
        style={fabPos ? { left: fabPos.x, top: fabPos.y, right: 'auto', bottom: 'auto' } : undefined}
        className={`fixed z-[9998] flex h-14 w-14 touch-none items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/30 hover:shadow-xl ${
          fabPos ? '' : 'bottom-6 right-6'
        } ${draggingFab ? 'cursor-grabbing scale-105' : 'cursor-grab transition-[transform,opacity] duration-300 hover:scale-105'} ${
          open ? 'pointer-events-none scale-0 opacity-0' : 'scale-100 opacity-100'
        }`}
      >
        <i className="fas fa-robot text-xl" />
        {unread && <span className="absolute right-1 top-1 h-3.5 w-3.5 rounded-full border-2 border-white bg-rose-500" />}
      </button>

      {isResizing && <div className="fixed inset-0 z-[10001] cursor-col-resize" />}

      <aside
        aria-label="AI 助手面板"
        className={`fixed right-0 top-0 z-[10000] flex h-full flex-col border-l border-gray-200 bg-white shadow-2xl ${
          isResizing ? '' : 'transition-transform duration-300 ease-out'
        } ${open ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ width: `${effectiveWidth}px`, maxWidth: '100vw' }}
      >
        {!isMobile && (
          <div
            onPointerDown={(event) => { event.preventDefault(); setIsResizing(true) }}
            onDoubleClick={() => { setWidth(DEFAULT_WIDTH); localStorage.setItem(STORAGE_WIDTH_KEY, String(DEFAULT_WIDTH)) }}
            className={`absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-indigo-400/40 ${isResizing ? 'bg-indigo-400/60' : ''}`}
            title="拖拽调整宽度（双击复位）"
          />
        )}

        <header className="flex flex-shrink-0 items-center justify-between border-b border-gray-200 bg-gradient-to-r from-indigo-50 to-violet-50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
              <i className="fas fa-robot text-sm" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900">AI 助手</div>
              <div className="truncate text-[10px] text-gray-500">
                {modelLabel || (projectReady ? currentProject?.name : null) || (isWorkspaceRoute ? '项目加载中' : '未选择项目')}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={newSession} title="新会话" className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 hover:text-gray-600">
              <i className="fas fa-plus text-sm" />
            </button>
            <button onClick={stop} disabled={!streaming} title="停止生成" className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 hover:text-gray-600 disabled:opacity-30">
              <i className="fas fa-stop text-sm" />
            </button>
            <button onClick={close} title="关闭" className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 hover:text-gray-600">
              <i className="fas fa-times" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto bg-gray-50/60 px-4 py-5">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center px-5 text-center">
              <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-600">
                <i className="fas fa-wand-magic-sparkles text-xl" />
              </span>
              <h2 className="text-base font-semibold text-gray-900">有什么可以帮你？</h2>
              <p className="mt-2 text-sm leading-6 text-gray-500">
                {projectReady
                  ? '我可以结合当前项目的工作流和数据库元数据协助分析。'
                  : isWorkspaceRoute
                    ? '项目正在切换或加载，项目上下文就绪后即可开始对话。'
                    : '请先进入一个项目，再开始对话。'}
              </p>
            </div>
          )}
          <div className="space-y-4">
            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 ${
                  message.role === 'user'
                    ? 'rounded-br-md bg-indigo-600 text-white'
                    : 'rounded-bl-md border border-gray-200 bg-white text-gray-800 shadow-sm'
                }`}>
                  {message.role === 'assistant' ? (
                    message.content
                      ? <SafeMarkdown content={message.content} />
                      : <span className="flex items-center gap-2 text-sm text-gray-400"><i className="fas fa-circle-notch fa-spin" />正在思考…</span>
                  ) : (
                    <div className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div ref={messagesEndRef} />
        </div>

        {error && (
          <div className="border-t border-red-100 bg-red-50 px-4 py-2.5 text-xs leading-5 text-red-700">
            <i className="fas fa-circle-exclamation mr-2" />
            {error}
          </div>
        )}

        <form
          className="flex-shrink-0 border-t border-gray-200 bg-white p-3"
          onSubmit={(event) => { event.preventDefault(); void sendPrompt(input) }}
        >
          <div className="rounded-xl border border-gray-300 bg-white p-2 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void sendPrompt(input)
                }
              }}
              disabled={streaming || !projectReady}
              rows={2}
              placeholder={
                projectReady
                  ? '输入问题，Enter 发送，Shift+Enter 换行'
                  : isWorkspaceRoute
                    ? '项目加载中，请稍候'
                    : '请先进入一个项目'
              }
              className="block max-h-36 min-h-[48px] w-full resize-none border-0 bg-transparent px-1 text-sm outline-none placeholder:text-gray-400 disabled:bg-transparent"
            />
            <div className="flex items-center justify-between pt-1">
              <span className="px-1 text-[10px] text-gray-400">回答仅在当前页面内存中保存</span>
              {streaming ? (
                <button type="button" onClick={stop} className="flex h-8 items-center gap-1.5 rounded-lg bg-gray-900 px-3 text-xs font-medium text-white">
                  <i className="fas fa-stop" />停止
                </button>
              ) : (
                <button type="submit" disabled={!input.trim() || !projectReady} className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40" title="发送">
                  <i className="fas fa-arrow-up text-xs" />
                </button>
              )}
            </div>
          </div>
        </form>
      </aside>
    </Fragment>
  )
}
