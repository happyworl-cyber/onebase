/**
 * 全局 AI 助手控制器：让任意页面都能"打开面板并向 Embed 发起一轮提问"。
 *
 * 页面只需调用 askAi(...) / openAiAssistant()，真正的桥接发送由
 * AiAssistantPanel 统一消费（它持有 iframe / EmbedBridge）。
 */
import { create } from 'zustand'

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
  /** 可选：透传给 embed:set-context 的 AI 员工（null 表示清空选择） */
  selectedAgent?: { id: string; name?: string } | null
  /** 可选：透传给 embed:set-context 的技能列表（受控状态） */
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

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 把文件引用渲染成 Embed 支持的 <chip kind="file" .../>。 */
export function buildFileChip(f: AiFileRef): string {
  const parts = ['kind="file"', `value="${escapeAttr(f.value)}"`]
  if (f.displayPath) parts.push(`display_path="${escapeAttr(f.displayPath)}"`)
  // workspace 是默认值，省略以减少 token；只有 local_device 才显式写出
  if (f.origin && f.origin !== 'workspace') parts.push(`origin="${f.origin}"`)
  return `<chip ${parts.join(' ')} />`
}

/** 组装最终要写入输入框的文本（提问 + 文件 chip）。 */
export function buildAskText(req: AiAskRequest): string {
  const chips = (req.files || []).map(buildFileChip).join(' ')
  return chips ? `${req.prompt} ${chips}`.trim() : req.prompt
}
