import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { backlinks, noteBlocks, noteBody, noteTargets, resolveLink, targetIndices } from '../../core/noteFiles.ts'
import type { NoteTarget, Segment } from '../../core/noteFiles.ts'
import { runLabel } from '../../core/runs.ts'
import { NOTES_DIR, factPreview } from '../../core/search.ts'
import type { PreviewSource } from '../../core/search.ts'
import type { EditResult, Fact, NoteFile, Run, RunStatus } from '../../shared/ipc.ts'
import { CodeEditor } from './CodeView.tsx'
import type { EditorHandle } from './CodeView.tsx'
import { MermaidDiagram } from './Mermaid.tsx'
import { InlineInput, SearchLine, isPaneKey, useListPane, useReveal } from './common.tsx'
import type { Reveal } from './common.tsx'
import { PreviewPopup } from './Preview.tsx'

type Item = { kind: 'fact'; fact: Fact } | { kind: 'note'; note: NoteFile }

type Mode =
  | { type: 'list' }
  | { type: 'add' }
  | { type: 'edit'; fact: Fact }
  /** `text` is the note's text when the prompt opened, so a change since then makes the delete refuse. */
  | { type: 'confirmDelete'; item: Item; text?: string }
  | { type: 'file'; title: string; text: string }
  | { type: 'newNote' }
  /** The reader. `trail` is the notes opened before this one by following links. */
  | { type: 'read'; name: string; trail: string[] }
  /** The editor. `initial` is the text read when it opened. */
  | { type: 'editNote'; name: string; initial: string; trail: string[]; from: 'read' | 'list' }

const pad = (n: number) => String(n).padStart(3, '0')

const idOf = (item: Item) => (item.kind === 'fact' ? `fact:${item.fact.index}` : `note:${item.note.name}`)

export function NotesTab(props: {
  facts: Fact[]
  noteFiles: NoteFile[]
  runs: Run[]
  status: RunStatus
  /** Makes run `number` the data pane's current (held) run and focuses the pane. */
  onShowRun: (number: number) => void
  /** A universal-search hit to select: a fact, or a note file to open in the reader. */
  reveal?: Reveal | undefined
  onRevealed: () => void
}) {
  const { facts, noteFiles, reveal } = props
  const items = useMemo<Item[]>(
    () => [...facts.map((fact): Item => ({ kind: 'fact', fact })), ...noteFiles.map((note): Item => ({ kind: 'note', note }))],
    [facts, noteFiles],
  )
  const deleteItem = async ({ item, text }: { item: Item; text?: string }): Promise<EditResult> => {
    if (item.kind === 'fact') return window.app.facts.delete(item.fact.index, item.fact.line)
    if (text === undefined) return { ok: false, reason: 'invalid', message: 'The note could not be read' }
    return window.app.noteFiles.delete(item.note.name, text)
  }
  const { nav, setNav, mode, setMode, message, setMessage, rootRef, visible, selectedIndex, selected, finish, cancel, confirmDeleteKey, navigate } =
    useListPane<Item, Mode>({
      items,
      textOf: i => (i.kind === 'fact' ? i.fact.text : `${i.note.title} ${pad(i.note.number)}`),
      targetGone: m => {
        if (m.type === 'edit') return !facts.some(f => f.index === m.fact.index)
        if (m.type === 'confirmDelete') return !items.some(i => idOf(i) === idOf(m.item))
        if (m.type === 'read' || m.type === 'editNote') return !noteFiles.some(n => n.name === m.name)
        return false
      },
      confirmDelete: deleteItem,
    })
  const latest = useRef({ mode, selected })
  latest.current = { mode, selected }
  /** The pop-up preview Tab opened; closing it gives the keys back to the list. */
  const [popup, setPopup] = useState<PreviewSource>()

  useReveal(
    reveal,
    items,
    (item, target) =>
      (target.kind === 'fact' && item.kind === 'fact' && item.fact.index === target.index) ||
      (target.kind === 'note' && item.kind === 'note' && item.note.name === target.name),
    (index, item) => {
      setNav({ selected: index, search: undefined })
      setMode(item.kind === 'note' ? { type: 'read', name: item.note.name, trail: [] } : { type: 'list' })
    },
    props.onRevealed,
  )

  /** Reads a note's text, then opens its editor. */
  const openEditor = (name: string, trail: string[], from: 'read' | 'list') =>
    void window.app.noteFiles.read(name).then(result => {
      if (result.ok) setMode({ type: 'editNote', name, initial: result.text, trail, from })
      else setMessage(result.message)
    })

  function onKeyDown(e: KeyboardEvent) {
    if (!isPaneKey(e)) return
    if (mode.type === 'read' || mode.type === 'editNote') return
    if (mode.type === 'file') {
      if (e.key === 'Escape') setMode({ type: 'list' })
      else if (e.key === 'j') rootRef.current?.scrollBy(0, 40)
      else if (e.key === 'k') rootRef.current?.scrollBy(0, -40)
      else return
      e.preventDefault()
      return
    }
    if (confirmDeleteKey(e)) return
    if (mode.type !== 'list') return

    setMessage(undefined)
    if (previewKey(e)) return
    if (!nav.search?.active) {
      switch (e.key) {
        case 'a':
          e.preventDefault()
          setMode({ type: 'add' })
          return
        case 'n':
          e.preventDefault()
          setMode({ type: 'newNote' })
          return
        case 'e':
          e.preventDefault()
          if (!selected) return
          if (selected.kind === 'note') openEditor(selected.note.name, [], 'list')
          else if (selected.fact.file) setMessage('A note file cannot be edited here')
          else setMode({ type: 'edit', fact: selected.fact })
          return
        case 'd':
          e.preventDefault()
          if (!selected) return
          if (selected.kind === 'fact') setMode({ type: 'confirmDelete', item: selected })
          else {
            // The text is read now, so a change made while the prompt is open stops the delete.
            const item = selected
            void window.app.noteFiles.read(item.note.name).then(result => {
              // Skip when the user left the list or moved while the read ran.
              const current = latest.current
              if (result.ok && current.mode.type === 'list' && current.selected && idOf(current.selected) === idOf(item))
                setMode({ type: 'confirmDelete', item, text: result.text })
              else if (result.ok) return
              else setMessage(result.message)
            })
          }
          return
      }
    }
    const effect = navigate(e)
    if (effect?.type === 'open' && selected) {
      if (selected.kind === 'note') setMode({ type: 'read', name: selected.note.name, trail: [] })
      else if (selected.fact.file) {
        const { title } = selected.fact.file
        void window.app.readNoteFile(selected.fact.file.path).then(result => {
          if (result.ok) setMode({ type: 'file', title, text: result.text })
          else setMessage(result.message)
        })
      }
    }
  }

  /** Tab opens the selected item in a pop-up preview. */
  function previewKey(e: KeyboardEvent): boolean {
    if (e.key !== 'Tab' || e.shiftKey) return false
    e.preventDefault()
    if (previewSource) setPopup(previewSource)
    return true
  }

  const previewSource: PreviewSource | undefined = !selected
    ? undefined
    : selected.kind === 'note'
      ? { type: 'path', path: `${NOTES_DIR}/${selected.note.name}` }
      : factPreview(selected.fact, props.runs)

  const readNote = mode.type === 'read' ? noteFiles.find(n => n.name === mode.name) : undefined
  const editNote = mode.type === 'editNote' ? noteFiles.find(n => n.name === mode.name) : undefined
  // The reader and the editor carry the focus target themselves, so Cmd+2 reaches them rather than the list.
  const ownsFocus = mode.type === 'read' || mode.type === 'editNote'

  return (
    <div className="list" tabIndex={-1} ref={rootRef} {...(ownsFocus ? {} : { 'data-focus-target': '' })} onKeyDown={onKeyDown}>
      {mode.type === 'file' ? (
        <>
          <div className="subhead">
            {mode.title} <span className="dim">(read only, Esc to go back)</span>
          </div>
          <pre className="filetext">{mode.text}</pre>
        </>
      ) : mode.type === 'read' && readNote ? (
        <NoteReader
          key={readNote.name}
          note={readNote}
          notes={noteFiles}
          runs={props.runs}
          status={props.status}
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
          onLeave={() => (mode.from === 'read' ? (setMode({ type: 'read', name: mode.name, trail: mode.trail })) : cancel())}
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
      ) : (
        <>
          <SearchLine search={nav.search} />
          {items.length === 0 && mode.type !== 'add' && <div className="empty">No facts yet. Press a to add one, n for a note.</div>}
          <ul role="listbox" aria-label="Facts and note files">
            {visible.map((item, i) => {
              const selectedRow = i === selectedIndex
              if (item.kind === 'note') {
                const { note } = item
                return (
                  <li key={idOf(item)} role="presentation" className="note-row-wrap">
                    {visible[i - 1]?.kind !== 'note' && <div className="subhead group">Note files</div>}
                    <div role="option" aria-selected={selectedRow} className={selectedRow ? 'row sel' : 'row'}>
                      <span className="grow">{note.title}</span>
                      <span className="dim">{pad(note.number)}</span>
                    </div>
                  </li>
                )
              }
              const { fact } = item
              return mode.type === 'edit' && mode.fact.index === fact.index ? (
                <li key={fact.index} className="row">
                  <InlineInput
                    label="Edit"
                    initial={fact.text}
                    onCancel={cancel}
                    onSubmit={value => void window.app.facts.edit(fact.index, mode.fact.line, value).then(finish)}
                  />
                </li>
              ) : (
                <li key={idOf(item)} role="option" aria-selected={selectedRow} className={selectedRow ? 'row sel' : 'row'}>
                  {fact.label && <span className={`chip chip-${fact.label}`}>{fact.label}</span>}
                  {fact.file && <span className="chip chip-file">note file</span>}
                  <span className="grow">{fact.text}</span>
                  {fact.query !== undefined && <span className="dim">q {fact.query}</span>}
                </li>
              )
            })}
          </ul>
          {mode.type === 'add' && (
            <InlineInput
              label="Add fact (end with [q 12] to cite a query)"
              onCancel={cancel}
              onSubmit={value =>
                void window.app.facts.add(value).then(result => {
                  if (result.ok) setNav(s => ({ ...s, selected: facts.length }))
                  finish(result)
                })
              }
            />
          )}
          {mode.type === 'newNote' && (
            <InlineInput
              label="New note title"
              onCancel={cancel}
              onSubmit={title =>
                void window.app.noteFiles.create(title).then(result => {
                  if (!result.ok) {
                    setMessage(result.message)
                    cancel()
                  } else openEditor(result.name, [], 'list')
                })
              }
            />
          )}
          {mode.type === 'confirmDelete' && (
            <div className="status warn">
              Delete "{mode.item.kind === 'fact' ? mode.item.fact.text : mode.item.note.title}"? y to confirm, any other key cancels
            </div>
          )}
          {message && <div className="status warn">{message}</div>}
        </>
      )}
      {popup && (
        <PreviewPopup
          source={popup}
          onClose={() => {
            setPopup(undefined)
            requestAnimationFrame(() => rootRef.current?.focus())
          }}
        />
      )}
      {ownsFocus && message && <div className="status warn">{message}</div>}
    </div>
  )
}

/** The reader: the note as text, with links and citations to move between (Tab) and follow (Enter). */
function NoteReader(props: {
  note: NoteFile
  notes: NoteFile[]
  runs: Run[]
  status: RunStatus
  canGoBack: boolean
  onOpen: (name: string) => void
  onShowRun: (number: number) => void
  onBack: () => void
  onEdit: () => void
  onLeave: () => void
}) {
  const { note, notes, runs, status } = props
  const root = useRef<HTMLDivElement>(null)
  const [text, setText] = useState<string>()
  const [error, setError] = useState<string>()
  const [sel, setSel] = useState(-1)

  // Read again when this note's own file changed: Claude and the user may both edit it.
  useEffect(() => {
    void window.app.noteFiles.read(note.name).then(result => {
      if (result.ok) {
        setText(result.text)
        setError(undefined)
      } else setError(result.message)
    })
  }, [note.name, note.mtimeMs, note.size, error ? status : undefined])
  useEffect(() => root.current?.focus(), [])

  const blocks = useMemo(() => noteBlocks(noteBody(text ?? '')), [text])
  const linkedFrom = useMemo(() => backlinks(note, notes), [note, notes])
  const targets = useMemo(() => noteTargets(blocks, linkedFrom), [blocks, linkedFrom])
  const indices = useMemo(() => targetIndices(blocks), [blocks])
  const [flash, setFlash] = useState<string>()
  const current = sel >= 0 && sel < targets.length ? sel : -1

  useEffect(() => {
    root.current?.querySelector('.target.sel')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const follow = (target: NoteTarget | undefined) => {
    if (!target) return
    if (target.type === 'backlink') props.onOpen(target.name)
    else if (target.type === 'link') {
      const found = resolveLink(target.target, notes)
      if (found) props.onOpen(found.name)
      else setFlash(`No note "${target.target}"`)
    } else if (runs.some(r => r.number === target.number)) props.onShowRun(target.number)
    else setFlash(`No run ${pad(target.number)}`)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
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
        const found = resolveLink(s.target, notes)
        return (
          <span key={i} className={`${cls} wikilink`}>
            {found ? found.title : s.target}
            {!found && <span className="chip chip-unverified">missing</span>}
          </span>
        )
      }
      const run = runs.find(r => r.number === s.number)
      const label = run
        ? runLabel(run, { author: run.author ?? 'claude', engine: run.engine ?? 'databricks', ...(run.trusted !== undefined && { trusted: run.trusted }) }, status)
        : undefined
      return (
        <span key={i} className={`${cls} citation`}>
          q {pad(s.number)} <span className={`chip chip-${label ?? 'unverified'}`}>{label ?? 'no run'}</span>
        </span>
      )
    })

  return (
    <div className="note-reader" tabIndex={-1} ref={root} data-focus-target onKeyDown={onKeyDown}>
      <div className="subhead">
        {note.title} <span className="dim">{pad(note.number)} (e edit, Esc back{props.canGoBack ? ', Backspace previous' : ''})</span>
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
      {linkedFrom.length > 0 && (
        <div className="note-backlinks">
          <div className="subhead group">Linked from</div>
          {linkedFrom.map((b, i) => {
            const mine = indices.size + i
            return (
              <div key={b.name} className={mine === current ? 'row target sel' : 'row target'}>
                <span className="grow">{b.title}</span>
                <span className="dim">{pad(b.number)}</span>
              </div>
            )
          })}
        </div>
      )}
      {flash && <div className="status warn">{flash}</div>}
    </div>
  )
}

/** The editor: Vim mode over the note's Markdown. Cmd+S saves; Esc in normal mode leaves. */
function NoteEditor(props: { note: NoteFile; initial: string; onLeave: () => void; onStale: (unsaved: string) => void }) {
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
    const result = await window.app.noteFiles.save(props.note.name, baseline.current, next)
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
