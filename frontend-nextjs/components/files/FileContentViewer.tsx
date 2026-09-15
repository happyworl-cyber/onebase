'use client'

import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { EditorView } from '@codemirror/view'
import type { FilePreviewLanguage } from '@/lib/objectStorageFiles'

export function FileContentViewer({
  value,
  language,
}: {
  value: string
  language: FilePreviewLanguage
}) {
  if (language === 'text') {
    return (
      <pre className="h-full overflow-auto p-3 text-xs font-mono text-gray-800 whitespace-pre-wrap break-all bg-gray-50">
        {value}
      </pre>
    )
  }

  const langExt = language === 'xml' ? xml() : json()
  return (
    <CodeMirror
      value={value}
      height="100%"
      editable={false}
      readOnly
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        bracketMatching: true,
        highlightActiveLine: false,
        autocompletion: false,
      }}
      extensions={[
        langExt,
        EditorView.lineWrapping,
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto' },
        }),
      ]}
      className="text-sm h-full"
    />
  )
}
