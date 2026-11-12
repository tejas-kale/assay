// How CodeMirror looks and reads here: colours, the reading keys, and the language of a view.
import {
  cursorCharLeft,
  cursorCharRight,
  cursorDocEnd,
  cursorDocStart,
  cursorGroupBackward,
  cursorGroupForward,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineDown,
  cursorLineUp,
  cursorPageDown,
  cursorPageUp,
} from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql, StandardSQL } from '@codemirror/lang-sql'
import { HighlightStyle } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Command } from '@codemirror/view'
import { tags } from '@lezer/highlight'

import type { CodeLanguage } from '../../../core/codeLanguage.ts'
import { MONO_FONT } from '../../../core/theme.ts'

export const highlight = HighlightStyle.define([
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

export const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'transparent', fontSize: '12px' },
  '.cm-scroller': { fontFamily: MONO_FONT, lineHeight: '1.5' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--sel)' },
  '.cm-activeLine': { backgroundColor: 'var(--sel)' },
})

/** Vim-style reading keys. Unclaimed keys bubble to the tab (for `d`, `o`). */
export const readingKeys: { key: string; run: Command }[] = [
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

const LANGUAGE_EXTENSIONS: Record<CodeLanguage, () => Extension> = {
  sql: () => sql({ dialect: StandardSQL, upperCaseKeywords: true }),
  python: () => python(),
  markdown: () => markdown(),
}

/** The syntax support of a language; none while the language is unknown. */
export const languageExtension = (language: CodeLanguage | undefined): Extension =>
  language ? LANGUAGE_EXTENSIONS[language]() : []
