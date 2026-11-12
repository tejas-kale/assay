import { useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'

import { editorKey } from '../../../core/noteReader.ts'
import type { EditorKeyAction } from '../../../core/noteReader.ts'
import type { RootNote } from '../../../shared/ipc.ts'
import { CodeEditor } from '../CodeView.tsx'
import type { EditorHandle } from '../CodeView.tsx'

type Props = Readonly<{ note: RootNote; initial: string; onLeave: () => void; onStale: (unsaved: string) => void }>

/** Saving against the text read when the editor opened: `baseline` moves forward with each save. */
function useNoteSave(note: RootNote, initial: string, handle: RefObject<EditorHandle | null>, onStale: (unsaved: string) => void) {
  const baseline = useRef(initial)
  const text = useRef(initial)
  const [status, setStatus] = useState<string>()
  const save = async () => {
    const next = handle.current?.text() ?? text.current
    if (next === baseline.current) {
      setStatus('Nothing to save')
      return
    }
    const result = await window.app.notes.save(note.name, baseline.current, next)
    if (result.ok) {
      baseline.current = next
      setStatus('Saved')
    } else if (result.reason === 'stale') onStale(next)
    else setStatus(result.message)
  }
  const typed = (changed: string) => {
    text.current = changed
    setStatus(undefined)
  }
  const unsaved = () => handle.current?.text() !== baseline.current
  return { save, typed, status, unsaved }
}

/** The editor: Vim mode over the note's Markdown. Cmd+S saves; Esc in normal mode leaves. */
export function NoteEditor({ note, initial, onLeave, onStale }: Props) {
  const handle = useRef<EditorHandle>(null)
  const [confirm, setConfirm] = useState(false)
  const { save, typed, status, unsaved } = useNoteSave(note, initial, handle, onStale)

  const carryOut = (action: EditorKeyAction) => {
    if (action === 'save') void save()
    if (action === 'leave-and-close-prompt') onLeave()
    if (action === 'leave-and-close-prompt' || action === 'close-prompt') setConfirm(false)
    if (action === 'leave-or-ask') {
      if (unsaved()) setConfirm(true)
      else onLeave()
    }
  }

  const onKeyDownCapture = (e: KeyboardEvent) => {
    const action = editorKey(e, confirm, handle.current?.atRest() ?? false)
    if (action === undefined) return
    e.preventDefault()
    e.stopPropagation()
    carryOut(action)
  }

  return (
    <div className="note-editor" onKeyDownCapture={onKeyDownCapture}>
      <div className="subhead">
        {note.title} <span className="dim">editing (⌘S save, Esc leave)</span>
      </div>
      {confirm && <div className="status warn">Discard changes? y / n</div>}
      {status && !confirm && <div className="status">{status}</div>}
      <CodeEditor
        initial={initial}
        language="markdown"
        onChange={typed}
        handleRef={handle}
      />
    </div>
  )
}
