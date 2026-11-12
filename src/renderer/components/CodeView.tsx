// Code with highlighting, in CodeMirror 6: read-only for reading, with Vim mode for edits.
// SQL is shown formatted; the file on disk keeps Claude's exact text, and `o` shows that instead.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { getCM, vim } from '@replit/codemirror-vim'
import type { Ref, RefObject } from 'react'
import { useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef } from 'react'
import { format } from 'sql-formatter'

import { firstMatch, languageOfPath, sqlToggleTitle } from '../../core/codeLanguage.ts'
import type { CodeLanguage } from '../../core/codeLanguage.ts'
import { highlight, languageExtension, readingKeys, theme } from './codemirror/editorSetup.ts'

export { languageOfPath }
export type { CodeLanguage }

/** Databricks SQL, formatted the way people write it; the original text when it does not parse. */
export function formatSql(text: string): string {
  try {
    return `${format(text, { language: 'spark', keywordCase: 'preserve', tabWidth: 2, linesBetweenQueries: 1 })}\n`
  } catch {
    return text
  }
}

type CodeViewProps = Readonly<{
  code: string
  language: CodeLanguage | undefined
  focusKey: string
  /** Show the exact file text instead of the formatted SQL. */
  original: boolean
  onToggleOriginal: () => void
  /** Not a focus target: the host tab keeps the keys (the Trust tab scrolls). */
  passive?: boolean
  /** Not even a click focuses it (the Trust tab, whose keys must keep working). */
  unfocusable?: boolean
  /** Take the focus when built (a pop-up). */
  autoFocus?: boolean
  /** Select the first case-insensitive match of this text and scroll it into the middle (a search hit). */
  find?: string
  /** Reads the selected text, for Cmd+Enter on a selection. */
  handleRef?: Ref<SelectionHandle>
}>

/** The text selected in a code view: the editor's selection, else a mouse selection inside it (an unfocusable view). */
export type SelectionHandle = { selection(): string }

function selectedText(view: EditorView | undefined, host: HTMLElement | null): string {
  if (view) {
    const { from, to } = view.state.selection.main
    if (from !== to) return view.state.sliceDoc(from, to)
  }
  const native = window.getSelection()
  if (!host || !native || native.isCollapsed || native.rangeCount === 0) return ''
  return host.contains(native.getRangeAt(0).commonAncestorContainer) ? native.toString() : ''
}

function createReadingView(parent: HTMLElement, text: string, language: CodeLanguage | undefined, unfocusable: boolean) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        EditorState.readOnly.of(true),
        // Unfocusable: a click leaves the keys with the host tab.
        EditorView.editable.of(!unfocusable),
        keymap.of([...readingKeys, ...defaultKeymap]),
        languageExtension(language),
        syntaxHighlighting(highlight),
        EditorView.lineWrapping,
        theme,
      ],
    }),
  })
}

type ReadingOptions = Pick<CodeViewProps, 'language' | 'focusKey' | 'passive' | 'unfocusable' | 'find' | 'autoFocus'>

/** Builds the read-only editor in `host` for `text`, and rebuilds it when its inputs change. Returns the live view. */
function useReadingView(host: RefObject<HTMLDivElement | null>, text: string, options: ReadingOptions) {
  const { language, focusKey, passive, unfocusable, find, autoFocus } = options
  const viewRef = useRef<EditorView>(undefined)
  const hadFocus = useRef(false)
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const view = createReadingView(parent, text, language, Boolean(unfocusable))
    const match = firstMatch(text, find)
    if (match) view.dispatch({ selection: match, effects: EditorView.scrollIntoView(match.anchor, { y: 'center' }) })
    viewRef.current = view
    if (autoFocus) view.focus()
    if (!passive) view.contentDOM.setAttribute('data-focus-target', '')
    // A rebuild (o, a new run) keeps focus where it was.
    if (!passive && (hadFocus.current || parent.closest('[data-pane]')?.contains(document.activeElement))) view.focus()
    hadFocus.current = false
    return () => {
      hadFocus.current = view.hasFocus
      viewRef.current = undefined
      view.destroy()
    }
  }, [host, text, language, focusKey, passive, unfocusable, find, autoFocus])
  return viewRef
}

const isPlainO = (e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) =>
  e.key === 'o' && !e.metaKey && !e.ctrlKey && !e.altKey

export function CodeView({ code, language, focusKey, original, onToggleOriginal, passive, unfocusable, autoFocus, find, handleRef }: CodeViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => (language === 'sql' && !original ? formatSql(code) : code), [code, language, original])
  const viewRef = useReadingView(host, shown, { language, focusKey, passive, unfocusable, find, autoFocus })
  useImperativeHandle(handleRef, () => ({ selection: () => selectedText(viewRef.current, host.current) }))
  return (
    <div
      className="run-body code-view"
      ref={host}
      onKeyDown={e => {
        if (isPlainO(e) && language === 'sql') {
          e.preventDefault()
          onToggleOriginal()
        }
      }}
      title={sqlToggleTitle(language, original)}
    />
  )
}

export type EditorHandle = SelectionHandle & {
  text(): string
  /** True in Vim normal mode with no key half-typed, no search or `:` prompt open. */
  atRest(): boolean
}

type EditorProps = Readonly<{
  initial: string
  language: CodeLanguage
  onChange: (text: string) => void
  handleRef: Ref<EditorHandle>
}>

function createVimView(parent: HTMLElement, initial: string, language: CodeLanguage, onChange: (text: string) => void) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: initial,
      extensions: [
        // Vim first, so its keys win over the default keymap.
        vim(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        languageExtension(language),
        syntaxHighlighting(highlight),
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChange(update.state.doc.toString())
        }),
        theme,
      ],
    }),
  })
}

/** Whether the editor is in Vim normal mode with nothing half-typed, and has the focus. */
function isAtRest(view: EditorView | undefined): boolean {
  const state = view ? getCM(view)?.state.vim : undefined
  if (!view || !state || state.insertMode || state.visualMode) return false
  return state.inputState.keyBuffer.length === 0 && view.hasFocus
}

/** The editable Code view: Vim mode, starting in normal mode. Rebuilt only when `initial` or the run changes. */
export function CodeEditor({ initial, language, onChange, handleRef }: EditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView>(undefined)
  const changed = useEffectEvent(onChange)

  useImperativeHandle(handleRef, () => ({
    text: () => viewRef.current?.state.doc.toString() ?? initial,
    selection: () => selectedText(viewRef.current, null),
    atRest: () => isAtRest(viewRef.current),
  }))

  useEffect(() => {
    if (!host.current) return
    const view = createVimView(host.current, initial, language, text => {
      changed(text)
    })
    viewRef.current = view
    view.contentDOM.setAttribute('data-focus-target', '')
    view.focus()
    return () => {
      viewRef.current = undefined
      view.destroy()
    }
    // Only the starting text: later keystrokes must not rebuild the editor.
  }, [initial, language])

  return <div className="run-body code-view editing" ref={host} />
}
