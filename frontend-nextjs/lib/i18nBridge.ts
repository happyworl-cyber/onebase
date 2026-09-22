/**
 * 非 React 上下文（axios 拦截器）里按后端错误 `code` 取 i18n 文案的桥。
 *
 * 后端错误响应形如 { error: <文案>, code: <稳定码> }（见 src/error.rs）。拦截器在
 * React 树之外，拿不到 useTranslations，所以由一个挂在 NextIntlClientProvider 下的
 * 客户端组件（I18nErrorBridge）在语言变化时注册一个「code → 译文」的解析器。
 * 解析器只对存在对应词条的 code 返回译文，否则返回 null 让调用方回退到后端原文。
 */
type ErrorTranslator = (code: string, values?: Record<string, unknown>) => string | null

let translator: ErrorTranslator | null = null

export function setErrorTranslator(fn: ErrorTranslator | null): void {
  translator = fn
}

/**
 * 有 code 且有对应译文时返回译文（用后端下发的 params 插值）；否则返回后端原文 fallback。
 */
export function resolveErrorMessage(
  code: string | undefined | null,
  fallback: string,
  params?: Record<string, unknown>,
): string {
  if (code && translator) {
    const translated = translator(code, params)
    if (translated) return translated
  }
  return fallback
}
