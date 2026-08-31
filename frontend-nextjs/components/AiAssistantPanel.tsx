'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildEmbedSrc,
  EMBED_API_KEY,
  EMBED_BASE_URL,
  EmbedBridge,
  onAssistantComplete,
  sanitizeMeta,
  type SetContextPayload,
} from '@/lib/embedBridge'
import { useAppStore } from '@/lib/store'
import { getAuthToken } from '@/lib/auth'
import { buildAskText, useAiAssistantStore } from '@/lib/aiAssistant'

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
    const p = JSON.parse(raw) as FabPos
    if (
      typeof p?.x === 'number' &&
      typeof p?.y === 'number' &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y)
    ) {
      return p
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 全局 AI 助手面板：在页面右侧滑出一个嵌入 DeepWork AI 页面的窗口。
 *
 * - iframe 一旦加载就保持挂载（关闭时仅平移到屏幕外），以保留对话上下文。
 * - 通过 embed-bridge 协议向 Embed 注入平台上下文（meta 环境变量），
 *   并监听 AI 回答完成事件（关闭时在悬浮按钮上显示未读小圆点）。
 * - 面板宽度可拖拽调整，开关状态与宽度持久化到 localStorage。
 * - 关闭时的悬浮按钮可拖到视口任意位置（点一下仍开关面板），位置也持久化。
 */
export default function AiAssistantPanel() {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [iframeReady, setIframeReady] = useState(false)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [hostOrigin, setHostOrigin] = useState('')
  const [unread, setUnread] = useState(false)
  // 拖拽中：用 state 驱动一层全屏透明遮罩，避免指针移到 iframe 上时事件被 iframe
  // 吞掉导致拖拽中断（经典 iframe resize 问题）。
  const [isResizing, setIsResizing] = useState(false)
  const [fabPos, setFabPos] = useState<FabPos | null>(null)
  const [draggingFab, setDraggingFab] = useState(false)
  // 当前视口宽度，用于自适应（小屏全屏、按视口夹取宽度）。0 表示尚未测量（SSR）。
  const [viewportWidth, setViewportWidth] = useState(0)
  const fabPosRef = useRef(fabPos)
  fabPosRef.current = fabPos
  const fabDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origX: number
    origY: number
    moved: boolean
  } | null>(null)
  const widthRef = useRef(width)
  widthRef.current = width

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const bridgeRef = useRef<EmbedBridge | null>(null)
  if (!bridgeRef.current) {
    bridgeRef.current = new EmbedBridge(() => iframeRef.current?.contentWindow ?? null)
  }

  // 平台上下文（注入到 Embed 的 meta 环境变量，供 AI 执行脚本读取）
  const currentUser = useAppStore((s) => s.currentUser)
  const currentProject = useAppStore((s) => s.currentProject)
  const currentConnection = useAppStore((s) => s.currentConnection)
  const currentTenant = useAppStore((s) => s.currentTenant)

  const meta = useMemo(
    () =>
      sanitizeMeta({
        onebase_gui_url: hostOrigin,
        // 当前登录会话令牌（OneBase 自有 JWT），供 AI 回调 OneBase 接口时做身份验证：
        // 后端 auth_middleware 按 `Authorization: Bearer <token>`（或 `?token=`）校验签名/过期/
        // jti(user_sessions)，从而识别"当前登录用户"。随 currentUser 变化重算（登录/登出刷新）。
        onebase_apikey: getAuthToken() ?? undefined,
        onebase_tenant_id: currentConnection?.tenant_id ?? currentTenant?.id,
        onebase_tenant_name: currentConnection?.tenant_name ?? currentTenant?.name,
        onebase_project: currentProject?.slug ?? currentProject?.name,
        onebase_project_id: currentProject?.id,
        onebase_database_id:
          currentConnection?.database_id ?? currentProject?.primary_connection?.database_id,
        onebase_connection_name: currentConnection?.connection_name,
        onebase_db_name: currentConnection?.db_name ?? currentProject?.primary_connection?.db_name,
        onebase_user: currentUser?.username,
        onebase_role: currentProject?.user_role ?? currentUser?.role,
      }),
    [hostOrigin, currentUser, currentProject, currentConnection, currentTenant],
  )
  const metaKey = JSON.stringify(meta)
  // 始终持有最新 meta，供发送前重新断言（避免闭包拿到旧值）
  const metaRef = useRef(meta)
  metaRef.current = meta

  // 初始化：读取持久化状态 + 记录宿主 origin
  useEffect(() => {
    setHostOrigin(window.location.origin)
    const savedWidth = Number(localStorage.getItem(STORAGE_WIDTH_KEY))
    if (savedWidth >= MIN_WIDTH && savedWidth <= MAX_WIDTH) {
      setWidth(savedWidth)
    }
    if (localStorage.getItem(STORAGE_OPEN_KEY) === '1') {
      setOpen(true)
      setLoaded(true)
    }
    const savedFab = readSavedFabPos()
    if (savedFab) {
      setFabPos(clampFabPos(savedFab, window.innerWidth, window.innerHeight))
    }
  }, [])

  // 跟踪视口宽度，驱动自适应（小屏改全屏、按视口夹取宽度）。
  useEffect(() => {
    const update = () => {
      setViewportWidth(window.innerWidth)
      setFabPos((prev) =>
        prev ? clampFabPos(prev, window.innerWidth, window.innerHeight) : prev,
      )
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // 小屏（≤640px）直接全屏覆盖，不再做侧边拖拽 / 推开正文。
  const isMobile = viewportWidth > 0 && viewportWidth <= 640
  // 桌面端最大宽度：不超过 MAX_WIDTH，且至少给正文留 80px，避免拖到把整页盖死。
  const maxAllowed =
    viewportWidth > 0
      ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth - 80))
      : MAX_WIDTH
  // 实际渲染宽度：小屏占满视口；桌面端把持久化宽度夹到当前视口允许的范围内。
  const effectiveWidth = isMobile ? viewportWidth : Math.min(width, maxAllowed)

  // 向页面广播当前面板布局，供其他右侧抽屉（如工作流调试）避让，避免重叠。
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('onebase:ai-panel', {
        detail: { open, width: effectiveWidth, mobile: isMobile },
      }),
    )
  }, [open, effectiveWidth, isMobile])

  const embedSrc = useMemo(() => (hostOrigin ? buildEmbedSrc(hostOrigin) : ''), [hostOrigin])

  // iframe ready 后，通过 embed:set-access-token 下发登录凭证（项目级 API Key），
  // 实现免跳转登录。凭证不再放进 URL，避免明文出现在地址栏 / 历史 / 录屏。
  //
  // 与 meta 同理：协议没有 ready 握手或 ack，只发一次可能在 Embed 注册监听器之前
  // 被错过，导致登录不生效。这里在 ready 后用退避重试多次补发；登录成功后重复下发无副作用。
  useEffect(() => {
    if (!iframeReady || !EMBED_API_KEY) return
    const push = () => bridgeRef.current?.setAccessToken(EMBED_API_KEY)
    push()
    const timers = [200, 500, 1000, 2000, 3500, 6000, 9000].map((d) =>
      setTimeout(push, d),
    )
    return () => timers.forEach(clearTimeout)
  }, [iframeReady])

  // iframe ready 后，把平台上下文作为 meta 注入（持续受控状态）。
  //
  // 关键：Embed 内部的 bridge 监听器是在鉴权/加载完成后才注册的，且协议没有
  // ready 握手或 ack（见文档 §8.6）。只在 iframe onLoad 发一次会被错过，导致
  // 后续 AI 请求里没有 meta。这里在 ready 后用退避重试多次补发，覆盖 Embed
  // 较晚才挂载监听器的情况；meta 变化时也会重新触发整轮补发。
  useEffect(() => {
    if (!iframeReady) return
    const push = () => bridgeRef.current?.setMeta(metaRef.current)
    push()
    const timers = [400, 900, 1600, 2800, 4500, 7000, 10000].map((d) =>
      setTimeout(push, d),
    )
    return () => timers.forEach(clearTimeout)
  }, [iframeReady, metaKey])

  // 监听 AI 回答完成：面板关闭时点亮未读小圆点
  const openRef = useRef(open)
  openRef.current = open
  // 已发出、等待完成的 requestId（用于把发送与 assistant-complete 一一对应）
  const pendingRequestIds = useRef<Set<string>>(new Set())
  // 一旦收到过任意一次 assistant-complete，即可确定 Embed 已登录、bridge 监听器
  // 已就绪——后续提问可以"热路径"立即发送，不必再走冷启动的退避补发。
  const settledRef = useRef(false)
  useEffect(() => {
    return onAssistantComplete((payload) => {
      settledRef.current = true
      if (payload.requestId) pendingRequestIds.current.delete(payload.requestId)
      if (!openRef.current) setUnread(true)
    })
  }, [])

  // 记录 iframe ready 的时刻：用于判断 Embed 是否大概率已完成 apikey 登录
  // （ready 足够久 ⇒ 监听器已注册），从而对提问选择热/冷发送时序。
  const readyAtRef = useRef(0)
  useEffect(() => {
    if (iframeReady) readyAtRef.current = Date.now()
  }, [iframeReady])

  // 外部页面通过 useAiAssistantStore 请求打开 / 发起提问
  const openNonce = useAiAssistantStore((s) => s.openNonce)
  const request = useAiAssistantStore((s) => s.request)
  const requestNonce = useAiAssistantStore((s) => s.requestNonce)
  const consumeRequest = useAiAssistantStore((s) => s.consumeRequest)
  const pendingRef = useRef(false)
  // 当前这轮提问投递排队中的定时器；下一轮提问到来或卸载时清理，避免叠加补发。
  const deliverTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => deliverTimersRef.current.forEach(clearTimeout), [])

  // 收到打开信号：展开面板并加载 iframe
  useEffect(() => {
    if (openNonce <= 0) return
    setOpen(true)
    setLoaded(true)
    setUnread(false)
    localStorage.setItem(STORAGE_OPEN_KEY, '1')
  }, [openNonce])

  // 把面板当前占用的右侧宽度暴露成全局 CSS 变量 --ai-panel-offset，
  // 供页面级抽屉（components/Drawer）避让，避免抽屉与 AI 面板叠在右侧冲突。
  // 用 CSS 变量是因为它对已挂载的抽屉是“活的”：面板开/关/拖宽时抽屉自动跟随，
  // 不需要抽屉重新渲染。
  // 小屏全屏覆盖时不推开正文（offset=0，正文被整屏面板盖住即可）；
  // 桌面端按实际宽度让出空间。
  useEffect(() => {
    const root = document.documentElement
    const offset = open && !isMobile ? effectiveWidth : 0
    root.style.setProperty('--ai-panel-offset', `${offset}px`)
    return () => {
      root.style.setProperty('--ai-panel-offset', '0px')
    }
  }, [open, isMobile, effectiveWidth])

  // 收到提问请求：等 iframe ready 后通过桥接发送（必要时先排队）。
  //
  // 关键时序问题：Embed 改用 apikey（embed:set-access-token）异步登录后，
  // 其 bridge 监听器是在"登录完成"才注册的，而 iframe onLoad（iframeReady）
  // 早于登录完成。若只在 ready 那一刻发一次 set-input/send-message，会抢在
  // 监听器注册之前被静默丢弃 —— 表现为"点 AI 分析后右侧输入框没有内容"。
  //
  // 解决：把幂等的 setup（set-meta / set-context / set-input）按退避多次补发，
  // 保证文本最终落进输入框；send-message 非幂等（重发=重复提问），只发一次，
  // 安排在补发若干次、登录大概率完成之后。若 Embed 早已就绪（曾收到过
  // assistant-complete，或 ready 已超过阈值），走热路径快速发送，避免无谓等待。
  useEffect(() => {
    if (request) pendingRef.current = true
    if (!iframeReady || !pendingRef.current) return
    const req = useAiAssistantStore.getState().request
    if (!req) return
    const bridge = bridgeRef.current
    if (!bridge) return

    // 取消上一轮可能还在排队的补发，避免两轮提问的定时器叠加。
    deliverTimersRef.current.forEach(clearTimeout)
    deliverTimersRef.current = []

    if (req.newSession) bridge.newSession()

    // set-context：把 AI 员工 / 技能 / 工作区文件作为"发送上下文"下发。
    // 只在请求显式提供时才带上对应字段，避免覆盖用户在 Embed 内的手动选择；
    // 按文档 §8.4，只有 workspace 来源的文件才放进 currentFile / openFiles，
    // local_device 文件仅以 chip 形式出现在输入框里。
    const workspaceFiles = (req.files ?? [])
      .filter((f) => !f.origin || f.origin === 'workspace')
      .map((f) => f.value)
    const ctx: SetContextPayload = {}
    if (req.selectedAgent !== undefined) ctx.selectedAgent = req.selectedAgent
    if (req.skills) ctx.skills = req.skills
    if (workspaceFiles.length) {
      ctx.currentFile = workspaceFiles[0]
      ctx.openFiles = workspaceFiles
    }
    const hasCtx = Object.keys(ctx).length > 0
    const text = buildAskText(req)

    // 幂等的"准备输入框"动作：可安全重复发送。
    // 每次都重新断言 meta，确保程序化提问一定带上平台上下文环境变量。
    const pushSetup = () => {
      bridge.setMeta(metaRef.current)
      if (hasCtx) bridge.setContext(ctx)
      if (text) bridge.setInput(text)
    }

    if (req.requestId) pendingRequestIds.current.add(req.requestId)

    // 热路径：Embed 已确认就绪 ⇒ 几乎立即发送；冷路径：退避补发后再发一次。
    const warm =
      settledRef.current || (readyAtRef.current > 0 && Date.now() - readyAtRef.current > 5000)
    const sendDelay = warm ? 250 : 2400
    // 只在"发送之前"补发 setup，避免发送后再 set-input 把已清空的输入框重新填上。
    const setupDelays = [200, 600, 1200, 2000].filter((d) => d < sendDelay)

    pushSetup()
    deliverTimersRef.current = setupDelays.map((d) => setTimeout(pushSetup, d))
    deliverTimersRef.current.push(
      setTimeout(() => {
        pushSetup()
        bridge.sendMessage(undefined, req.requestId)
      }, sendDelay),
    )

    pendingRef.current = false
    consumeRequest()
  }, [requestNonce, iframeReady, request, consumeRequest])

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      if (next) {
        setLoaded(true)
        setUnread(false)
      }
      localStorage.setItem(STORAGE_OPEN_KEY, next ? '1' : '0')
      return next
    })
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    localStorage.setItem(STORAGE_OPEN_KEY, '0')
  }, [])

  // Escape 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  // 拖拽调整宽度（用 pointer 事件，兼容鼠标 / 触控）。
  // 拖拽期间靠下面渲染的全屏遮罩接收指针事件，绕过 iframe 吞事件的问题。
  useEffect(() => {
    if (!isResizing) return
    const onMove = (e: PointerEvent) => {
      const next = Math.min(maxAllowed, Math.max(MIN_WIDTH, window.innerWidth - e.clientX))
      setWidth(next)
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

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }

  const onFabPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const current = fabPosRef.current ?? defaultFabPos(window.innerWidth, window.innerHeight)
    fabDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: current.x,
      origY: current.y,
      moved: false,
    }
  }

  const onFabPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = fabDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && dx * dx + dy * dy < FAB_DRAG_THRESHOLD * FAB_DRAG_THRESHOLD) return
    drag.moved = true
    setDraggingFab(true)
    setFabPos(
      clampFabPos(
        { x: drag.origX + dx, y: drag.origY + dy },
        window.innerWidth,
        window.innerHeight,
      ),
    )
  }

  const endFabDrag = (
    e: React.PointerEvent<HTMLButtonElement>,
    openOnClick: boolean,
  ) => {
    const drag = fabDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    fabDragRef.current = null
    setDraggingFab(false)
    if (drag.moved) {
      const pos = fabPosRef.current
      if (pos) localStorage.setItem(STORAGE_FAB_POS_KEY, JSON.stringify(pos))
      return
    }
    if (openOnClick) toggle()
  }

  return (
    <>
      {/* 悬浮触发按钮 */}
      <button
        onPointerDown={onFabPointerDown}
        onPointerMove={onFabPointerMove}
        onPointerUp={(e) => endFabDrag(e, true)}
        onPointerCancel={(e) => endFabDrag(e, false)}
        aria-label="AI 助手"
        title="拖动可挪开；点击打开 AI 助手"
        style={
          fabPos
            ? { left: fabPos.x, top: fabPos.y, right: 'auto', bottom: 'auto' }
            : undefined
        }
        className={`fixed z-[9998] flex h-14 w-14 touch-none items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/30 hover:shadow-xl ${
          fabPos ? '' : 'bottom-6 right-6'
        } ${
          draggingFab
            ? 'cursor-grabbing scale-105'
            : 'cursor-grab transition-[transform,opacity] duration-300 hover:scale-105'
        } ${open ? 'pointer-events-none scale-0 opacity-0' : 'scale-100 opacity-100'}`}
      >
        <i className="fas fa-robot text-xl"></i>
        {unread && (
          <span className="absolute right-1 top-1 flex h-3.5 w-3.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75"></span>
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-white bg-rose-500"></span>
          </span>
        )}
      </button>

      {/* 拖拽期间的全屏遮罩：接住指针事件，避免移到 iframe 上时拖拽中断 */}
      {isResizing && (
        <div className="fixed inset-0 z-[10001] cursor-col-resize" />
      )}

      {/* 右侧面板 */}
      <div
        className={`fixed right-0 top-0 z-[10000] flex h-full flex-col border-l border-gray-200 bg-white shadow-2xl ${
          isResizing ? '' : 'transition-transform duration-300 ease-out'
        } ${open ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ width: `${effectiveWidth}px`, maxWidth: '100vw' }}
      >
        {/* 拖拽手柄（小屏全屏时不显示） */}
        {!isMobile && (
          <div
            onPointerDown={startResize}
            onDoubleClick={() => {
              setWidth(DEFAULT_WIDTH)
              localStorage.setItem(STORAGE_WIDTH_KEY, String(DEFAULT_WIDTH))
            }}
            className={`absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize transition-colors hover:bg-indigo-400/40 ${
              isResizing ? 'bg-indigo-400/60' : 'bg-transparent'
            }`}
            title="拖拽调整宽度（双击复位）"
          />
        )}

        {/* 头部 */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-200 bg-gradient-to-r from-indigo-50 to-violet-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
              <i className="fas fa-robot text-sm"></i>
            </span>
            <span className="text-sm font-semibold text-gray-900">AI 助手</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => bridgeRef.current?.newSession()}
              title="新对话"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
            >
              <i className="fas fa-plus text-sm"></i>
            </button>
            <button
              onClick={() => bridgeRef.current?.stopResponse()}
              title="停止当前回答"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
            >
              <i className="fas fa-stop text-sm"></i>
            </button>
            <a
              href={EMBED_BASE_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="在新标签页打开"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
            >
              <i className="fas fa-up-right-from-square text-sm"></i>
            </a>
            <button
              onClick={close}
              title="关闭"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
            >
              <i className="fas fa-times"></i>
            </button>
          </div>
        </div>

        {/* iframe 容器 */}
        <div className="relative flex-1 overflow-hidden">
          {loaded && embedSrc && (
            <iframe
              ref={iframeRef}
              src={embedSrc}
              title="AI 助手"
              className="h-full w-full border-0"
              allow="clipboard-read; clipboard-write; microphone"
              onLoad={() => setIframeReady(true)}
            />
          )}
          {loaded && !iframeReady && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white text-gray-400">
              <i className="fas fa-circle-notch fa-spin text-2xl text-indigo-500"></i>
              <span className="text-sm">正在加载 AI 助手…</span>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
