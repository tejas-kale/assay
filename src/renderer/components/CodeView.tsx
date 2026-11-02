// Read-only code with highlighting, in CodeMirror 6 (the editor the Code tab grows into for edits).
// SQL is shown formatted; the file on disk keeps Claude's exact text, and `o` shows that instead.
import { defaultKeymap } from '@codemirror/commands'
import { sql, StandardSQL } from '@codemirror/lang-sql'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { Command } from '@codemirror/view'
import {
  cursorDocEnd,
  cursorDocStart,
  cursorCharLeft,
  cursorCharRight,
  cursorGroupForward,
  cursorGroupBackward,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineDown,
  cursorLineUp,
  cursorPageDown,
  cursorPageUp,
} from '@codemirror/commands'
import { tags } from '@lezer/highlight'
import { useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'sql-formatter'

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: [tags.lineComment, tags.blockComment, tags.comment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.standard(tags.name)], color: 'var(--syn-function)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--syn-operator)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'transparent', fontSize: '12px' },
  '.cm-scroller': { fontFamily: 'Menlo, "SF Mono", Monaco, monospace', lineHeight: '1.5' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--sel)' },
  '.cm-activeLine': { backgroundColor: 'var(--sel)' },
})

/** Vim-style reading keys. Unclaimed keys bubble to the tab (for `d`, `o`). */
const readingKeys: { key: string; run: Command }[] = [
  { key: 'j', run: cursorLineDown },
  { key: 'k', run: cursorLineUp },
  { key: 'h', run: cursorCharLeft },
  { key: 'l', run: cursorCharRight },
  { key: 'w', run: cursorGroupForward },
  { key: 'b', run: cursorGroupBackward },
  { key: '0', run: cursorLineBoundaryBackward },
  { key: '$', run: cursorLineBoundaryForward },
  { key: 'g', run: cursorDocStart },
  { key: 'G', run: cursorDocEnd },
  { key: 'Shift-j', run: cursorPageDown },
  { key: 'Shift-k', run: cursorPageUp },
]

/** Databricks SQL, formatted the way people write it; the original text when it does not parse. */
export function formatSql(text: string): string {
  try {
    return `${format(text, { language: 'spark', keywordCase: 'preserve', tabWidth: 2, linesBetweenQueries: 1 })}\n`
  } catch {
    return text
  }
}

export function CodeView({ code, language, focusKey }: { code: string; language: 'sql' | 'python' | undefined; focusKey: string }) {
  const host = useRef<HTMLDivElement>(null)
  const hadFocus = useRef(false)
  const [original, setOriginal] = useState(false)
  const shown = useMemo(() => (language === 'sql' && !original ? formatSql(code) : code), [code, language, original])

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: shown,
        extensions: [
          EditorState.readOnly.of(true),
          keymap.of([...readingKeys, ...defaultKeymap]),
          language === 'sql' ? sql({ dialect: StandardSQL, upperCaseKeywords: true }) : [],
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
        ],
      }),
    })
    view.contentDOM.setAttribute('data-focus-target', '')
    // A rebuild (o, a new run) keeps focus where it was.
    if (hadFocus.current || host.current.closest('[data-pane]')?.contains(document.activeElement)) view.focus()
    hadFocus.current = false
    return () => {
      hadFocus.current = view.hasFocus
      view.destroy()
    }
  }, [shown, language, focusKey])

  return (
    <div
      className="run-body code-view"
      ref={host}
      onKeyDown={e => {
        if (e.key === 'o' && !e.metaKey && !e.ctrlKey && !e.altKey && language === 'sql') {
          e.preventDefault()
          setOriginal(v => !v)
        }
      }}
      title={language === 'sql' ? (original ? 'Original text (o: formatted)' : 'Formatted (o: original text)') : undefined}
    />
  )
}
