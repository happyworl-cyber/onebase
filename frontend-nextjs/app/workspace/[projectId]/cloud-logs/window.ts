export const MAX_WINDOW_SECS = 7 * 86400
export const MAX_WINDOW_ERROR = '时间窗不能超过 7 天'

export function oversizeWindowError(from?: number, to?: number): string | null {
  if (from == null || to == null) return null
  if (to - from > MAX_WINDOW_SECS) return MAX_WINDOW_ERROR
  return null
}
