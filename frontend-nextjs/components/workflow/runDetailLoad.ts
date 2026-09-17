/** 展开且尚未缓存时返回应请求的 run id，否则 null。 */
export function runDetailFetchId(
  runId: number,
  open: boolean,
  loadedIds: ReadonlySet<number>,
): number | null {
  if (!open) return null
  if (loadedIds.has(runId)) return null
  return runId
}
