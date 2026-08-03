/**
 * DeepWork Embed 桥接协议（embed-bridge）客户端封装。
 *
 * 文档见对接说明：所有消息走统一 envelope { protocol:'embed-bridge', type, requestId?, payload? }。
 * 这里只封装宿主 -> Embed 的发送动作，以及监听 Embed -> 宿主的 assistant-complete。
 */

export const EMBED_PROTOCOL = 'embed-bridge' as const

/**
 * ===== 可配置项（通过环境变量）=====
 *
 * 这些 NEXT_PUBLIC_* 变量在构建期被静态内联到前端 bundle，
 * 必须以字面量形式直接访问 process.env.XXX（不可动态拼 key）。
 *
 *   NEXT_PUBLIC_DEEPWORK_EMBED_URL   —— Embed 页面完整地址（含 projectId）。
 *                                       origin / targetOrigin 自动从该地址推导。
 *   NEXT_PUBLIC_AI_ASSISTANT_ENABLED —— 是否启用 AI 助手（'0'/'false'/'off'/'no' 关闭）。
 *                                       缺省视为启用。
 *   NEXT_PUBLIC_DEEPWORK_EMBED_API_KEY —— 项目级 API Key，配置后启用 Embed
 *                                       API Key 自动登录模式（见 buildEmbedSrc）。
 */
const DEFAULT_EMBED_URL = 'https://deepwork.mindoffice.cn/embed/onebase'
const DEFAULT_EMBED_ORIGIN = 'https://deepwork.mindoffice.cn'

/** Embed 页面基础地址（默认 projectId = onebase，可由环境变量覆盖）。 */
export const EMBED_BASE_URL =
  process.env.NEXT_PUBLIC_DEEPWORK_EMBED_URL || DEFAULT_EMBED_URL

/** Embed 站点 origin（postMessage targetOrigin / 来源校验都用它），从 EMBED_BASE_URL 推导。 */
export const EMBED_ORIGIN = ((): string => {
  try {
    return new URL(EMBED_BASE_URL).origin
  } catch {
    return DEFAULT_EMBED_ORIGIN
  }
})()

/** 是否启用 AI 助手嵌入（默认启用；显式设为关闭值时停用整个面板）。 */
export const AI_ASSISTANT_ENABLED = ((): boolean => {
  const raw = process.env.NEXT_PUBLIC_AI_ASSISTANT_ENABLED
  if (raw == null || raw === '') return true
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())
})()

/**
 * 项目级 API Key：配置后 iframe 加载后通过 embed:set-access-token 下发，实现免跳转登录。
 * 注意 NEXT_PUBLIC_* 会在构建期内联进前端 bundle，属公开值；不配置则回退到原登录方式。
 */
export const EMBED_API_KEY = (process.env.NEXT_PUBLIC_DEEPWORK_EMBED_API_KEY || '').trim()

export interface EmbedEnvelope<TType extends string = string, TPayload = unknown> {
  protocol: typeof EMBED_PROTOCOL
  type: TType
  requestId?: string
  payload?: TPayload
}

export type EmbedMeta = Record<string, string>

export interface SetContextPayload {
  currentFile?: string | null
  openFiles?: string[]
  selectedAgent?: { id: string; name?: string } | null
  skills?: string[]
  meta?: EmbedMeta | null
}

export interface AssistantCompletePayload {
  sessionId: string | null
  requestId: string
  timestamp: string
}

/** 生成宿主侧 requestId，便于把发送与 assistant-complete 关联。 */
export function genRequestId(prefix = 'host'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 过滤出合法的 meta（key/value 转字符串，忽略空 key / 空值）。 */
export function sanitizeMeta(input: Record<string, unknown> | null | undefined): EmbedMeta {
  const out: EmbedMeta = {}
  if (!input) return out
  for (const [k, v] of Object.entries(input)) {
    if (!k) continue
    if (v === undefined || v === null || v === '') continue
    out[k] = String(v)
  }
  return out
}

/**
 * 桥接发送器：绑定一个"取 iframe window 的函数"和 targetOrigin。
 * window 取不到时静默忽略（iframe 尚未加载）。
 */
export class EmbedBridge {
  constructor(
    private getWindow: () => Window | null,
    private targetOrigin: string = EMBED_ORIGIN,
  ) {}

  post<T extends string, P>(type: T, payload?: P, requestId?: string): void {
    const win = this.getWindow()
    if (!win) return
    const envelope: EmbedEnvelope<T, P> = {
      protocol: EMBED_PROTOCOL,
      type,
      ...(requestId ? { requestId } : {}),
      ...(payload !== undefined ? { payload } : {}),
    }
    win.postMessage(envelope, this.targetOrigin)
  }

  /**
   * 下发登录凭证，实现 Embed 免跳转登录（见文档 §1 / §8.9）。
   * 这里传入的是项目级 API Key 的值；Embed 端据此建立登录态。
   * 因协议无 ready 握手，调用方应在 iframe ready 后配合退避重试多次补发。
   */
  setAccessToken(accessToken: string): void {
    if (!accessToken) return
    this.post('embed:set-access-token', { accessToken })
  }

  setContext(payload: SetContextPayload): void {
    this.post('embed:set-context', payload)
  }

  /** 覆盖式设置宿主注入的环境变量；传 null 清空。 */
  setMeta(meta: EmbedMeta | null): void {
    this.post('embed:set-meta', { meta })
  }

  insertInput(value: string): void {
    this.post('embed:insert-input', { value })
  }

  setInput(value: string): void {
    this.post('embed:set-input', { value })
  }

  sendMessage(message?: string, requestId?: string): void {
    this.post('embed:send-message', message ? { message } : undefined, requestId)
  }

  stopResponse(): void {
    this.post('embed:stop-response')
  }

  newSession(message?: string, autoSend?: boolean): void {
    const payload: { message?: string; autoSend?: boolean } = {}
    if (message !== undefined) payload.message = message
    if (autoSend !== undefined) payload.autoSend = autoSend
    this.post('embed:new-session', payload)
  }
}

/**
 * 监听 Embed -> 宿主的 assistant-complete。
 * 返回清理函数。会做来源校验（origin + protocol）。
 */
export function onAssistantComplete(
  cb: (payload: AssistantCompletePayload) => void,
  expectedOrigin: string = EMBED_ORIGIN,
): () => void {
  const handler = (event: MessageEvent) => {
    if (event.origin !== expectedOrigin) return
    const data = event.data as EmbedEnvelope<string, AssistantCompletePayload> | undefined
    if (!data || data.protocol !== EMBED_PROTOCOL) return
    if (data.type !== 'embed:assistant-complete') return
    if (data.payload) cb(data.payload)
  }
  window.addEventListener('message', handler)
  return () => window.removeEventListener('message', handler)
}

/**
 * 构造带 allowed_origin 的 Embed URL（生产建议始终显式声明宿主来源）。
 *
 * 注意：登录凭证不再放进 URL，避免明文 key 出现在地址栏 / 历史 / 录屏；
 * 改为 iframe 加载后通过 embed:set-access-token 以 postMessage 下发（见 EmbedBridge.setAccessToken）。
 */
export function buildEmbedSrc(hostOrigin: string): string {
  const u = new URL(EMBED_BASE_URL)
  if (hostOrigin) u.searchParams.set('allowed_origin', hostOrigin)
  return u.toString()
}
