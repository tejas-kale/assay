// Code with highlighting, in CodeMirror 6: read-only for reading, with Vim mode for edits.
// SQL is shown formatted; the file on disk keeps Claude's exact text, and `o` shows that instead.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
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
import { getCM, vim } from '@replit/codemirror-vim'
import type { Ref } from 'react'
import { useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { format } from 'sql-formatter'

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: [tags.lineComment, tags.blockComment, tags.comment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.standard(tags.name)], color: 'var(--syn-function)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--syn-operator)' },
  { tag: [tags.heading, tags.strong], color: 'var(--syn-function)', fontWeight: 'bold' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.link, tags.url, tags.monospace], color: 'var(--syn-string)' },
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

type CodeViewProps = {
  code: string
  language: CodeLanguage | undefined
  focusKey: string
  /** Show the exact file text instead of the formatted SQL. */
  original: boolean
  onToggleOriginal: () => void
  /** Not a focus target: the host tab keeps the keys (the Trust tab scrolls). */
  passive?: boolean
  /** Take the focus when built (a pop-up). */
  autoFocus?: boolean
  /** Select the first case-insensitive match of this text and scroll it into the middle (a search hit). */
  find?: string | undefined
}

export type CodeLanguage = 'sql' | 'python' | 'markdown'

/** The highlighting a file gets, by its extension. */
export function languageOfPath(path: string): CodeLanguage | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'sql' ? 'sql' : ext === 'py' ? 'python' : ext === 'md' ? 'markdown' : undefined
}

export function CodeView({ code, language, focusKey, original, onToggleOriginal, passive, autoFocus, find }: CodeViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const hadFocus = useRef(false)
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
          language === 'sql' ? sql({ dialect: StandardSQL, upperCaseKeywords: true }) : language === 'python' ? python() : language === 'markdown' ? markdown() : [],
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
        ],
      }),
    })
    const at = find ? shown.toLowerCase().indexOf(find.toLowerCase()) : -1
    if (find && at >= 0) {
      view.dispatch({ selection: { anchor: at, head: at + find.length }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
    }
    if (autoFocus) view.focus()
    if (!passive) view.contentDOM.setAttribute('data-focus-target', '')
    // A rebuild (o, a new run) keeps focus where it was.
    if (!passive && (hadFocus.current || host.current.closest('[data-pane]')?.contains(document.activeElement))) view.focus()
    hadFocus.current = false
    return () => {
      hadFocus.current = view.hasFocus
      view.destroy()
    }
  }, [shown, language, focusKey, passive, find, autoFocus])

  return (
    <div
      className="run-body code-view"
      ref={host}
      onKeyDown={e => {
        if (e.key === 'o' && !e.metaKey && !e.ctrlKey && !e.altKey && language === 'sql') {
          e.preventDefault()
          onToggleOriginal()
        }
      }}
      title={language === 'sql' ? (original ? 'Original text (o: formatted)' : 'Formatted (o: original text)') : undefined}
    />
  )
}

export type EditorHandle = {
  text(): string
  /** True in Vim normal mode with no key half-typed, no search or `:` prompt open. */
  atRest(): boolean
}

/** The editable Code view: Vim mode, starting in normal mode. Rebuilt only when `initial` or the run changes. */
export function CodeEditor(props: {
  initial: string
  language: 'sql' | 'python' | 'markdown'
  onChange: (text: string) => void
  handleRef: Ref<EditorHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView>(undefined)
  const onChange = useRef(props.onChange)
  onChange.current = props.onChange

  useImperativeHandle(props.handleRef, () => ({
    text: () => viewRef.current?.state.doc.toString() ?? props.initial,
    atRest: () => {
      const view = viewRef.current
      const state = view ? getCM(view)?.state.vim : undefined
      if (!view || !state || state.insertMode || state.visualMode) return false
      return state.inputState.keyBuffer.length === 0 && view.hasFocus
    },
  }))

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.initial,
        extensions: [
          // Vim first, so its keys win over the default keymap.
          vim(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          props.language === 'python' ? python() : props.language === 'markdown' ? markdown() : sql({ dialect: StandardSQL, upperCaseKeywords: true }),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChange.current(update.state.doc.toString())
          }),
          theme,
        ],
      }),
    })
    viewRef.current = view
    view.contentDOM.setAttribute('data-focus-target', '')
    view.focus()
    return () => {
      viewRef.current = undefined
      view.destroy()
    }
    // Only the starting text: later keystrokes must not rebuild the editor.
  }, [props.initial, props.language])

  return <div className="run-body code-view editing" ref={host} />
}
