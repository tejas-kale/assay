import { useEffect, useEffectEvent, useMemo } from 'react'
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react'

import { formatAge } from '../../core/age.ts'
import { noteGroups } from '../../core/notesView.ts'
import { staleEditMessage } from '../../core/noteReader.ts'
import { idTime } from '../../core/rootNotes.ts'
import type { NoteLists, RootNote, Run } from '../../shared/ipc.ts'
import { NoteAdd } from './notes/NoteAdd.tsx'
import { NoteEditor } from './notes/NoteEditor.tsx'
import { NoteReader } from './notes/NoteReader.tsx'
import { SearchLine, isPaneKey, useListPane } from './common.tsx'
import type { ListPane, Reveal } from './common.tsx'
import { useNow } from './useNow.ts'

type Item = { group: 'written' | 'found'; note: RootNote }

type Mode =
  | { type: 'list' }
  | { type: 'add' }
  /** The reader. `trail` is the notes opened before this one by following links. */
  | { type: 'read'; name: string; trail: string[] }
  /** The editor. `initial` is the text read when it opened. */
  | { type: 'editNote'; name: string; initial: string; trail: string[]; from: 'read' | 'list' }

type Pane = Omit<ListPane<Item, Mode>, 'rootRef'>
type OpenEditor = (name: string, trail: string[], from: 'read' | 'list') => void

const AGE_REFRESH_MS = 30_000

/** Written then Found, each newest first: the Notes tab's rows. */
export function useNoteItems(rootNotes: RootNote[], lists: NoteLists): Item[] {
  return useMemo(() => {
    const groups = noteGroups(rootNotes, lists)
    return [...groups.written.map((note): Item => ({ group: 'written', note })), ...groups.found.map((note): Item => ({ group: 'found', note }))]
  }, [rootNotes, lists])
}

/** Copies `text` to the clipboard and says whether it got there, as the message to show. */
function copyUnsaved(text: string): Promise<string> {
  return navigator.clipboard.writeText(text).then(
    () => staleEditMessage(true),
    () => staleEditMessage(false),
  )
}

/** A search hit opens its note in the reader, whether or not this analysis lists it. */
function useRevealedNote(reveal: Reveal | undefined, rootNotes: RootNote[], setMode: Dispatch<SetStateAction<Mode>>, onRevealed: () => void) {
  const open = useEffectEvent(() => {
    if (reveal?.target.kind !== 'note') return
    const { name } = reveal.target
    if (rootNotes.some(n => n.name === name)) setMode({ type: 'read', name, trail: [] })
    onRevealed()
  })
  const requestNumber = reveal?.n
  useEffect(() => {
    open()
  }, [requestNumber])
}

/** Reads a note's text, then opens its editor. */
function useOpenEditor(pane: Pane): OpenEditor {
  const { setMode, setMessage } = pane
  return (name, trail, from) => {
    void window.app.notes.read(name).then(result => {
      if (result.ok) setMode({ type: 'editNote', name, initial: result.text, trail, from })
      else setMessage(result.message)
    })
  }
}

/** The list's keys: `a` adds, `e` edits the selected note, Enter reads it, the rest move the selection. */
function listKey(e: KeyboardEvent, pane: Pane, openEditor: OpenEditor) {
  const { nav, mode, selected, setMode, setMessage, navigate } = pane
  if (!isPaneKey(e) || mode.type !== 'list') return
  setMessage(undefined)
  if (!nav.search?.active) {
    if (e.key === 'a') {
      e.preventDefault()
      setMode({ type: 'add' })
      return
    }
    if (e.key === 'e') {
      e.preventDefault()
      if (selected) openEditor(selected.note.name, [], 'list')
      return
    }
  }
  const effect = navigate(e)
  if (effect?.type === 'open' && selected) setMode({ type: 'read', name: selected.note.name, trail: [] })
}

function NoteRows({ pane, count }: Readonly<{ pane: Pane; count: number }>) {
  const { nav, visible, selectedIndex, message } = pane
  const now = useNow(AGE_REFRESH_MS)
  return (
    <>
      <SearchLine search={nav.search} />
      {count === 0 && <div className="empty">No notes yet. Press a to add one.</div>}
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
  )
}

type Props = Readonly<{
  /** The open analysis's slug: its citations focus a run, others open a preview. */
  slug: string
  rootNotes: RootNote[]
  noteLists: NoteLists
  runs: Run[]
  /** Makes run `number` the data pane's current (held) run and focuses the pane. */
  onShowRun: (number: number) => void
  /** A universal-search hit: a root note to open in the reader. */
  reveal?: Reveal
  onRevealed: () => void
}>

type ScreenProps = Readonly<{ props: Props; pane: Pane; items: Item[]; openEditor: OpenEditor }>

type ReadMode = Extract<Mode, { type: 'read' }>
type EditMode = Extract<Mode, { type: 'editNote' }>
type NoteScreenProps<M> = Readonly<{ note: RootNote; mode: M; props: Props; pane: Pane }>

function ReaderScreen({ note, mode, props, pane, openEditor }: NoteScreenProps<ReadMode> & Readonly<{ openEditor: OpenEditor }>) {
  const { setMode, cancel } = pane
  return (
    <NoteReader
      key={note.name}
      note={note}
      notes={props.rootNotes}
      slug={props.slug}
      runs={props.runs}
      canGoBack={mode.trail.length > 0}
      onOpen={name => {
        setMode({ type: 'read', name, trail: [...mode.trail, note.name] })
      }}
      onShowRun={props.onShowRun}
      onBack={() => {
        const name = mode.trail.at(-1)
        if (name) setMode({ type: 'read', name, trail: mode.trail.slice(0, -1) })
      }}
      onEdit={() => {
        openEditor(note.name, mode.trail, 'read')
      }}
      onLeave={cancel}
    />
  )
}

function EditorScreen({ note, mode, pane }: Omit<NoteScreenProps<EditMode>, 'props'>) {
  const { setMode, setMessage, cancel } = pane
  const { name, trail } = mode
  return (
    <NoteEditor
      key={note.name}
      note={note}
      initial={mode.initial}
      onLeave={() => {
        if (mode.from === 'read') setMode({ type: 'read', name, trail })
        else cancel()
      }}
      onStale={unsaved => {
        // The reload drops the user's text, so it goes to the clipboard first.
        void copyUnsaved(unsaved).then(setMessage)
        setMode({ type: 'read', name, trail })
      }}
    />
  )
}

function AddScreen({ pane }: Readonly<{ pane: Pane }>) {
  const { setNav, setMessage, cancel } = pane
  return (
    <NoteAdd
      onCancel={cancel}
      onSubmit={(title, text) => {
        void window.app.notes.add(title, text).then(result => {
          if (result.ok) setNav(s => ({ ...s, selected: 0 }))
          else setMessage(result.message)
          cancel()
        })
      }}
    />
  )
}

/** What the tab shows in its mode: the reader, the editor, the add form, or the list (also when the note a mode points at is gone). */
function Screen({ props, pane, items, openEditor }: ScreenProps) {
  const { mode } = pane
  const note = mode.type === 'read' || mode.type === 'editNote' ? props.rootNotes.find(n => n.name === mode.name) : undefined
  if (mode.type === 'read' && note) return <ReaderScreen note={note} mode={mode} props={props} pane={pane} openEditor={openEditor} />
  if (mode.type === 'editNote' && note) return <EditorScreen note={note} mode={mode} pane={pane} />
  if (mode.type === 'add') return <AddScreen pane={pane} />
  return <NoteRows pane={pane} count={items.length} />
}

export function NotesTab(props: Props) {
  const { rootNotes, reveal, onRevealed } = props
  const items = useNoteItems(rootNotes, props.noteLists)
  const { rootRef, ...pane } = useListPane<Item, Mode>({
    items,
    textOf: i => i.note.title,
    targetGone: m => (m.type === 'read' || m.type === 'editNote') && !rootNotes.some(n => n.name === m.name),
    confirmDelete: () => Promise.resolve({ ok: true }),
  })
  useRevealedNote(reveal, rootNotes, pane.setMode, onRevealed)
  const openEditor = useOpenEditor(pane)
  // The reader, the editor and the add form carry the focus target themselves, so Ctrl+2 reaches them rather than the list.
  const ownsFocus = pane.mode.type !== 'list'
  return (
    <div
      className="list"
      tabIndex={-1}
      ref={rootRef}
      {...(ownsFocus ? {} : { 'data-focus-target': '' })}
      onKeyDown={e => {
        listKey(e, pane, openEditor)
      }}
    >
      <Screen props={props} pane={pane} items={items} openEditor={openEditor} />
      {ownsFocus && pane.message && <div className="status warn">{pane.message}</div>}
    </div>
  )
}
