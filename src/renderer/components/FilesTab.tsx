import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react'

import { formatAge } from '../../core/age.ts'
import { openedMessage, previewKey, splitPath, stepImage, chipLabel } from '../../core/filesView.ts'
import { fileSize } from '../../core/previewView.ts'
import { isMermaidFile } from '../../core/files.ts'
import { INITIAL, filterItems, listNav } from '../../core/listNav.ts'
import type { ListNavState } from '../../core/listNav.ts'
import type { PreviewSource } from '../../core/search.ts'
import { THEMES } from '../../core/theme.ts'
import type { FileEntry } from '../../shared/ipc.ts'
import { currentMode } from '../appearance.ts'
import { NAV_KEYS, SearchLine, isPaneKey, useReveal } from './common.tsx'
import type { Reveal } from './common.tsx'
import { renderMermaid } from './Mermaid.tsx'
import { PreviewPopup } from './Preview.tsx'
import { AGE_REFRESH_MS, useNow } from './useNow.ts'

type Props = Readonly<{ refreshKey: unknown; reveal?: Reveal; onRevealed: () => void }>
type ImageShown = { path: string; dataUrl: string }
type Say = (text: string | undefined) => void

/** The file list, read again on every state push (a new query, a note) so new files show without a refresh. */
function useFileList(refreshKey: unknown, say: Say) {
  const [listing, setListing] = useState<FileEntry[]>()
  const load = useCallback(() => {
    void window.app.files.list().then(
      files => {
        setListing(files)
      },
      (err: unknown) => {
        say(String(err))
      },
    )
  }, [say])
  useEffect(load, [load, refreshKey])
  return { files: listing, load }
}

/** A Mermaid file: read it, draw it here, and open the chart as a page in the browser. */
async function openChart(file: FileEntry, say: Say) {
  const read = await window.app.files.preview(file.path)
  if (!read.ok || read.kind !== 'text') {
    say(read.ok ? 'Not a text file' : read.message)
    return
  }
  const mode = currentMode()
  const drawn = await renderMermaid(read.text, mode)
  if ('error' in drawn) {
    say(`Mermaid could not draw ${file.path}: ${drawn.error.split('\n')[0] ?? ''}`)
    return
  }
  const { bg, text } = THEMES[mode].ui
  const result = await window.app.files.openChart(file.path, drawn.svg, { bg, text })
  say(result.ok ? openedMessage('browser', file.path) : result.message)
}

/** Opens a file as its chip says; an image comes back through `showImage`. */
function openFile(file: FileEntry, say: Say, showImage: (image: ImageShown) => void) {
  say(undefined)
  if (file.kind === 'text' && isMermaidFile(file.path)) {
    void openChart(file, say)
    return
  }
  void window.app.files.open(file.path).then(result => {
    if (!result.ok) say(result.message)
    else if (result.how === 'image') showImage({ path: file.path, dataUrl: result.dataUrl })
    else say(openedMessage(result.how, file.path))
  })
}

function FileRow(props: Readonly<{ file: FileEntry; selected: boolean; now: number; onSelect: () => void; onOpen: () => void }>) {
  const { file, selected } = props
  const { folder, name } = splitPath(file.path)
  return (
    <li
      role="option"
      aria-selected={selected}
      className={selected ? 'row sel' : 'row'}
      onMouseDown={e => { e.preventDefault() }}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
    >
      <span className="grow file-path">
        {folder !== '' && <span className="dim">{folder}</span>}
        {name}
      </span>
      <span className="dim">{fileSize(file.size)}</span>
      <span className="dim file-age">{formatAge(file.mtimeMs, props.now)}</span>
      <span className={`chip chip-${file.kind}`}>{chipLabel(file)}</span>
    </li>
  )
}

/** A search hit on a file selects it, and closes an image preview. */
function useRevealedFile(args: { reveal: Reveal | undefined; files: FileEntry[] | undefined; setPreview: (shown: undefined) => void; setNav: Dispatch<SetStateAction<ListNavState>>; onRevealed: () => void }) {
  const { setPreview, setNav } = args
  useReveal(args.reveal, args.files, {
    matches: (file, target) => target.kind === 'file' && target.path === file.path,
    apply: index => {
      setPreview(undefined)
      setNav({ selected: index, search: undefined })
    },
    onDone: args.onRevealed,
  })
}

type Nav = { nav: ListNavState; setNav: Dispatch<SetStateAction<ListNavState>> }
type KeyArgs = Nav & {
  visible: FileEntry[]
  selected: FileEntry | undefined
  preview: ImageShown | undefined
  setPopup: (source: PreviewSource) => void
  open: (file: FileEntry) => void
  load: () => void
  closePreview: () => void
}

/** Keys: while an image shows, close it or step among the images; otherwise the list's keys, Tab, `r` and Enter. */
function useFilesKeys(args: KeyArgs) {
  const { nav, setNav, visible, selected, preview, open } = args

  function stepPreview(shown: ImageShown, delta: 1 | -1) {
    const next = stepImage(visible.filter(f => f.kind === 'image'), shown.path, delta)
    if (!next) return
    setNav(s => ({ ...s, selected: visible.indexOf(next) }))
    open(next)
  }

  function onPreviewKey(e: KeyboardEvent, shown: ImageShown) {
    const key = previewKey(e.key)
    if (key === undefined) return
    if (key === 'close') args.closePreview()
    else stepPreview(shown, key === 'next' ? 1 : -1)
    e.preventDefault()
  }

  return (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    if (preview) {
      onPreviewKey(e, preview)
      return
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      if (selected) args.setPopup({ type: 'path', path: selected.path })
      return
    }
    if (!nav.search?.active && e.key === 'r') {
      e.preventDefault()
      args.load()
      return
    }
    const next = listNav(nav, e.key, visible.length)
    if (nav.search?.active || NAV_KEYS.has(e.key)) e.preventDefault()
    setNav(next.state)
    if (next.effect?.type === 'open' && selected) open(selected)
  }
}

function FileList(props: Readonly<{ files: FileEntry[] | undefined; visible: FileEntry[]; search: ListNavState['search']; selectedIndex: number; now: number; onSelect: (i: number) => void; onOpen: (file: FileEntry) => void }>) {
  const { files } = props
  return (
    <>
      <SearchLine search={props.search} />
      {files === undefined && <div className="empty">Reading the folder…</div>}
      {files?.length === 0 && <div className="empty">No files.</div>}
      <ul role="listbox" aria-label="Files">
        {props.visible.map((file, i) => (
          <FileRow
            key={file.path}
            file={file}
            selected={i === props.selectedIndex}
            now={props.now}
            onSelect={() => { props.onSelect(i) }}
            onOpen={() => { props.onOpen(file) }}
          />
        ))}
      </ul>
    </>
  )
}

function ImagePreview({ preview }: Readonly<{ preview: ImageShown }>) {
  return (
    <div className="image-preview">
      <div className="subhead">
        {preview.path} <span className="dim">(Esc closes, j/k next image)</span>
      </div>
      <img src={preview.dataUrl} alt={preview.path} />
    </div>
  )
}

/**
 * Every file in the analysis, newest first. `/` searches, Enter opens: text in Neovim (a new
 * Ghostty window), images as a preview here, anything else in its default app. `r` refreshes.
 * Tab opens the selected file in a pop-up preview, with the cursor in it.
 */
export function FilesTab({ refreshKey, reveal, onRevealed }: Props) {
  const [nav, setNav] = useState<ListNavState>(INITIAL)
  const [message, setMessage] = useState<string>()
  const [preview, setPreview] = useState<ImageShown>()
  const [popup, setPopup] = useState<PreviewSource>()
  const rootRef = useRef<HTMLDivElement>(null)
  const { files, load } = useFileList(refreshKey, setMessage)
  const now = useNow(AGE_REFRESH_MS)

  const visible = filterItems(files ?? [], nav, f => f.path)
  const selectedIndex = Math.max(0, Math.min(nav.selected, visible.length - 1))
  useRevealedFile({ reveal, files, setPreview, setNav, onRevealed })
  useEffect(() => {
    rootRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, visible.length])

  const open = (file: FileEntry) => { openFile(file, setMessage, setPreview) }
  const onKeyDown = useFilesKeys({ nav, setNav, visible, selected: visible[selectedIndex], preview, setPopup, open, load, closePreview: () => { setPreview(undefined) } })
  const select = (i: number) => {
    setNav(s => ({ ...s, selected: i }))
    rootRef.current?.focus()
  }

  return (
    <div className="list" tabIndex={-1} ref={rootRef} data-focus-target onKeyDown={onKeyDown}>
      {preview ? (
        <ImagePreview preview={preview} />
      ) : (
        <FileList files={files} visible={visible} search={nav.search} selectedIndex={selectedIndex} now={now} onSelect={select} onOpen={open} />
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
      {message && <div className="status">{message}</div>}
    </div>
  )
}
