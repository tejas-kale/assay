import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'

import { citationKey } from '../../../core/citationLabels.ts'
import { citationText } from '../../../core/notesView.ts'
import { cycleTarget, followTarget, missingRun, readerCommand } from '../../../core/noteReader.ts'
import type { ReaderCommand } from '../../../core/noteReader.ts'
import { noteBlocks, noteBody, noteTargets, targetIndices } from '../../../core/rootNotes.ts'
import type { NoteTarget } from '../../../core/rootNotes.ts'
import type { CitationLabel, RootNote, Run, RunView } from '../../../shared/ipc.ts'
import { CitedRunPopup } from '../CitedRun.tsx'
import { NoteBody } from './NoteBody.tsx'

type Props = Readonly<{
  note: RootNote
  notes: RootNote[]
  slug: string
  runs: Run[]
  canGoBack: boolean
  onOpen: (name: string) => void
  onShowRun: (number: number) => void
  onBack: () => void
  onEdit: () => void
  onLeave: () => void
}>

type Cited = { title: string; label: CitationLabel | undefined; view: RunView }

const SCROLL_STEP = 40

/** The note's text and its citations' labels, read again when its file changed or the runs did (a label follows its run). */
function useNoteText(note: RootNote, runs: readonly Run[]) {
  const [text, setText] = useState<string>()
  const [labels, setLabels] = useState<ReadonlyMap<string, CitationLabel>>(new Map())
  const [error, setError] = useState<string>()
  // Claude and the user may both edit the note, so it is read again when the file changes.
  useEffect(() => {
    void window.app.notes.read(note.name).then(result => {
      if (result.ok) {
        setText(result.text)
        setLabels(new Map(Object.entries(result.labels)))
        setError(undefined)
      } else setError(result.message)
    })
  }, [note.name, note.mtimeMs, note.size, runs])
  return { text, labels, error }
}

/** The note's blocks, and the links and citations in them that Tab moves between. */
function useNoteTargets(text: string | undefined) {
  const blocks = useMemo(() => noteBlocks(noteBody(text ?? '')), [text])
  const targets = useMemo(() => noteTargets(blocks), [blocks])
  const indices = useMemo(() => targetIndices(blocks), [blocks])
  return { blocks, targets, indices }
}

/** Takes the focus when the reader opens, and keeps the selected target in view. */
function useFocusAndScroll(root: RefObject<HTMLElement | null>, current: number) {
  useEffect(() => {
    root.current?.focus()
  }, [root])
  useEffect(() => {
    root.current?.querySelector('.target.sel')?.scrollIntoView({ block: 'nearest' })
  }, [root, current])
}

/** Follows a link or citation: opens the note, holds the run, shows another analysis's run in a pop-up, or flashes what is missing. */
function useFollow(props: Props, labels: ReadonlyMap<string, CitationLabel>, show: { flash: (text: string) => void; cited: (cited: Cited) => void }) {
  const { notes, slug, runs, onOpen, onShowRun } = props
  return (target: NoteTarget | undefined) => {
    if (!target) return
    const result = followTarget(target, { notes, slug, labels, runNumbers: runs.map(r => r.number) })
    if (result.type === 'open-note') onOpen(result.name)
    else if (result.type === 'show-run') onShowRun(result.number)
    else if (result.type === 'flash') show.flash(result.text)
    else {
      void window.app.notes.readRun(result.analysis, result.number).then(view => {
        if (view) show.cited({ title: citationText(result, slug), label: labels.get(citationKey(result)), view })
        else show.flash(missingRun(result.analysis, result.number))
      })
    }
  }
}

type Keys = {
  root: RefObject<HTMLDivElement | null>
  targets: readonly NoteTarget[]
  current: number
  setSelected: (index: number) => void
  follow: (target: NoteTarget | undefined) => void
}

/** Carries out a reader command. */
function carryOut(command: ReaderCommand, props: Props, keys: Keys) {
  const { root, targets, current, setSelected, follow } = keys
  if (command === 'next-target' || command === 'previous-target') {
    if (targets.length > 0) setSelected(cycleTarget(current, command === 'next-target', targets.length))
  } else if (command === 'follow') follow(targets[current])
  else if (command === 'back') props.onBack()
  else if (command === 'leave') props.onLeave()
  else if (command === 'edit') props.onEdit()
  else root.current?.scrollBy(0, command === 'scroll-down' ? SCROLL_STEP : -SCROLL_STEP)
}

/** The reader: the note as text, with links and citations to move between (Tab) and follow (Enter). */
export function NoteReader(props: Props) {
  const { note, notes, slug, canGoBack } = props
  const root = useRef<HTMLDivElement>(null)
  const { text, labels, error } = useNoteText(note, props.runs)
  const { blocks, targets, indices } = useNoteTargets(text)
  const [selected, setSelected] = useState(-1)
  const [flash, setFlash] = useState<string>()
  const [cited, setCited] = useState<Cited>()
  const current = selected >= 0 && selected < targets.length ? selected : -1

  useFocusAndScroll(root, current)

  const follow = useFollow(props, labels, { flash: setFlash, cited: setCited })
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || cited) return
    setFlash(undefined)
    const command = readerCommand(e.key, e.shiftKey)
    if (!command) return
    carryOut(command, props, { root, targets, current, setSelected, follow })
    e.preventDefault()
  }

  return (
    <div className="note-reader" tabIndex={-1} ref={root} data-focus-target onKeyDown={onKeyDown}>
      <div className="subhead">
        {note.title} <span className="dim">{note.id} (e edit, Esc back{canGoBack ? ', Backspace previous' : ''})</span>
      </div>
      {error && <div className="status warn">{error}</div>}
      <NoteBody blocks={blocks} context={{ notes, slug, labels, indices, current }} />
      {flash && <div className="status warn">{flash}</div>}
      {cited && (
        <CitedRunPopup
          {...cited}
          onClose={() => {
            setCited(undefined)
            requestAnimationFrame(() => root.current?.focus())
          }}
        />
      )}
    </div>
  )
}
