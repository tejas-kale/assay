// Code's edits and runs: `i` edits the current run, `n` opens a new SQL query, Cmd+Enter sends the code (or the
// selected SQL) to Claude's session as a new run.

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { sqlEngine } from '../../../core/dataPane.ts'
import { canRerun, SELECTION_SLUG, selectedSql } from '../../../core/requests.ts'
import { codeBody } from '../../../core/runs.ts'
import type { TabIdIn } from '../../../core/tabs.ts'
import type { Run, RunView, TrustReview } from '../../../shared/ipc.ts'
import { formatSql } from '../CodeView.tsx'
import type { EditorHandle, SelectionHandle } from '../CodeView.tsx'
import type { Edit } from './CodeTab.tsx'
import type { SendRequest } from './paneRequests.ts'
import { headerOf } from './RunHeader.tsx'
import { focusDataPane } from './paneState.ts'
import type { PaneActions } from './paneState.ts'

/** The slug a new query's run gets; the server makes it safe for a file name. */
const NEW_QUERY_SLUG = 'query'

export type Editing = {
  edit: Edit | undefined
  /** Code shows a SQL run as it was written, not formatted. */
  original: boolean
  toggleOriginal: () => void
  editText: RefObject<string>
  onType: (text: string) => void
  editor: RefObject<EditorHandle | null>
  codeSelection: RefObject<SelectionHandle | null>
  trustSelection: RefObject<SelectionHandle | null>
  startEdit: () => void
  startNew: () => void
  leave: () => void
}

/** The edit open in Code, if any: `edit` and `setEdit` are the pane's, since stepping and pinning read them too. */
export function useEditing(
  at: PaneActions & {
    edit: Edit | undefined
    setEdit: (edit: Edit | undefined) => void
    tab: TabIdIn<'data'>
    current: Run | undefined
    view: RunView | undefined
  },
): Editing {
  const { edit, setEdit, onTab, onToast } = at
  const [original, setOriginal] = useState(false)
  const editText = useRef('')
  const editCount = useRef(0)
  const open = (from: Run | undefined, language: Edit['language'], start: string) => {
    editText.current = start
    editCount.current += 1
    setEdit({ id: editCount.current, from, language, start })
    onTab('code')
  }
  useEditFocus(edit, at.tab, setEdit, editText)
  return {
    edit,
    original,
    toggleOriginal: () => { setOriginal(on => !on) },
    editText,
    onType: text => { editText.current = text },
    editor: useRef<EditorHandle>(null),
    codeSelection: useRef<SelectionHandle>(null),
    trustSelection: useRef<SelectionHandle>(null),
    startEdit: () => { startEdit(at, original, open) },
    startNew: () => {
      // Already editing: only bring the open editor forward, keeping its text.
      if (!edit) { open(undefined, 'sql', ''); return; }
      onTab('code')
      onToast(edit.from ? `Run ${edit.from.label} is open for editing: run it with ⌘↩ or leave it with Esc first.` : 'The new query is open.')
    },
    leave: () => { setEdit(undefined) },
  }
}

function startEdit(
  at: PaneActions & { edit: Edit | undefined; current: Run | undefined; view: RunView | undefined },
  original: boolean,
  open: (from: Run, language: Edit['language'], start: string) => void,
) {
  const { current, view } = at
  // Already editing: only bring the open editor forward, keeping its text.
  if (at.edit) { at.onTab('code'); return; }
  if (!current || view?.code === undefined || current.language === undefined) { at.onToast('No code to edit'); return; }
  const reason = canRerun(current, headerOf(current), view.code)
  if (reason) { at.onToast(reason); return; }
  const body = codeBody(view.code, current.language)
  open(current, current.language, current.language === 'sql' && !original ? formatSql(body) : body)
}

function useEditFocus(edit: Edit | undefined, tab: TabIdIn<'data'>, setEdit: (edit: Edit | undefined) => void, editText: RefObject<string>) {
  // Leaving Code with an edit nobody typed into closes it: an empty new query left open hid New SQL and blocked stepping.
  const closeUntouched = useEffectEvent(() => {
    if (edit && editText.current === edit.start) setEdit(undefined)
  })
  useEffect(() => {
    if (tab !== 'code') closeUntouched()
  }, [tab])
  // Leaving an edit unmounts the focused editor: give the pane its keys back, unless focus moved elsewhere.
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !edit && document.activeElement === document.body) focusDataPane()
    wasEditing.current = edit !== undefined
  }, [edit])
}

/** Where Cmd+Enter runs from: the code, the edit, or the selected SQL in Code or Trust. */
export type RunFrom = PaneActions & {
  tab: TabIdIn<'data'>
  editing: Editing
  setEdit: (edit: Edit | undefined) => void
  current: Run | undefined
  view: RunView | undefined
  runs: Run[]
  trust: TrustReview | undefined
  send: SendRequest
  /** Back to following Claude's latest run, where the new run will show. */
  follow: () => void
}

/** Cmd+Enter: the selection if there is one, else the open edit, else the current run's code, sent as a new run. */
export function runCode(at: RunFrom) {
  if (runSelection(at)) return
  const { edit, editor, editText } = at.editing
  const typed = editor.current?.text() ?? editText.current
  if (edit?.from) { sendRun(at, edit.from, typed); return; }
  if (edit) { sendNew(at, typed); return; }
  const { current, view } = at
  if (!current || view?.code === undefined || current.language === undefined) { at.onToast('No code to run'); return; }
  sendRun(at, current, codeBody(view.code, current.language))
}

function sendRun(at: RunFrom, run: Run, code: string) {
  const python = run.language === 'python'
  if (code.trim() === '') { at.onToast(`Nothing to run: the ${python ? 'code' : 'SQL'} is empty`); return; }
  const reason = canRerun(run, headerOf(run), code)
  if (reason) { at.onToast(reason); return; }
  const origin = { from: run.number, slug: run.slug }
  const request = python ? { kind: 'python' as const, code, ...origin } : { kind: 'sql' as const, sql: code, engine: run.engine ?? 'databricks', ...origin }
  at.send(request, () => {
    at.setEdit(undefined)
    at.follow()
  })
}

/** A new query has no run behind it: it runs on the engine of the latest SQL run, and opens in Data. */
function sendNew(at: RunFrom, code: string) {
  if (code.trim() === '') { at.onToast('Nothing to run: the SQL is empty'); return; }
  at.send({ kind: 'sql', sql: code, engine: sqlEngine(at.runs), slug: NEW_QUERY_SLUG }, () => {
    at.setEdit(undefined)
    at.follow()
    at.onTab('data')
    focusDataPane()
  })
}

/** The selected text Cmd+Enter would run, its language and the run it came from; none outside Code and Trust. */
function selectionSource(at: RunFrom) {
  const { edit, editor, codeSelection, trustSelection } = at.editing
  if (at.tab === 'trust') return { text: trustSelection.current?.selection() ?? '', language: at.trust?.language, from: undefined }
  if (at.tab !== 'code') return undefined
  if (edit) return { text: editor.current?.selection() ?? '', language: edit.language, from: edit.from }
  return { text: codeSelection.current?.selection() ?? '', language: at.current?.language, from: at.current }
}

/**
 * Cmd+Enter on selected SQL in Code (reading or editing) or in Trust: a new run of just that text, shown in Data.
 * An open edit stays open. True when a selection was there to handle.
 */
function runSelection(at: RunFrom): boolean {
  const where = selectionSource(at)
  const chosen = where && selectedSql(where.text, where.language)
  if (!where || !chosen) return false
  if ('error' in chosen) {
    at.onToast(chosen.error)
    return true
  }
  const engine = where.from?.engine ?? sqlEngine(at.runs)
  at.send({ kind: 'sql', sql: chosen.sql, engine, slug: SELECTION_SLUG, ...(where.from && { from: where.from.number }) }, () => {
    at.follow()
    at.onTab('data')
    focusDataPane()
  })
  return true
}
