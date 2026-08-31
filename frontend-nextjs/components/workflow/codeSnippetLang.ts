export type SnippetLanguage = 'lua' | 'javascript' | 'python' | 'sql' | 'json'

export function isDarkSnippetLanguage(language: SnippetLanguage): boolean {
  return language === 'lua' || language === 'javascript' || language === 'python'
}

export const SNIPPET_LANG_LABEL: Record<SnippetLanguage, string> = {
  lua: 'Lua',
  javascript: 'JavaScript',
  python: 'Python',
  sql: 'SQL',
  json: 'JSON',
}

export const SNIPPET_DEFAULT_ROWS: Record<SnippetLanguage, number> = {
  lua: 12,
  javascript: 12,
  python: 12,
  sql: 5,
  json: 4,
}
