import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react'

import { searchKey } from '../../core/searchKey.ts'
import { search, searchEntries } from '../../core/search.ts'
import type { SearchContents, SearchHit, SearchTarget } from '../../core/search.ts'
import type { AnalysisState, FileEntry } from '../../shared/ipc.ts'
import { Preview } from './Preview.tsx'

const KIND_LABEL: Record<SearchTarget['kind'], string> = { thread: 'thread', note: 'note', run: 'run', file: 'file' }
const SCROLL_STEP = 200

type Props = Readonly<{
  state: AnalysisState
  /** False for a hit only a tab that is off could show: such hits are dropped. */
  isShown: (kind: SearchTarget['kind']) => boolean
  onChoose: (target: SearchTarget) => void
  onClose: () => void
}>

/** The hits for `query`; `loading` until the file list and the note and run text have arrived. */
function useHits(props: Pick<Props, 'state' | 'isShown'>, query: string) {
  const { state, isShown } = props
  const [files, setFiles] = useState<FileEntry[]>()
  const [contents, setContents] = useState<SearchContents>()

  useEffect(() => {
    void window.app.files.list().then(setFiles, () => { setFiles([]) })
    void window.app.searchContents().then(setContents, () => { setContents({ notes: [], runs: [] }) })
  }, [])

  const entries = useMemo(
    () => searchEntries({ threads: state.threads, notes: state.rootNotes, runs: state.runs, ...(files && { files }), ...(contents && { contents }) }),
    [state, files, contents],
  )
  const shownEntries = useMemo(() => entries.filter(e => isShown(e.target.kind)), [entries, isShown])
  const hits = useMemo(() => search(shownEntries, query), [shownEntries, query])
  return { hits, loading: files === undefined || contents === undefined }
}

function HitRows(props: Readonly<{ hits: SearchHit[]; index: number; loading: boolean; onSelect: (i: number) => void; onChoose: Props['onChoose'] }>) {
  const { hits, index } = props
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, hits.length])

  return (
    <ul role="listbox" ref={listRef}>
      {hits.map((h, i) => (
        <li
          key={JSON.stringify(h.entry.target)}
          role="option"
          aria-selected={i === index}
          className={i === index ? 'row sel' : 'row'}
          onMouseDown={e => { e.preventDefault() }}
          onClick={() => { props.onSelect(i) }}
          onDoubleClick={() => { props.onChoose(h.entry.target) }}
        >
          <span className="chip chip-kind">{KIND_LABEL[h.entry.target.kind]}</span>
          <span className="grow search-title">
            {h.entry.title}
            {h.snippet !== undefined && <span className="dim search-snippet">{h.snippet}</span>}
          </span>
        </li>
      ))}
      {hits.length === 0 && <li className="empty">{props.loading ? 'Reading the analysis…' : 'Nothing matches'}</li>}
    </ul>
  )
}

type KeyArgs = {
  hits: SearchHit[]
  index: number
  setSelected: (index: number) => void
  setPreview: Dispatch<SetStateAction<boolean>>
  previewRef: RefObject<HTMLDivElement | null>
  onChoose: Props['onChoose']
  onClose: () => void
}

/** Keys in the search box: move among the hits, toggle and scroll the preview, show the hit, close. */
function useSearchKeys(args: KeyArgs) {
  const { hits, index, previewRef } = args
  const moveTo = (to: number) => { args.setSelected(Math.max(0, Math.min(to, hits.length - 1))) }

  function scrollPreview(direction: 1 | -1) {
    const scroller = previewRef.current?.querySelector('.cm-scroller') ?? previewRef.current
    scroller?.scrollBy(0, direction * SCROLL_STEP)
  }

  return (e: KeyboardEvent) => {
    const key = searchKey(e.key, e.ctrlKey, e.nativeEvent.isComposing)
    if (key === undefined) return
    if (key === 'next') moveTo(index + 1)
    else if (key === 'previous') moveTo(index - 1)
    else if (key === 'togglePreview') args.setPreview(p => !p)
    else if (key === 'scrollDown') scrollPreview(1)
    else if (key === 'scrollUp') scrollPreview(-1)
    else if (key === 'confirm') {
      const hit = hits[index]
      if (hit) args.onChoose(hit.entry.target)
    } else args.onClose()
    e.preventDefault()
  }
}

/**
 * Cmd+F: one search over threads, every root note, runs and files. Names match fuzzily; note text and
 * run code match the query as typed. Enter shows the hit in its own tab, Tab toggles a preview.
 */
export function Search(props: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [preview, setPreview] = useState(true)
  const previewRef = useRef<HTMLDivElement>(null)
  const { hits, loading } = useHits(props, query)
  const index = Math.max(0, Math.min(selected, hits.length - 1))
  const hit = hits[index]

  const onKeyDown = useSearchKeys({ hits, index, setSelected, setPreview, previewRef, onChoose: props.onChoose, onClose: props.onClose })

  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div
        className={preview ? 'palette search with-preview' : 'palette search'}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={e => { e.stopPropagation() }}
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
            onKeyDown={onKeyDown}
          />
          <HitRows hits={hits} index={index} loading={loading} onSelect={setSelected} onChoose={props.onChoose} />
          <div className="hint">Enter show · Tab preview {preview ? 'off' : 'on'} · Ctrl-D / Ctrl-U scroll · Esc close</div>
        </div>
        {preview && <Preview source={hit?.entry.preview} find={hit?.snippet !== undefined ? query.trim() : undefined} bodyRef={previewRef} />}
      </div>
    </div>
  )
}
