import { create } from 'zustand'
import { getAuthToken } from '@/lib/auth'

/** 显式设为 0 / false / off / no 时关闭整个 AI 助手。 */
export const AI_ASSISTANT_ENABLED = (() => {
  const raw = process.env.NEXT_PUBLIC_AI_ASSISTANT_ENABLED
  if (raw == null || raw === '') return true
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())
})()

export interface AiFileRef {
  /** 文件路径（workspace 相对路径或原始路径） */
  value: string
  /** 来源：默认 workspace；本地设备文件用 local_device */
  origin?: 'workspace' | 'local_device'
  /** 展示用原始路径（保留大小写/前缀场景） */
  displayPath?: string
}

export interface AiAskRequest {
  /** 用户可见的提问文本 */
  prompt: string
  /** 可选：作为 file chip 附带的文件引用 */
  files?: AiFileRef[]
  /** 是否先新建会话再发送 */
  newSession?: boolean
  /** 关联完成回调用的 requestId */
  requestId?: string
  /** 保留旧调用兼容；原生助手暂不支持指定外部 AI 员工。 */
  selectedAgent?: { id: string; name?: string } | null
  /** 保留旧调用兼容；会作为文本上下文附加到提问中。 */
  skills?: string[]
}

interface AiAssistantStore {
  /** 自增信号：请求打开面板 */
  openNonce: number
  /** 最近一次提问请求（由面板消费后置空） */
  request: AiAskRequest | null
  /** 自增信号：标识新的请求到来 */
  requestNonce: number
  open: () => void
  ask: (req: AiAskRequest) => void
  consumeRequest: () => void
}

export const useAiAssistantStore = create<AiAssistantStore>((set) => ({
  openNonce: 0,
  request: null,
  requestNonce: 0,
  open: () => set((s) => ({ openNonce: s.openNonce + 1 })),
  ask: (req) =>
    set((s) => ({
      request: req,
      requestNonce: s.requestNonce + 1,
      openNonce: s.openNonce + 1,
    })),
  consumeRequest: () => set({ request: null }),
}))

/** 打开 AI 面板（不发起提问）。 */
export function openAiAssistant(): void {
  useAiAssistantStore.getState().open()
}

/** 打开 AI 面板并发起一轮提问。 */
export function askAi(req: AiAskRequest): void {
  useAiAssistantStore.getState().ask(req)
}

/** 生成调用侧 requestId，兼容原有数据库 AI 入口。 */
export function genRequestId(prefix = 'host'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 旧 API 兼容：原生聊天以安全纯文本表达文件引用，不再生成 Embed XML chip。 */
export function buildFileChip(f: AiFileRef): string {
  return `- ${f.displayPath || f.value}${f.origin === 'local_device' ? '（本地文件）' : ''}`
}

/** 组装发送给原生聊天接口的用户文本。 */
export function buildAskText(req: AiAskRequest): string {
  const sections = [req.prompt.trim()]
  if (req.files?.length) {
    sections.push(`相关文件：\n${req.files.map(buildFileChip).join('\n')}`)
  }
  if (req.skills?.length) {
    sections.push(`请参考这些技能方向：${req.skills.join('、')}`)
  }
  return sections.filter(Boolean).join('\n\n')
}

export type AiChatRole = 'system' | 'user' | 'assistant'

export interface AiChatMessage {
  role: AiChatRole
  content: string
}

export interface AiChatRequest {
  provider_id?: number
  messages: AiChatMessage[]
  tools_enabled?: boolean
  temperature?: number
  max_tokens?: number
}

export type AiSseEvent =
  | { type: 'meta'; provider_id: number; provider: string; model: string; tools_enabled: boolean }
  | { type: 'delta'; text: string }
  | { type: 'tool'; id?: string; name?: string; arguments?: unknown; result?: unknown }
  | { type: 'usage'; [key: string]: unknown }
  | { type: 'done'; ok?: boolean }
  | { type: 'error'; message: string }

export class AiChatError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'AiChatError'
  }
}

function chatErrorMessage(status: number, raw: string): string {
  let detail = raw
  try {
    const parsed = JSON.parse(raw)
    detail = parsed?.error || parsed?.message || raw
  } catch {
    // 非 JSON 响应直接使用文本。
  }
  if (status === 403) return detail || '权限不足：当前账号不能使用此项目的 AI 助手'
  if (status === 404) return detail || '项目尚未配置 AI Provider，请联系项目管理员'
  if (status === 401) return '登录状态已失效，请重新登录'
  return detail || `AI 请求失败（HTTP ${status}）`
}

function parseSseBlock(block: string): AiSseEvent | null {
  let eventName = ''
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return null
  try {
    const payload = JSON.parse(data.join('\n')) as Record<string, unknown>
    const type = String(payload.type || eventName)
    return { ...payload, type } as AiSseEvent
  } catch {
    return {
      type: 'error',
      message: `无法解析 AI 流式响应（${eventName || 'unknown'}）`,
    }
  }
}

/**
 * 使用 fetch + ReadableStream 消费后端 SSE。
 * 调用方传入 AbortSignal 即可停止生成；正常完成会收到 done 事件。
 */
export async function streamAiChat(
  projectId: number,
  request: AiChatRequest,
  onEvent: (event: AiSseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isFinite(projectId) || projectId <= 0) {
    throw new AiChatError('未选择项目，无法发起 AI 对话')
  }

  const apiBase = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, '')
  const token = getAuthToken()
  const response = await fetch(`${apiBase}/api/projects/${projectId}/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Tenant-Id': String(projectId),
    },
    body: JSON.stringify(request),
    signal,
  })

  if (!response.ok) {
    const raw = await response.text()
    throw new AiChatError(chatErrorMessage(response.status, raw), response.status)
  }
  if (!response.body) {
    throw new AiChatError('浏览器未收到可读取的 AI 流式响应')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      let splitAt = buffer.indexOf('\n\n')
      while (splitAt >= 0) {
        const block = buffer.slice(0, splitAt)
        buffer = buffer.slice(splitAt + 2)
        const event = parseSseBlock(block)
        if (event) onEvent(event)
        splitAt = buffer.indexOf('\n\n')
      }
      if (done) break
    }
    if (buffer.trim()) {
      const event = parseSseBlock(buffer)
      if (event) onEvent(event)
    }
  } finally {
    reader.releaseLock()
  }
}
