import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { formatAge } from '../../core/age.ts'
import { isMermaidFile } from '../../core/files.ts'
import { THEMES } from '../../core/theme.ts'
import { currentMode } from '../appearance.ts'
import { renderMermaid } from './Mermaid.tsx'
import { INITIAL, filterItems, listNav } from '../../core/listNav.ts'
import type { ListNavState } from '../../core/listNav.ts'
import type { FileEntry } from '../../shared/ipc.ts'
import { NAV_KEYS, SearchLine, isPaneKey, useReveal } from './common.tsx'
import type { Reveal } from './common.tsx'
import { PreviewPopup } from './Preview.tsx'
import type { PreviewSource } from '../../core/search.ts'

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`

const KIND_LABEL = { text: 'nvim', image: 'preview', other: 'open' } as const
const chipLabel = (file: FileEntry) => (file.kind === 'text' && isMermaidFile(file.path) ? 'browser' : KIND_LABEL[file.kind])

/**
 * Every file in the analysis, newest first. `/` searches, Enter opens: text in Neovim (a new
 * Ghostty window), images as a preview here, anything else in its default app. `r` refreshes.
 * Tab opens the selected file in a pop-up preview, with the cursor in it.
 */
export function FilesTab({ refreshKey, reveal, onRevealed }: { refreshKey: unknown; reveal?: Reveal | undefined; onRevealed: () => void }) {
  const [files, setFiles] = useState<FileEntry[]>()
  const [nav, setNav] = useState<ListNavState>(INITIAL)
  const [message, setMessage] = useState<string>()
  const [preview, setPreview] = useState<{ path: string; dataUrl: string }>()
  const [popup, setPopup] = useState<PreviewSource>()
  const rootRef = useRef<HTMLDivElement>(null)

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

  /** A Mermaid file: read it, draw it here, and open the chart as a page in the browser. */
  const openChart = async (file: FileEntry) => {
    const read = await window.app.files.preview(file.path)
    if (!read.ok || read.kind !== 'text') return setMessage(read.ok ? 'Not a text file' : read.message)
    const mode = currentMode()
    const drawn = await renderMermaid(read.text, mode)
    if ('error' in drawn) return setMessage(`Mermaid could not draw ${file.path}: ${drawn.error.split('\n')[0]}`)
    const { bg, text } = THEMES[mode].ui
    const result = await window.app.files.openChart(file.path, drawn.svg, { bg, text })
    setMessage(result.ok ? `Opened the chart of ${file.path} in your browser` : result.message)
  }

  const openFile = (file: FileEntry) => {
    setMessage(undefined)
    if (file.kind === 'text' && isMermaidFile(file.path)) {
      void openChart(file)
      return
    }
    void window.app.files.open(file.path).then(result => {
      if (!result.ok) setMessage(result.message)
      else if (result.how === 'image') setPreview({ path: file.path, dataUrl: result.dataUrl })
      else setMessage(result.how === 'nvim' ? `Opened ${file.path} in Neovim` : result.how === 'browser' ? `Opened the chart of ${file.path} in your browser` : `Opened ${file.path}`)
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
      if (selected) setPopup({ type: 'path', path: selected.path })
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
        <>
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
                <span className={`chip chip-${file.kind}`}>{chipLabel(file)}</span>
              </li>
            ))}
          </ul>
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
      {message && <div className="status">{message}</div>}
    </div>
  )
}
