import { useState } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'

import { runKey } from '../../../core/dataPane.ts'
import type { Run, RunView } from '../../../shared/ipc.ts'
import { CodeEditor, CodeView } from '../CodeView.tsx'
import type { EditorHandle, SelectionHandle } from '../CodeView.tsx'

/** What is open for editing: the run it came from (none for a new query), its language and the text it started with. */
export type Edit = { id: number; from: Run | undefined; language: 'sql' | 'python'; start: string }

export type CodeTabProps = Readonly<{
  header: ReactNode
  view: RunView | undefined
  /** Undefined only while a new query is open with no runs yet. */
  run: Run | undefined
  onData: () => void
  onPin: () => void
  onStep: (delta: 1 | -1) => void
  onEdit: () => void
  onNew: () => void
  original: boolean
  onToggleOriginal: () => void
  edit: Edit | undefined
  /** The text typed so far: kept by the pane, so a tab switch does not lose it. */
  editText: RefObject<string>
  onType: (text: string) => void
  editorRef: RefObject<EditorHandle | null>
  selectionRef: RefObject<SelectionHandle | null>
  onLeave: () => void
}>

/** Starts the editor from the text held when it mounts: a new edit's start, or what was typed before a tab switch. */
function EditorHost(
  props: Readonly<{ language: 'sql' | 'python'; editText: RefObject<string>; onType: (text: string) => void; handleRef: RefObject<EditorHandle | null> }>,
) {
  const [initial] = useState(() => props.editText.current)
  return <CodeEditor initial={initial} language={props.language} onChange={props.onType} handleRef={props.handleRef} />
}

/** The run's code, read-only (i edits it, n opens a new query, x shows the expanded SQL), or the editor of an edit. */
export function CodeTab(props: CodeTabProps) {
  const { header, view, edit } = props
  const [confirm, setConfirm] = useState(false)
  /** A run with includes shows the SQL as written; `x` switches to the expanded SQL that ran. */
  const [isExpanded, setExpanded] = useState(false)
  const showExpanded = isExpanded && view?.expanded !== undefined
  const toggleExpanded = () => {
    setExpanded(on => !on)
  }
  return (
    <div
      className="run"
      onKeyDownCapture={e => {
        editingKey(e, { ...props, confirm, setConfirm })
      }}
      onKeyDown={e => {
        readingKey(e, props, toggleExpanded)
      }}
    >
      {header}
      {view?.notices && !edit && (
        <div className="status notices">
          {[...view.notices.retype.map(line => `retype: ${line}`), ...view.notices.rules.map(line => `rule: ${line}`)].map(line => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      {view?.expanded !== undefined && !edit && <div className="status dim">{showExpanded ? 'Expanded SQL, as it ran (x: as written)' : 'Includes trusted pieces (x: expanded SQL)'}</div>}
      {confirm && <div className="status warn">Discard edits? y / n</div>}
      <CodeBody {...props} showExpanded={showExpanded} />
    </div>
  )
}

/** While editing: Esc in Vim normal mode leaves (asking first if anything was typed); Vim takes it elsewhere. */
function editingKey(e: KeyboardEvent, at: CodeTabProps & { confirm: boolean; setConfirm: (on: boolean) => void }) {
  if (!at.edit) return
  if (at.confirm) {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'y') at.onLeave()
    if (e.key === 'y' || e.key === 'n' || e.key === 'Escape') at.setConfirm(false)
  } else if (e.key === 'Escape' && at.editorRef.current?.atRest()) {
    e.preventDefault()
    e.stopPropagation()
    if (at.editText.current === at.edit.start) at.onLeave()
    else at.setConfirm(true)
  }
}

/** While reading: d the data, p pin, , and . step, i edit, n new query, x the expanded SQL. */
function readingKey(e: KeyboardEvent, props: CodeTabProps, toggleExpanded: () => void) {
  // The editor is contenteditable, so isPaneKey would refuse every key from it.
  if (props.edit || e.metaKey || e.ctrlKey || e.altKey) return
  const shared = runKey(e.key)
  const own: Record<string, (() => void) | undefined> = {
    d: props.onData,
    i: props.onEdit,
    n: props.onNew,
    x: props.view?.expanded === undefined ? undefined : toggleExpanded,
  }
  const action = shared?.kind === 'code' ? undefined : own[e.key]
  if (shared?.kind === 'pin') props.onPin()
  else if (shared?.kind === 'step') props.onStep(shared.delta)
  else if (action) action()
  else return
  e.preventDefault()
}

function CodeBody(props: CodeTabProps & Readonly<{ showExpanded: boolean }>) {
  const { view, run, edit } = props
  if (edit) return <EditorHost key={edit.id} language={edit.language} editText={props.editText} onType={props.onType} handleRef={props.editorRef} />
  if (!view || !run) return null
  if (view.error) return <div className="status warn">{view.error}</div>
  if (view.code === undefined) {
    return (
      <div className="empty" tabIndex={-1} data-focus-target>
        This run has no code file.
      </div>
    )
  }
  return (
    <CodeView
      code={props.showExpanded ? (view.expanded ?? view.code) : view.code}
      language={run.language}
      focusKey={`${String(run.number)}${props.showExpanded ? 'x' : ''}`}
      original={props.original}
      onToggleOriginal={props.onToggleOriginal}
      handleRef={props.selectionRef}
    />
  )
}
