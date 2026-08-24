/** Parse a URL segment into a positive integer, or null if missing / invalid. */
export function parsePositiveInt(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function workflowVersionsPath(
  projectId: number,
  workflowId: number,
  version?: number,
): string {
  const base = `/workspace/${projectId}/automation/workflows/${workflowId}/versions`
  return version != null ? `${base}/${version}` : base
}

export function workflowEditorPath(projectId: number, workflowId: number): string {
  return `/workspace/${projectId}/automation/workflows?workflowId=${workflowId}`
}
