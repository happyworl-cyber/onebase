export function shouldSubmitOnKeyDown(e: {
  key: string
  nativeEvent?: { isComposing?: boolean }
  isComposing?: boolean
}): boolean {
  if (e.key !== 'Enter') return false
  if (e.isComposing || e.nativeEvent?.isComposing) return false
  return true
}
