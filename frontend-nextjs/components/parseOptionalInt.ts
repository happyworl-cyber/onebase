export type OptionalInt = number | ''

/** 数字输入：允许清空后再键入；空串不回落到默认值。 */
export function parseOptionalInt(raw: string): OptionalInt {
  const text = raw.trim()
  if (text === '' || !/^-?\d+$/.test(text)) return ''
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : ''
}

export function parsePoolSettings(
  max: OptionalInt,
  timeout: OptionalInt,
  maxCap: number,
): { ok: true; max: number; timeout: number } | { ok: false; text: string } {
  const maxN = Number(max)
  const timeoutN = Number(timeout)
  if (!Number.isFinite(maxN) || maxN < 1 || maxN > maxCap) {
    return { ok: false, text: `最大连接数必须在 1–${maxCap}` }
  }
  if (!Number.isFinite(timeoutN) || timeoutN < 1 || timeoutN > 600) {
    return { ok: false, text: '获取超时必须在 1–600 秒' }
  }
  return { ok: true, max: maxN, timeout: timeoutN }
}
