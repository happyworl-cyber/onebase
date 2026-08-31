# Workflow Code Snippet Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace workflow node code/SQL/JSON textareas with a shared CodeMirror 6 editor that supports a compact pane plus a near-fullscreen overlay, without changing config shape or backend.

**Architecture:** A `CodeSnippetEditor` shell (toolbar, fallback textarea, exclusive overlay portaled to `document.body`) dynamically loads `CodeSnippetMirror`. `NodeConfigPanel` and `StatementsEditor` keep parse/validate/write semantics and only swap the input widget. Dark theme for code languages; light for SQL/JSON.

**Tech Stack:** Next.js 14, React 18, CodeMirror 6 via `@uiw/react-codemirror`, existing Tailwind panel.

**Spec:** `docs/superpowers/specs/2026-08-28-workflow-code-snippet-editor-design.md`

## Global Constraints

- Editor is CodeMirror 6 only; do not add Monaco, highlight.js, or Prism
- One shared component for compact pane and overlay; overlay is a dedicated layer, not `Modal.tsx`
- `onChange` writes through immediately; overlay has no 保存 / 应用
- Overlay close (button / mask / Esc) fires `onBlur` once
- Only the spec’s field table is in scope; do not replace email / Redis multiline / object-storage `content` / header npm·pip / single-line inputs
- Do not change panel width defaults (`280–900`, `workflow-node-panel-width`) or backend/config shape
- No autocomplete, diagnostics, format, Vim, or custom search UI (`Cmd/Ctrl+F` from CodeMirror is enough)
- `fieldset disabled={readOnly}` disables native `<button>`; overlay must `createPortal` to `document.body`, and 放大 must remain clickable in read-only (non-form-control control)
- Repo has no frontend unit-test runner; each task ends with a concrete manual check, not a new Vitest stack
- Do not commit unless the user asked; skip `git commit` steps if running in a session where commits were not requested, but still finish the code and verification

## File map

| Path | Responsibility |
|------|----------------|
| `frontend-nextjs/package.json` | CM6 dependencies |
| `frontend-nextjs/components/workflow/CodeSnippetMirror.tsx` | CodeMirror instance (dynamic import target) |
| `frontend-nextjs/components/workflow/CodeSnippetEditor.tsx` | Toolbar, fallback, exclusive overlay, portal, error boundary |
| `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` | Swap listed textareas; pass `readOnly` into child editors |

---

### Task 1: Dependencies + CodeMirror wrapper

**Files:**
- Modify: `frontend-nextjs/package.json` (via npm install)
- Create: `frontend-nextjs/components/workflow/CodeSnippetMirror.tsx`

**Interfaces:**
- Consumes: none
- Produces:
  - `export type SnippetLanguage = 'lua' | 'javascript' | 'python' | 'sql' | 'json'`
  - `export function isDarkSnippetLanguage(language: SnippetLanguage): boolean`
  - `export type CodeSnippetMirrorProps = { value: string; onChange?: (value: string) => void; language: SnippetLanguage; readOnly?: boolean; onBlur?: () => void; placeholder?: string; height: string }`
  - `export function CodeSnippetMirror(props: CodeSnippetMirrorProps): JSX.Element`

- [ ] **Step 1: Install packages from `frontend-nextjs`**

```bash
cd frontend-nextjs && npm install \
  @uiw/react-codemirror \
  @codemirror/lang-javascript \
  @codemirror/lang-python \
  @codemirror/lang-sql \
  @codemirror/lang-json \
  @codemirror/legacy-modes \
  @codemirror/theme-one-dark \
  @codemirror/language \
  @codemirror/view
```

Expected: install succeeds; `package.json` lists those packages. Do not add Monaco.

- [ ] **Step 2: Create `CodeSnippetMirror.tsx`**

Create `frontend-nextjs/components/workflow/CodeSnippetMirror.tsx`:

```tsx
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

export type SnippetLanguage = 'lua' | 'javascript' | 'python' | 'sql' | 'json'

export function isDarkSnippetLanguage(language: SnippetLanguage): boolean {
  return language === 'lua' || language === 'javascript' || language === 'python'
}

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
```

- [ ] **Step 3: Typecheck the new file**

```bash
cd frontend-nextjs && npx tsc --noEmit --pretty false 2>&1 | head -80
```

Expected: no errors in `CodeSnippetMirror.tsx`. Other pre-existing project errors (if any) can be ignored only if they are clearly unrelated.

- [ ] **Step 4: Manual check**

This task has no UI hook yet. Confirm `frontend-nextjs/node_modules/@uiw/react-codemirror/package.json` exists and `legacy-modes/mode/lua` resolves (`ls frontend-nextjs/node_modules/@codemirror/legacy-modes/mode/lua*`).

- [ ] **Step 5: Commit** (skip if the user did not ask)

```bash
git add frontend-nextjs/package.json frontend-nextjs/package-lock.json \
  frontend-nextjs/components/workflow/CodeSnippetMirror.tsx
git commit -m "$(cat <<'EOF'
Add CodeMirror wrapper for workflow snippet fields.

EOF
)"
```

---

### Task 2: `CodeSnippetEditor` shell + overlay

**Files:**
- Create: `frontend-nextjs/components/workflow/CodeSnippetEditor.tsx`

**Interfaces:**
- Consumes: `SnippetLanguage`, `isDarkSnippetLanguage`, `CodeSnippetMirror` from Task 1
- Produces:
  - `export type { SnippetLanguage }` (re-export)
  - `export type CodeSnippetEditorProps = { value: string; onChange?: (value: string) => void; language: SnippetLanguage; label: string; minRows?: number; readOnly?: boolean; onBlur?: () => void; invalid?: boolean; placeholder?: string }`
  - `export default function CodeSnippetEditor(props: CodeSnippetEditorProps): JSX.Element`

- [ ] **Step 1: Create `CodeSnippetEditor.tsx`**

Create `frontend-nextjs/components/workflow/CodeSnippetEditor.tsx` with the full contents below. Do not split the overlay unless the file is already written and clearly over ~200 lines; the spec allows keeping overlay in this file.

```tsx
'use client'

import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import dynamic from 'next/dynamic'
import {
  type SnippetLanguage,
  isDarkSnippetLanguage,
} from './CodeSnippetMirror'

export type { SnippetLanguage }

const LANG_LABEL: Record<SnippetLanguage, string> = {
  lua: 'Lua',
  javascript: 'JavaScript',
  python: 'Python',
  sql: 'SQL',
  json: 'JSON',
}

const DEFAULT_ROWS: Record<SnippetLanguage, number> = {
  lua: 12,
  javascript: 12,
  python: 12,
  sql: 5,
  json: 4,
}

const ROW_PX = 24

export type CodeSnippetEditorProps = {
  value: string
  onChange?: (value: string) => void
  language: SnippetLanguage
  label: string
  minRows?: number
  readOnly?: boolean
  onBlur?: () => void
  invalid?: boolean
  placeholder?: string
}

type MirrorProps = {
  value: string
  onChange?: (value: string) => void
  language: SnippetLanguage
  readOnly?: boolean
  onBlur?: () => void
  placeholder?: string
  height: string
}

const CodeSnippetMirror = dynamic<MirrorProps>(
  () => import('./CodeSnippetMirror').then((m) => m.CodeSnippetMirror),
  { ssr: false },
)

let releaseActiveOverlay: (() => void) | null = null

function acquireOverlay(release: () => void) {
  if (releaseActiveOverlay && releaseActiveOverlay !== release) {
    releaseActiveOverlay()
  }
  releaseActiveOverlay = release
}

function releaseOverlay(release: () => void) {
  if (releaseActiveOverlay === release) releaseActiveOverlay = null
}

class MirrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function fallbackClass(language: SnippetLanguage, invalid?: boolean) {
  const dark = isDarkSnippetLanguage(language)
  return [
    'w-full px-3 py-2 border rounded-lg font-mono text-sm leading-relaxed resize-none',
    dark ? 'bg-gray-900 text-green-400' : 'bg-white text-gray-800',
    invalid ? 'border-red-300 bg-red-50/30' : 'border-gray-200',
  ].join(' ')
}

function SnippetFallback({
  value,
  onChange,
  language,
  readOnly,
  onBlur,
  placeholder,
  rows,
  invalid,
}: {
  value: string
  onChange?: (value: string) => void
  language: SnippetLanguage
  readOnly?: boolean
  onBlur?: () => void
  placeholder?: string
  rows: number
  invalid?: boolean
}) {
  const locked = readOnly || !onChange
  return (
    <textarea
      value={value}
      onChange={(e) => {
        if (locked) return
        onChange?.(e.target.value)
      }}
      onBlur={onBlur}
      spellCheck={false}
      readOnly={locked}
      rows={rows}
      placeholder={placeholder}
      className={fallbackClass(language, invalid)}
    />
  )
}

function ExpandControl({
  onClick,
  label,
}: {
  onClick: () => void
  label: string
}) {
  // fieldset[disabled] 会禁用 <button>，只读时仍要能放大，所以不用 form control。
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="px-1.5 py-0.5 rounded text-[11px] text-gray-500 hover:bg-gray-100 hover:text-gray-800 cursor-pointer select-none"
      aria-label={`放大编辑${label}`}
    >
      放大
    </div>
  )
}

export default function CodeSnippetEditor({
  value,
  onChange,
  language,
  label,
  minRows,
  readOnly = false,
  onBlur,
  invalid,
  placeholder,
}: CodeSnippetEditorProps) {
  const reactId = useId()
  const [expanded, setExpanded] = useState(false)
  const [mounted, setMounted] = useState(false)
  const onBlurRef = useRef(onBlur)
  onBlurRef.current = onBlur

  const rows = minRows ?? DEFAULT_ROWS[language]
  const paneHeight = `${rows * ROW_PX}px`

  useEffect(() => {
    setMounted(true)
  }, [])

  const closeExpanded = useCallback(() => {
    setExpanded(false)
    onBlurRef.current?.()
    releaseOverlay(closeExpanded)
  }, [])

  const openExpanded = useCallback(() => {
    acquireOverlay(closeExpanded)
    setExpanded(true)
  }, [closeExpanded])

  useEffect(() => {
    if (!expanded) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeExpanded()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [expanded, closeExpanded])

  const fallback = (
    <SnippetFallback
      value={value}
      onChange={onChange}
      language={language}
      readOnly={readOnly}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={rows}
      invalid={invalid}
    />
  )

  const pane = (
    <MirrorBoundary fallback={fallback}>
      <div className="h-full min-h-0 overflow-hidden">
        <CodeSnippetMirror
          value={value}
          onChange={onChange}
          language={language}
          readOnly={readOnly}
          onBlur={expanded ? undefined : onBlur}
          placeholder={placeholder}
          height="100%"
        />
      </div>
    </MirrorBoundary>
  )

  const border = invalid ? 'border-red-300' : 'border-gray-200'
  const chrome = isDarkSnippetLanguage(language) ? 'bg-gray-900' : 'bg-white'

  const overlay =
    mounted && expanded
      ? createPortal(
          <div
            className="fixed z-[80] flex items-center justify-center"
            style={{ top: 0, left: 0, right: 'var(--ai-panel-offset, 0px)', bottom: 0 }}
          >
            <div className="absolute inset-0 bg-black/50" onClick={closeExpanded} />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${reactId}-title`}
              className="relative flex flex-col bg-white rounded-xl shadow-2xl overflow-hidden"
              style={{ width: '92%', height: '88%' }}
            >
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
                <h3 id={`${reactId}-title`} className="text-sm font-semibold text-gray-900">
                  {label}
                </h3>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={closeExpanded}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      closeExpanded()
                    }
                  }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 cursor-pointer"
                  aria-label="关闭"
                >
                  ×
                </div>
              </div>
              <div className={`flex-1 min-h-0 ${chrome}`}>
                <MirrorBoundary
                  fallback={
                    <SnippetFallback
                      value={value}
                      onChange={onChange}
                      language={language}
                      readOnly={readOnly}
                      onBlur={undefined}
                      placeholder={placeholder}
                      rows={24}
                      invalid={invalid}
                    />
                  }
                >
                  <CodeSnippetMirror
                    value={value}
                    onChange={onChange}
                    language={language}
                    readOnly={readOnly}
                    placeholder={placeholder}
                    height="100%"
                  />
                </MirrorBoundary>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <div className={`border rounded-lg overflow-hidden ${border} ${chrome}`}>
      <div className="flex items-center justify-between px-2 py-1 border-b border-gray-200/80 bg-gray-50">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          {LANG_LABEL[language]}
        </span>
        <ExpandControl onClick={openExpanded} label={label} />
      </div>
      <div style={{ height: paneHeight }} className="min-h-0">
        {pane}
      </div>
      {overlay}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
cd frontend-nextjs && npx tsc --noEmit --pretty false 2>&1 | rg "CodeSnippet" || true
```

Expected: no errors mentioning `CodeSnippetEditor` or `CodeSnippetMirror`.

- [ ] **Step 3: Manual check**

Not wired yet. Confirm the file exports `default function CodeSnippetEditor` and `SnippetLanguage`.

- [ ] **Step 4: Commit** (skip if the user did not ask)

```bash
git add frontend-nextjs/components/workflow/CodeSnippetEditor.tsx
git commit -m "$(cat <<'EOF'
Add expandable CodeMirror snippet editor shell.

EOF
)"
```

---

### Task 3: Wire the `code` node

**Files:**
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`

**Interfaces:**
- Consumes: `CodeSnippetEditor` default export and `SnippetLanguage` from Task 2
- Produces: code node field uses the editor; `switchCodeLanguage` unchanged

- [ ] **Step 1: Add import**

At the top of `frontend-nextjs/components/workflow/NodeConfigPanel.tsx`, after the existing `./NodeTypes` import:

```tsx
import CodeSnippetEditor from './CodeSnippetEditor'
```

- [ ] **Step 2: Replace the code textarea**

Replace the block that starts with `<label ...>代码</label>` and the `<textarea ... rows={12} .../>` (around the current code-node section) with:

```tsx
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">代码</label>
                <CodeSnippetEditor
                  value={node.config.code || ''}
                  onChange={readOnly ? undefined : (next) => updateConfig('code', next)}
                  language={lang}
                  label="代码"
                  minRows={12}
                  readOnly={readOnly}
                  placeholder={
                    lang === 'javascript'
                      ? 'async function execute(ctx) {\n  // ctx.body: trigger payload\n  // ctx.nodes.nodeId: upstream output\n  ctx.body = { ok: true };\n}'
                      : lang === 'python'
                      ? 'def execute(ctx):\n    # ctx.body: 触发 payload\n    # ctx.nodes["nodeId"]: 上游输出\n    return { "ok": True }'
                      : 'function execute(ctx)\n  -- ctx.body: 触发 payload\n  -- ctx.nodes.xxx: 上游输出\n  ctx.body = { ok = true }\nend'
                  }
                />
                <p className="text-xs text-gray-400 mt-1">
                  可用变量: ctx.body（触发 payload）、ctx.nodes.nodeId（上游输出）
                </p>
              </div>
```

Do not change `switchCodeLanguage` or the language `<select>`.

- [ ] **Step 3: Typecheck the panel**

```bash
cd frontend-nextjs && npx tsc --noEmit --pretty false 2>&1 | rg "NodeConfigPanel|CodeSnippet" || true
```

Expected: no new errors in those files.

- [ ] **Step 4: Manual check in the browser**

1. Open a workflow, select a 代码 node.
2. Compact pane shows line numbers and highlighting (Lua/JS/Python via the language select).
3. Type in the pane; text persists after clicking the canvas and re-selecting the node (or after blur).
4. Click 放大; editor fills ~92%×88%; edits there appear in the pane after close (button, mask, Esc).
5. Switch language: empty or default template swaps; custom code is kept.
6. Open a workflow version browse page (`readOnly`): can 放大, cannot type.

- [ ] **Step 5: Commit** (skip if the user did not ask)

```bash
git add frontend-nextjs/components/workflow/NodeConfigPanel.tsx
git commit -m "$(cat <<'EOF'
Use snippet editor for workflow code nodes.

EOF
)"
```

---

### Task 4: Wire SQL fields

**Files:**
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` (`db_query` / `db_execute` SQL, `StatementsEditor`)

**Interfaces:**
- Consumes: `CodeSnippetEditor` from Task 2
- Produces: SQL query/execute and each transaction/foreach statement SQL use the editor; params textareas stay

- [ ] **Step 1: Replace `db_query` SQL textarea**

Keep the 参数 `<input>`. Replace only the SQL textarea:

```tsx
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">SQL 查询</label>
              <CodeSnippetEditor
                value={node.config.sql || ''}
                onChange={readOnly ? undefined : (next) => updateConfig('sql', next)}
                language="sql"
                label="SQL 查询"
                minRows={5}
                readOnly={readOnly}
                placeholder="SELECT * FROM users WHERE id = $1"
              />
            </div>
```

- [ ] **Step 2: Replace `db_execute` SQL textarea**

```tsx
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">SQL 语句</label>
              <CodeSnippetEditor
                value={node.config.sql || ''}
                onChange={readOnly ? undefined : (next) => updateConfig('sql', next)}
                language="sql"
                label="SQL 语句"
                minRows={5}
                readOnly={readOnly}
                placeholder="INSERT INTO logs(msg) VALUES($1)"
              />
            </div>
```

- [ ] **Step 3: Pass `readOnly` into `StatementsEditor` and replace statement SQL**

Change both call sites:

```tsx
            <StatementsEditor node={node} updateConfig={updateConfig} readOnly={readOnly} />
```

Change the function signature and the SQL textarea only (keep params textarea):

```tsx
function StatementsEditor({
  node,
  updateConfig,
  readOnly = false,
}: {
  node: WorkflowNodeData
  updateConfig: (key: string, value: any) => void
  readOnly?: boolean
}) {
```

Inside the map, replace the SQL `<textarea>` with:

```tsx
          <CodeSnippetEditor
            value={d.sql}
            onChange={readOnly ? undefined : (next) => updateDraft(idx, 'sql', next)}
            language="sql"
            label={`SQL 语句 ${idx + 1}`}
            minRows={4}
            readOnly={readOnly}
            placeholder="UPDATE t SET x=$1 WHERE id=($2)::int"
          />
```

Do not replace the 参数 textarea (`paramsText`).

- [ ] **Step 4: Manual check**

1. `db_query` / `db_execute`: light theme, SQL highlighting, 放大 works, params input unchanged.
2. `db_transaction` or `foreach` with two statements: edit statement 1 in overlay; statement 2 unchanged.
3. Opening 放大 on statement 2 while statement 1 overlay is open closes statement 1’s overlay.
4. Params rows still plain textareas.

- [ ] **Step 5: Commit** (skip if the user did not ask)

```bash
git add frontend-nextjs/components/workflow/NodeConfigPanel.tsx
git commit -m "$(cat <<'EOF'
Use snippet editor for workflow SQL fields.

EOF
)"
```

---

### Task 5: Wire JSON snippet fields

**Files:**
- Modify: `frontend-nextjs/components/workflow/NodeConfigPanel.tsx` (`http_call`, `transform`, `response`, `sse_publish`, `call_workflow`, `KafkaNodeConfig`, `ObjectStorageNodeConfig`)

**Interfaces:**
- Consumes: `CodeSnippetEditor`; existing `validateJsonField` / stringify / parse
- Produces: listed JSON textareas replaced; parse-on-change and blur validation stay in the parent

Add a local display helper near `isWholeTemplateExpr` only if a field’s value expression is copied twice; otherwise keep the existing inline stringify. Do not move `validateJsonField`.

- [ ] **Step 1: `http_call` headers + body**

Replace the two textareas. Keep `onBlur` validation:

```tsx
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Headers (JSON)</label>
              <CodeSnippetEditor
                value={node.config.headers ? (typeof node.config.headers === 'string' ? node.config.headers : JSON.stringify(node.config.headers, null, 2)) : ''}
                onChange={readOnly ? undefined : (next) => updateConfig('headers', next)}
                onBlur={() =>
                  validateJsonField(
                    'headers',
                    node.config.headers
                      ? typeof node.config.headers === 'string'
                        ? node.config.headers
                        : JSON.stringify(node.config.headers, null, 2)
                      : '',
                  )
                }
                language="json"
                label="Headers"
                minRows={3}
                readOnly={readOnly}
                invalid={!!jsonFieldErrors.headers}
                placeholder='{"Authorization": "Bearer xxx"}'
              />
              {jsonFieldErrors.headers && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.headers}</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Body (JSON)</label>
              <CodeSnippetEditor
                value={node.config.body ? (typeof node.config.body === 'string' ? node.config.body : JSON.stringify(node.config.body, null, 2)) : ''}
                onChange={readOnly ? undefined : (next) => updateConfig('body', next)}
                onBlur={() =>
                  validateJsonField(
                    'body',
                    node.config.body
                      ? typeof node.config.body === 'string'
                        ? node.config.body
                        : JSON.stringify(node.config.body, null, 2)
                      : '',
                  )
                }
                language="json"
                label="Body"
                minRows={3}
                readOnly={readOnly}
                invalid={!!jsonFieldErrors.body}
                placeholder='{"key": "{{trigger.value}}"}'
              />
              {jsonFieldErrors.body && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.body}</p>
              )}
            </div>
```

Because overlay close already calls `onBlur`, closing the large editor must show the same red error as leaving the compact pane.

- [ ] **Step 2: `transform` output**

Keep the existing value IIFE and `JSON.parse` in `onChange`. Replace only the widget:

```tsx
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">转换映射 (JSON)</label>
            <CodeSnippetEditor
              value={(() => {
                const rawOut = node.config.output
                const outMeaningful =
                  rawOut != null && !(typeof rawOut === 'string' && rawOut.trim() === '')
                const out = outMeaningful ? rawOut : node.config.mapping
                if (out == null || out === '') return ''
                return typeof out === 'string' ? out : JSON.stringify(out, null, 2)
              })()}
              onChange={readOnly ? undefined : (raw) => {
                let parsed: unknown = raw
                try { parsed = raw.trim() ? JSON.parse(raw) : '' } catch { parsed = raw }
                updateConfig('output', parsed)
              }}
              onBlur={() => {
                const rawOut = node.config.output
                const outMeaningful =
                  rawOut != null && !(typeof rawOut === 'string' && rawOut.trim() === '')
                const out = outMeaningful ? rawOut : node.config.mapping
                const text =
                  out == null || out === ''
                    ? ''
                    : typeof out === 'string'
                      ? out
                      : JSON.stringify(out, null, 2)
                validateJsonField('output', text)
              }}
              language="json"
              label="转换映射"
              minRows={6}
              readOnly={readOnly}
              invalid={!!jsonFieldErrors.output}
              placeholder={'{\n  "user_name": "{{query.rows.0.name}}",\n  "total": "{{query.rows.length}}"\n}'}
            />
            {jsonFieldErrors.output && (
              <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.output}</p>
            )}
            <p className="text-xs text-gray-400 mt-1">键值对映射，值支持模板变量</p>
          </div>
```

- [ ] **Step 3: `response` body + headers**

```tsx
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">响应 Body (JSON 模板)</label>
              <CodeSnippetEditor
                value={node.config.body ? (typeof node.config.body === 'string' ? node.config.body : JSON.stringify(node.config.body, null, 2)) : ''}
                onChange={readOnly ? undefined : (next) => updateConfig('body', next)}
                onBlur={() =>
                  validateJsonField(
                    'body',
                    node.config.body
                      ? typeof node.config.body === 'string'
                        ? node.config.body
                        : JSON.stringify(node.config.body, null, 2)
                      : '',
                  )
                }
                language="json"
                label="响应 Body"
                minRows={5}
                readOnly={readOnly}
                invalid={!!jsonFieldErrors.body}
                placeholder={'{\n  "success": true,\n  "data": "{{transform.result}}"\n}'}
              />
              {jsonFieldErrors.body && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.body}</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">响应 Headers (JSON)</label>
              <CodeSnippetEditor
                value={node.config.headers ? (typeof node.config.headers === 'string' ? node.config.headers : JSON.stringify(node.config.headers, null, 2)) : ''}
                onChange={readOnly ? undefined : (next) => updateConfig('headers', next)}
                onBlur={() =>
                  validateJsonField(
                    'headers',
                    node.config.headers
                      ? typeof node.config.headers === 'string'
                        ? node.config.headers
                        : JSON.stringify(node.config.headers, null, 2)
                      : '',
                  )
                }
                language="json"
                label="响应 Headers"
                minRows={2}
                readOnly={readOnly}
                invalid={!!jsonFieldErrors.headers}
                placeholder='{"X-Custom": "value"}'
              />
              {jsonFieldErrors.headers && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.headers}</p>
              )}
            </div>
```

- [ ] **Step 4: `sse_publish` data**

```tsx
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">推送数据 (JSON)</label>
              <CodeSnippetEditor
                value={
                  typeof node.config.data === 'string'
                    ? node.config.data
                    : node.config.data != null
                      ? JSON.stringify(node.config.data, null, 2)
                      : ''
                }
                onChange={readOnly ? undefined : (next) => updateConfig('data', next)}
                onBlur={() =>
                  validateJsonField(
                    'data',
                    typeof node.config.data === 'string'
                      ? node.config.data
                      : node.config.data != null
                        ? JSON.stringify(node.config.data, null, 2)
                        : '',
                  )
                }
                language="json"
                label="推送数据"
                minRows={5}
                readOnly={readOnly}
                invalid={!!jsonFieldErrors.data}
                placeholder={'留空则推送本次触发数据，或填:\n{\n  "pct": 50,\n  "msg": "处理中"\n}'}
              />
              {jsonFieldErrors.data && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.data}</p>
              )}
              <p className="text-xs text-gray-400 mt-1">留空 = 推送触发数据；填 JSON 则推送该内容</p>
            </div>
```

- [ ] **Step 5: `call_workflow` input**

```tsx
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">入参 input (JSON)</label>
              <CodeSnippetEditor
                value={node.config.input ? (typeof node.config.input === 'string' ? node.config.input : JSON.stringify(node.config.input, null, 2)) : ''}
                onChange={readOnly ? undefined : (next) => updateConfig('input', next)}
                onBlur={() =>
                  validateJsonField(
                    'input',
                    node.config.input
                      ? typeof node.config.input === 'string'
                        ? node.config.input
                        : JSON.stringify(node.config.input, null, 2)
                      : '',
                  )
                }
                language="json"
                label="入参 input"
                minRows={6}
                readOnly={readOnly}
                invalid={!!jsonFieldErrors.input}
                placeholder={'{\n  "way_uid": "{{trigger.uid}}",\n  "lang": "{{trigger.lang}}"\n}'}
              />
              {jsonFieldErrors.input && (
                <p className="text-xs text-red-600 mt-1">{jsonFieldErrors.input}</p>
              )}
            </div>
```

- [ ] **Step 6: Kafka value + headers**

Change

```tsx
function KafkaNodeConfig({
  node,
  updateConfig,
}: {
  node: WorkflowNodeData
  updateConfig: (key: string, value: any) => void
}) {
```

to also take `readOnly?: boolean`, and pass `readOnly={readOnly}` at the call site (`<KafkaNodeConfig node={node} updateConfig={updateConfig} readOnly={readOnly} />`).

Replace Value textarea:

```tsx
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Value *</label>
        <CodeSnippetEditor
          value={node.config.value || ''}
          onChange={readOnly ? undefined : (next) => updateConfig('value', next)}
          language="json"
          label="Value"
          minRows={4}
          readOnly={readOnly}
          placeholder={'{"id":"{{trigger.user_id}}"}'}
        />
      </div>
```

Replace Headers textarea; keep the existing try/`JSON.parse` `onChange`:

```tsx
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Headers（可选 JSON 对象）</label>
        <CodeSnippetEditor
          value={
            typeof node.config.headers === 'string'
              ? node.config.headers
              : node.config.headers
                ? JSON.stringify(node.config.headers, null, 2)
                : ''
          }
          onChange={readOnly ? undefined : (raw) => {
            try {
              const parsed = raw.trim() ? JSON.parse(raw) : undefined
              updateConfig('headers', parsed)
            } catch {
              updateConfig('headers', raw)
            }
          }}
          language="json"
          label="Headers"
          minRows={3}
          readOnly={readOnly}
          placeholder={'{\n  "x-trace-id": "{{trigger.trace_id}}"\n}'}
        />
      </div>
```

- [ ] **Step 7: Object storage `keys` only**

Pass `readOnly` into `ObjectStorageNodeConfig` the same way as Kafka. Replace only the `keys` textarea (not `content`):

```tsx
          <CodeSnippetEditor
            value={
              typeof node.config.keys === 'string'
                ? node.config.keys
                : node.config.keys
                  ? JSON.stringify(node.config.keys, null, 2)
                  : ''
            }
            onChange={readOnly ? undefined : (raw) => {
              try {
                const parsed = raw.trim() ? JSON.parse(raw) : undefined
                updateConfig('keys', parsed)
              } catch {
                updateConfig('keys', raw)
              }
            }}
            language="json"
            label="keys"
            minRows={2}
            readOnly={readOnly}
            placeholder={'["a.txt", "b.txt"]'}
          />
```

Leave `content` as `<textarea>`.

- [ ] **Step 8: Confirm excluded fields still textareas**

Grep:

```bash
rg -n "textarea" frontend-nextjs/components/workflow/NodeConfigPanel.tsx
```

Expected remaining textareas: email `to` / `text_body` / `html_body`, StatementsEditor params, Redis multiline fields, object-storage `content`. No leftover SQL/code/JSON fields from the spec table.

- [ ] **Step 9: Manual check**

1. `http_call` / `transform` / `response`: type `{` then blur or close overlay → error text; type `{{clean_body}}` as the whole value → no error; type valid JSON → save workflow, reload, field still an object (not a quoted string) in the saved definition.
2. `sse_publish` data and `call_workflow` input: 放大 + highlight.
3. Kafka Value/Headers and object-storage `keys` (delete op): editor; `content` (put op) still textarea.
4. Email node bodies still textareas.

- [ ] **Step 10: Commit** (skip if the user did not ask)

```bash
git add frontend-nextjs/components/workflow/NodeConfigPanel.tsx
git commit -m "$(cat <<'EOF'
Use snippet editor for workflow JSON fields.

EOF
)"
```

---

### Task 6: End-to-end acceptance

**Files:** none new

**Interfaces:**
- Consumes: Tasks 1–5
- Produces: spec §7 checklist signed off in the PR/session notes

- [ ] **Step 1: Run the spec checklist**

1. Code node: highlight + line numbers; overlay edit matches pane after close; language switch keeps custom code / swaps templates.
2. SQL / multi-statement: independent overlays; exclusive overlay (only one open).
3. JSON: invalid on blur; whole `{{template}}` allowed; valid JSON stored as object after save+reload.
4. Version browse: view + overlay, no edits.
5. Save and run a workflow that has code + SQL + transform: execution matches pre-change behavior; config keys unchanged.
6. Overlay respects `--ai-panel-offset` (AI panel open: dialog stays in the visible area).
7. Optional: temporarily break `import('./CodeSnippetMirror')` to confirm textarea fallback still edits and saves. Revert before finishing.

- [ ] **Step 2: `tsc` once more**

```bash
cd frontend-nextjs && npx tsc --noEmit --pretty false 2>&1 | rg "CodeSnippet|NodeConfigPanel" || true
```

Expected: clean for those files.

- [ ] **Step 3: Commit** (skip if the user did not ask)

No extra files unless you fixed bugs during QA; commit those fixes with a message that says what broke.

---

## Self-review

| Spec item | Task |
|-----------|------|
| Shared CM6 component + overlay | 1–2 |
| Compact pane + 放大 | 2–3 |
| Live write-back, no overlay save | 2 |
| Exclusive overlay + portal + Esc/mask | 2 |
| Code / SQL / JSON field table | 3–5 |
| Exclusions (email, Redis, content, npm/pip, width) | 5 step 8 + constraints |
| JSON validate + template exception stay in parent | 5 |
| `readOnly` can expand | 2 ExpandControl + portal |
| Import failure fallback | 2 MirrorBoundary + SnippetFallback |
| Dark vs light theme | 1 `isDarkSnippetLanguage` |
| No Monaco / no new test stack | constraints + Task 6 manual |
