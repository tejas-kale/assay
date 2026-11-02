import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { formatAge } from '../../core/age.ts'
import { INITIAL, filterItems, listNav } from '../../core/listNav.ts'
import type { ListNavState } from '../../core/listNav.ts'
import type { FileEntry } from '../../shared/ipc.ts'
import { NAV_KEYS, SearchLine, isPaneKey, useReveal } from './common.tsx'
import type { Reveal } from './common.tsx'
import { Preview } from './Preview.tsx'

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`

const KIND_LABEL = { text: 'nvim', image: 'preview', other: 'open' } as const

/**
 * Every file in the analysis, newest first. `/` searches, Enter opens: text in Neovim (a new
 * Ghostty window), images as a preview here, anything else in its default app. `r` refreshes.
 * Tab shows a preview of the selected file beside the list; J / K scroll it.
 */
export function FilesTab({ refreshKey, reveal, onRevealed }: { refreshKey: unknown; reveal?: Reveal | undefined; onRevealed: () => void }) {
  const [files, setFiles] = useState<FileEntry[]>()
  const [nav, setNav] = useState<ListNavState>(INITIAL)
  const [message, setMessage] = useState<string>()
  const [preview, setPreview] = useState<{ path: string; dataUrl: string }>()
  const [side, setSide] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const sideRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    void window.app.files.list().then(setFiles, err => setMessage(String(err)))
  }, [])
  // Again on every state push (a new query, a note), so new files show without a refresh.
  useEffect(load, [load, refreshKey])

  const visible = filterItems(files ?? [], nav, f => f.path)
  const selectedIndex = Math.max(0, Math.min(nav.selected, visible.length - 1))
  const selected = visible[selectedIndex]
  const images = visible.filter(f => f.kind === 'image')

  useReveal(
    reveal,
    files,
    (file, target) => target.kind === 'file' && target.path === file.path,
    index => {
      setPreview(undefined)
      setNav({ selected: index, search: undefined })
    },
    onRevealed,
  )

  useEffect(() => {
    rootRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, visible.length])

  const openFile = (file: FileEntry) => {
    setMessage(undefined)
    void window.app.files.open(file.path).then(result => {
      if (!result.ok) setMessage(result.message)
      else if (result.how === 'image') setPreview({ path: file.path, dataUrl: result.dataUrl })
      else setMessage(result.how === 'nvim' ? `Opened ${file.path} in Neovim` : `Opened ${file.path}`)
    })
  }

  const step = (delta: number) => {
    if (!preview) return
    const at = images.findIndex(f => f.path === preview.path)
    const next = images[(at + delta + images.length) % images.length]
    if (!next || next.path === preview.path) return
    setNav(s => ({ ...s, selected: visible.indexOf(next) }))
    openFile(next)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!isPaneKey(e)) return
    if (preview) {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') setPreview(undefined)
      else if (e.key === 'j' || e.key === 'l' || e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1)
      else if (e.key === 'k' || e.key === 'h' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1)
      else return
      e.preventDefault()
      return
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      setSide(on => !on)
      return
    }
    if (side && !nav.search?.active && (e.key === 'J' || e.key === 'K')) {
      e.preventDefault()
      sideRef.current?.scrollBy(0, (e.key === 'J' ? 1 : -1) * 120)
      return
    }
    if (side && !nav.search && e.key === 'Escape') {
      e.preventDefault()
      setSide(false)
      return
    }
    if (!nav.search?.active && e.key === 'r') {
      e.preventDefault()
      load()
      return
    }
    const next = listNav(nav, e.key, visible.length)
    if (nav.search?.active || NAV_KEYS.has(e.key)) e.preventDefault()
    setNav(next.state)
    if (next.effect?.type === 'open' && selected) openFile(selected)
  }

  return (
    <div className="list" tabIndex={-1} ref={rootRef} data-focus-target onKeyDown={onKeyDown}>
      {preview ? (
        <div className="image-preview">
          <div className="subhead">
            {preview.path} <span className="dim">(Esc closes, j/k next image)</span>
          </div>
          <img src={preview.dataUrl} alt={preview.path} />
        </div>
      ) : (
        <div className={side ? 'split' : 'split-off'}>
        <div className="split-list">
          <SearchLine search={nav.search} />
          {files === undefined && <div className="empty">Reading the folder…</div>}
          {files?.length === 0 && <div className="empty">No files.</div>}
          <ul role="listbox" aria-label="Files">
            {visible.map((file, i) => (
              <li
                key={file.path}
                role="option"
                aria-selected={i === selectedIndex}
                className={i === selectedIndex ? 'row sel' : 'row'}
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  setNav(s => ({ ...s, selected: i }))
                  rootRef.current?.focus()
                }}
                onDoubleClick={() => openFile(file)}
              >
                <span className="grow file-path">
                  {file.path.includes('/') && <span className="dim">{file.path.slice(0, file.path.lastIndexOf('/') + 1)}</span>}
                  {file.path.slice(file.path.lastIndexOf('/') + 1)}
                </span>
                <span className="dim">{size(file.size)}</span>
                <span className="dim file-age">{formatAge(file.mtimeMs, Date.now())}</span>
                <span className={`chip chip-${file.kind}`}>{KIND_LABEL[file.kind]}</span>
              </li>
            ))}
          </ul>
        </div>
        {side && (
          <Preview source={selected && { type: 'path', path: selected.path }} bodyRef={sideRef} refreshKey={selected?.mtimeMs} />
        )}
        </div>
      )}
      {message && <div className="status">{message}</div>}
    </div>
  )
}
