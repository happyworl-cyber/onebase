export type FilePreviewLanguage = 'xml' | 'json' | 'text'

const XML_EXTS = new Set(['.xml', '.xsd', '.xsl', '.xslt', '.svg'])

export function previewLanguageFromKey(key: string): FilePreviewLanguage {
  const name = key.split('/').pop()?.toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  if (XML_EXTS.has(ext)) return 'xml'
  if (ext === '.json') return 'json'
  return 'text'
}

export function fileDisplayName(key: string, prefix: string): string {
  if (prefix && key.startsWith(prefix)) {
    const rest = key.slice(prefix.length)
    return rest || key
  }
  const slash = key.lastIndexOf('/')
  return slash >= 0 ? key.slice(slash + 1) : key
}

export function parentPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '')
  if (!trimmed) return ''
  const slash = trimmed.lastIndexOf('/')
  return slash < 0 ? '' : trimmed.slice(0, slash + 1)
}

export function breadcrumbParts(prefix: string): { label: string; prefix: string }[] {
  const trimmed = prefix.replace(/\/+$/, '')
  if (!trimmed) return []
  const segs = trimmed.split('/').filter(Boolean)
  const out: { label: string; prefix: string }[] = []
  let acc = ''
  for (const seg of segs) {
    acc += `${seg}/`
    out.push({ label: seg, prefix: acc })
  }
  return out
}

export function isGetTooLargeError(message: string): boolean {
  return message.includes('超过') && message.includes('presign')
}

export function lastConnectionStorageKey(projectId: string | number): string {
  return `planeos.files.connection.${projectId}`
}

export function folderDisplayName(commonPrefix: string, currentPrefix: string): string {
  const rest = currentPrefix && commonPrefix.startsWith(currentPrefix)
    ? commonPrefix.slice(currentPrefix.length)
    : commonPrefix
  return rest.replace(/\/+$/, '') || commonPrefix.replace(/\/+$/, '')
}
