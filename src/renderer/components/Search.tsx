import { useEffect, useMemo, useRef, useState } from 'react'

import { search, searchEntries } from '../../core/search.ts'
import type { SearchContents, SearchTarget } from '../../core/search.ts'
import type { AnalysisState, FileEntry } from '../../shared/ipc.ts'
import { Preview } from './Preview.tsx'

const KIND_LABEL: Record<SearchTarget['kind'], string> = { thread: 'thread', note: 'note', run: 'run', file: 'file' }

/**
 * Cmd+F: one search over threads, every root note, runs and files. Names match fuzzily; note text and
 * run code match the query as typed. Enter shows the hit in its own tab, Tab toggles a preview.
 */
export function Search(props: {
  state: AnalysisState
  /** False for a hit only a tab that is off could show: such hits are dropped. */
  isShown: (kind: SearchTarget['kind']) => boolean
  onChoose: (target: SearchTarget) => void
  onClose: () => void
}) {
  const { state } = props
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [preview, setPreview] = useState(true)
  const [files, setFiles] = useState<FileEntry[]>()
  const [contents, setContents] = useState<SearchContents>()
  const listRef = useRef<HTMLUListElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.app.files.list().then(setFiles, () => setFiles([]))
    void window.app.searchContents().then(setContents, () => setContents({ notes: [], runs: [] }))
  }, [])

  const entries = useMemo(
    () => searchEntries({ threads: state.threads, notes: state.rootNotes, runs: state.runs, ...(files && { files }), ...(contents && { contents }) }),
    [state, files, contents],
  )
  const { isShown } = props
  const shownEntries = useMemo(() => entries.filter(e => isShown(e.target.kind)), [entries, isShown])
  const hits = useMemo(() => search(shownEntries, query), [shownEntries, query])
  const index = Math.max(0, Math.min(selected, hits.length - 1))
  const hit = hits[index]
  const loading = files === undefined || contents === undefined

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, hits.length])

  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div
        className={preview ? 'palette search with-preview' : 'palette search'}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="search-main">
          <input
            autoFocus
            value={query}
            placeholder="Search threads, notes, runs and files"
            spellCheck={false}
            onChange={e => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing) return
              const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
              const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
              if (down || up) setSelected(Math.max(0, Math.min(index + (down ? 1 : -1), hits.length - 1)))
              else if (e.key === 'Tab') setPreview(p => !p)
              else if (e.ctrlKey && (e.key === 'd' || e.key === 'u')) (previewRef.current?.querySelector('.cm-scroller') ?? previewRef.current)?.scrollBy(0, (e.key === 'd' ? 1 : -1) * 200)
              else if (e.key === 'Enter') {
                if (hit) props.onChoose(hit.entry.target)
              } else if (e.key === 'Escape') props.onClose()
              else return
              e.preventDefault()
            }}
          />
          <ul role="listbox" ref={listRef}>
            {hits.map((h, i) => (
              <li
                key={`${JSON.stringify(h.entry.target)}`}
                role="option"
                aria-selected={i === index}
                className={i === index ? 'row sel' : 'row'}
                onMouseDown={e => e.preventDefault()}
                onClick={() => setSelected(i)}
                onDoubleClick={() => props.onChoose(h.entry.target)}
              >
                <span className={`chip chip-kind`}>{KIND_LABEL[h.entry.target.kind]}</span>
                <span className="grow search-title">
                  {h.entry.title}
                  {h.snippet !== undefined && <span className="dim search-snippet">{h.snippet}</span>}
                </span>
              </li>
            ))}
            {hits.length === 0 && <li className="empty">{loading ? 'Reading the analysis…' : 'Nothing matches'}</li>}
          </ul>
          <div className="hint">Enter show · Tab preview {preview ? 'off' : 'on'} · Ctrl-D / Ctrl-U scroll · Esc close</div>
        </div>
        {preview && <Preview source={hit?.entry.preview} find={hit?.snippet !== undefined ? query.trim() : undefined} bodyRef={previewRef} />}
      </div>
    </div>
  )
}
