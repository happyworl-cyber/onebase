'use client'

import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { json } from '@codemirror/lang-json'
import { StreamLanguage } from '@codemirror/language'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import { type SnippetLanguage, isDarkSnippetLanguage } from './codeSnippetLang'

export type { SnippetLanguage }
export { isDarkSnippetLanguage }

function languageExtension(language: SnippetLanguage) {
  if (language === 'javascript') return javascript()
  if (language === 'python') return python()
  if (language === 'sql') return sql()
  if (language === 'json') return json()
  return StreamLanguage.define(lua)
}

export type CodeSnippetMirrorProps = {
  value: string
  onChange?: (value: string) => void
  language: SnippetLanguage
  readOnly?: boolean
  onBlur?: () => void
  placeholder?: string
  height: string
}

export function CodeSnippetMirror({
  value,
  onChange,
  language,
  readOnly = false,
  onBlur,
  placeholder,
  height,
}: CodeSnippetMirrorProps) {
  const locked = readOnly || !onChange
  return (
    <CodeMirror
      value={value}
      height={height}
      theme={isDarkSnippetLanguage(language) ? oneDark : undefined}
      placeholder={placeholder}
      editable={!locked}
      readOnly={locked}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        bracketMatching: true,
        highlightActiveLine: !locked,
        autocompletion: false,
      }}
      extensions={[
        languageExtension(language),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto' },
        }),
        EditorView.domEventHandlers({
          blur: () => {
            onBlur?.()
            return false
          },
        }),
      ]}
      onChange={(next) => {
        if (locked) return
        onChange?.(next)
      }}
      className="text-sm"
    />
  )
}
