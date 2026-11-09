import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { formatAge } from '../../core/age.ts'
import { citationKey } from '../../core/citationLabels.ts'
import { citationAction, citationText, linkTitle, noteGroups } from '../../core/notesView.ts'
import { idTime, noteBlocks, noteBody, noteTargets, targetIndices } from '../../core/rootNotes.ts'
import type { NoteTarget, Segment } from '../../core/rootNotes.ts'
import type { CitationLabel, NoteLists, RootNote, Run, RunView } from '../../shared/ipc.ts'
import { CitedRunPopup } from './CitedRun.tsx'
import { CodeEditor } from './CodeView.tsx'
import type { EditorHandle } from './CodeView.tsx'
import { MermaidDiagram } from './Mermaid.tsx'
import { SearchLine, isPaneKey, useListPane } from './common.tsx'
import type { Reveal } from './common.tsx'

type Item = { group: 'written' | 'found'; note: RootNote }

type Mode =
  | { type: 'list' }
  | { type: 'add' }
  /** The reader. `trail` is the notes opened before this one by following links. */
  | { type: 'read'; name: string; trail: string[] }
  /** The editor. `initial` is the text read when it opened. */
  | { type: 'editNote'; name: string; initial: string; trail: string[]; from: 'read' | 'list' }

const pad = (n: number) => String(n).padStart(3, '0')

/** Written then Found, each newest first: the Notes tab's rows. */
export function useNoteItems(rootNotes: RootNote[], lists: NoteLists): Item[] {
  return useMemo(() => {
    const groups = noteGroups(rootNotes, lists)
    return [...groups.written.map((note): Item => ({ group: 'written', note })), ...groups.found.map((note): Item => ({ group: 'found', note }))]
  }, [rootNotes, lists])
}

export function NotesTab(props: {
  /** The open analysis's slug: its citations focus a run, others open a preview. */
  slug: string
  rootNotes: RootNote[]
  noteLists: NoteLists
  runs: Run[]
  /** Makes run `number` the data pane's current (held) run and focuses the pane. */
  onShowRun: (number: number) => void
  /** A universal-search hit: a root note to open in the reader. */
  reveal?: Reveal | undefined
  onRevealed: () => void
}) {
  const { rootNotes, reveal } = props
  const items = useNoteItems(rootNotes, props.noteLists)
  const { nav, setNav, mode, setMode, message, setMessage, rootRef, visible, selectedIndex, selected, cancel, navigate } = useListPane<Item, Mode>({
    items,
    textOf: i => i.note.title,
    targetGone: m => (m.type === 'read' || m.type === 'editNote') && !rootNotes.some(n => n.name === m.name),
    confirmDelete: () => Promise.resolve({ ok: true }),
  })

  // A search hit opens its note in the reader, whether or not this analysis lists it.
  useEffect(() => {
    if (reveal?.target.kind !== 'note') return
    const { name } = reveal.target
    if (rootNotes.some(n => n.name === name)) setMode({ type: 'read', name, trail: [] })
    props.onRevealed()
  }, [reveal?.n])

  /** Reads a note's text, then opens its editor. */
  const openEditor = (name: string, trail: string[], from: 'read' | 'list') =>
    void window.app.notes.read(name).then(result => {
      if (result.ok) setMode({ type: 'editNote', name, initial: result.text, trail, from })
      else setMessage(result.message)
    })

  function onKeyDown(e: KeyboardEvent) {
    if (!isPaneKey(e)) return
    if (mode.type !== 'list') return
    setMessage(undefined)
    if (!nav.search?.active) {
      switch (e.key) {
        case 'a':
          e.preventDefault()
          setMode({ type: 'add' })
          return
        case 'e':
          e.preventDefault()
          if (selected) openEditor(selected.note.name, [], 'list')
          return
      }
    }
    const effect = navigate(e)
    if (effect?.type === 'open' && selected) setMode({ type: 'read', name: selected.note.name, trail: [] })
  }

  const readNote = mode.type === 'read' ? rootNotes.find(n => n.name === mode.name) : undefined
  const editNote = mode.type === 'editNote' ? rootNotes.find(n => n.name === mode.name) : undefined
  // The reader, the editor and the add form carry the focus target themselves, so Ctrl+2 reaches them rather than the list.
  const ownsFocus = mode.type === 'read' || mode.type === 'editNote' || mode.type === 'add'
  const now = Date.now()

  return (
    <div className="list" tabIndex={-1} ref={rootRef} {...(ownsFocus ? {} : { 'data-focus-target': '' })} onKeyDown={onKeyDown}>
      {mode.type === 'read' && readNote ? (
        <NoteReader
          key={readNote.name}
          note={readNote}
          notes={rootNotes}
          slug={props.slug}
          runs={props.runs}
          canGoBack={mode.trail.length > 0}
          onOpen={name => setMode({ type: 'read', name, trail: [...mode.trail, readNote.name] })}
          onShowRun={props.onShowRun}
          onBack={() => {
            const name = mode.trail.at(-1)
            if (name) setMode({ type: 'read', name, trail: mode.trail.slice(0, -1) })
          }}
          onEdit={() => openEditor(readNote.name, mode.trail, 'read')}
          onLeave={cancel}
        />
      ) : mode.type === 'editNote' && editNote ? (
        <NoteEditor
          key={editNote.name}
          note={editNote}
          initial={mode.initial}
          onLeave={() => (mode.from === 'read' ? setMode({ type: 'read', name: mode.name, trail: mode.trail }) : cancel())}
          onStale={unsaved => {
            // The reload drops the user's text, so it goes to the clipboard first.
            const { name, trail } = mode
            void navigator.clipboard.writeText(unsaved).then(
              () => 'Changed on disk, reloaded. Your edit is on the clipboard.',
              () => 'Changed on disk, reloaded. Your edit could not be copied.',
            ).then(setMessage)
            setMode({ type: 'read', name, trail })
          }}
        />
      ) : mode.type === 'add' ? (
        <NoteAdd
          onCancel={cancel}
          onSubmit={(title, text) =>
            void window.app.notes.add(title, text).then(result => {
              if (result.ok) setNav(s => ({ ...s, selected: 0 }))
              else setMessage(result.message)
              cancel()
            })
          }
        />
      ) : (
        <>
          <SearchLine search={nav.search} />
          {items.length === 0 && <div className="empty">No notes yet. Press a to add one.</div>}
          <ul role="listbox" aria-label="Written and found notes">
            {visible.map((item, i) => {
              const { note } = item
              const selectedRow = i === selectedIndex
              return (
                <li key={note.name} role="presentation" className="note-row-wrap">
                  {visible[i - 1]?.group !== item.group && <div className="subhead group">{item.group === 'written' ? 'Written' : 'Found'}</div>}
                  <div role="option" aria-selected={selectedRow} className={selectedRow ? 'row sel' : 'row'}>
                    <span className="grow">{note.title}</span>
                    <span className="dim note-row-age">{formatAge(idTime(note.id).getTime(), now)}</span>
                  </div>
                </li>
              )
            })}
          </ul>
          {message && <div className="status warn">{message}</div>}
        </>
      )}
      {ownsFocus && message && <div className="status warn">{message}</div>}
    </div>
  )
}

/** Title and text of a new note. Enter in the title moves to the text; ⌘Enter saves; Esc cancels. */
function NoteAdd(props: { onSubmit: (title: string, text: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const body = useRef<HTMLTextAreaElement>(null)
  const submit = () => {
    if (title.trim() !== '') props.onSubmit(title, text)
  }
  const keys = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onCancel()
    } else if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div className="note-add" data-focus-target tabIndex={-1}>
      <input
        autoFocus
        aria-label="Note title"
        placeholder="Title (the finding, in a line)"
        value={title}
        spellCheck={false}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => {
          keys(e)
          if (e.key === 'Enter' && !e.metaKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            body.current?.focus()
          }
        }}
      />
      <textarea ref={body} aria-label="Note text" placeholder="Text. Cite runs as [q 12]; link notes as [[ID]]." value={text} onChange={e => setText(e.target.value)} onKeyDown={keys} />
      <div className="hint">Enter in title: to text · ⌘Enter save · Esc cancel</div>
    </div>
  )
}

/** The reader: the note as text, with links and citations to move between (Tab) and follow (Enter). */
function NoteReader(props: {
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
}) {
  const { note, notes, slug, runs } = props
  const root = useRef<HTMLDivElement>(null)
  const [text, setText] = useState<string>()
  const [labels, setLabels] = useState<ReadonlyMap<string, CitationLabel>>(new Map())
  const [error, setError] = useState<string>()
  const [sel, setSel] = useState(-1)
  const [cited, setCited] = useState<{ title: string; label: CitationLabel | undefined; view: RunView }>()

  // Read again when this note's own file changed, or the runs did (a label follows its run): Claude and the user may both edit it.
  useEffect(() => {
    void window.app.notes.read(note.name).then(result => {
      if (result.ok) {
        setText(result.text)
        setLabels(new Map(Object.entries(result.labels) as [string, CitationLabel][]))
        setError(undefined)
      } else setError(result.message)
    })
  }, [note.name, note.mtimeMs, note.size, runs])
  useEffect(() => root.current?.focus(), [])

  const blocks = useMemo(() => noteBlocks(noteBody(text ?? '')), [text])
  const targets = useMemo(() => noteTargets(blocks), [blocks])
  const indices = useMemo(() => targetIndices(blocks), [blocks])
  const [flash, setFlash] = useState<string>()
  const current = sel >= 0 && sel < targets.length ? sel : -1

  useEffect(() => {
    root.current?.querySelector('.target.sel')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const follow = (target: NoteTarget | undefined) => {
    if (!target) return
    if (target.type === 'link') {
      const found = notes.find(n => n.id === target.id)
      if (found) props.onOpen(found.name)
      else setFlash(`No note ${target.id}`)
      return
    }
    const action = citationAction(target, slug, labels)
    if (action.type === 'missing') setFlash(`No run ${target.analysis} q ${pad(target.number)}`)
    else if (action.type === 'focus') {
      if (runs.some(r => r.number === action.number)) props.onShowRun(action.number)
      else setFlash(`No run ${pad(action.number)}`)
    } else {
      void window.app.notes.readRun(action.analysis, action.number).then(view => {
        if (view) setCited({ title: citationText(target, slug), label: labels.get(citationKey(target)), view })
        else setFlash(`No run ${target.analysis} q ${pad(target.number)}`)
      })
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || cited) return
    setFlash(undefined)
    if (e.key === 'Tab') {
      if (targets.length > 0) setSel(((e.shiftKey ? current - 1 : current + 1) + targets.length) % targets.length)
    } else if (e.key === 'Enter') follow(targets[current])
    else if (e.key === 'Backspace') props.onBack()
    else if (e.key === 'Escape') props.onLeave()
    else if (e.key === 'e') props.onEdit()
    else if (e.key === 'j') root.current?.scrollBy(0, 40)
    else if (e.key === 'k') root.current?.scrollBy(0, -40)
    else return
    e.preventDefault()
  }

  const renderSegments = (segments: Segment[]) =>
    segments.map((s, i) => {
      if (s.type === 'text') return <span key={i}>{s.text}</span>
      const mine = indices.get(s) ?? -1
      const cls = mine === current ? 'target sel' : 'target'
      if (s.type === 'link') {
        const title = linkTitle(s.id, notes)
        // An unresolved link stays as written.
        return (
          <span key={i} className={title === undefined ? cls : `${cls} wikilink`}>
            {title === undefined ? `[[${s.id}${s.label ? `|${s.label}` : ''}]]` : (s.label ?? title)}
          </span>
        )
      }
      const label = labels.get(citationKey(s))
      return (
        <span key={i} className={`${cls} citation`}>
          {citationText(s, slug)}
          {label && <span className={`chip chip-${label}`}>{label}</span>}
        </span>
      )
    })

  return (
    <div className="note-reader" tabIndex={-1} ref={root} data-focus-target onKeyDown={onKeyDown}>
      <div className="subhead">
        {note.title} <span className="dim">{note.id} (e edit, Esc back{props.canGoBack ? ', Backspace previous' : ''})</span>
      </div>
      {error && <div className="status warn">{error}</div>}
      <div className="note-body">
        {blocks.map((block, i) =>
          block.type === 'code' && block.lang === 'mermaid' ? (
            <MermaidDiagram key={i} text={block.text} />
          ) : block.type === 'code' ? (
            <pre key={i} className="filetext note-code">
              {block.text}
            </pre>
          ) : block.type === 'heading' ? (
            <div key={i} className={`note-heading h${block.level}`}>
              {renderSegments(block.segments)}
            </div>
          ) : (
            <p key={i} className="note-par">
              {renderSegments(block.segments)}
            </p>
          ),
        )}
      </div>
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

/** The editor: Vim mode over the note's Markdown. Cmd+S saves; Esc in normal mode leaves. */
function NoteEditor(props: { note: RootNote; initial: string; onLeave: () => void; onStale: (unsaved: string) => void }) {
  const handle = useRef<EditorHandle>(null)
  const baseline = useRef(props.initial)
  const text = useRef(props.initial)
  const [confirm, setConfirm] = useState(false)
  const [status, setStatus] = useState<string>()

  const save = async () => {
    const next = handle.current?.text() ?? text.current
    if (next === baseline.current) {
      setStatus('Nothing to save')
      return
    }
    const result = await window.app.notes.save(props.note.name, baseline.current, next)
    if (result.ok) {
      baseline.current = next
      setStatus('Saved')
    } else if (result.reason === 'stale') props.onStale(next)
    else setStatus(result.message)
  }

  return (
    <div
      className="note-editor"
      onKeyDownCapture={e => {
        if (confirm) {
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'y') props.onLeave()
          if (e.key === 'y' || e.key === 'n' || e.key === 'Escape') setConfirm(false)
        } else if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === 's') {
          e.preventDefault()
          e.stopPropagation()
          void save()
        } else if (e.key === 'Escape' && handle.current?.atRest()) {
          e.preventDefault()
          e.stopPropagation()
          if ((handle.current.text() ?? text.current) === baseline.current) props.onLeave()
          else setConfirm(true)
        }
      }}
    >
      <div className="subhead">
        {props.note.title} <span className="dim">editing (⌘S save, Esc leave)</span>
      </div>
      {confirm && <div className="status warn">Discard changes? y / n</div>}
      {status && !confirm && <div className="status">{status}</div>}
      <CodeEditor
        initial={props.initial}
        language="markdown"
        onChange={t => {
          text.current = t
          setStatus(undefined)
        }}
        handleRef={handle}
      />
    </div>
  )
}
