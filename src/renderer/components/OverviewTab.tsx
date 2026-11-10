// The Overview tab (docs/slice-10.md, slice 10a): the analysis overview or its system overview, rendered, with a diff
// against the text the user last marked read.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { hasChanges, lineCount, markdownBlocks, OVERVIEW_LINE_CAP, overviewDiff } from '../../core/overview.ts'
import type { DiffBlock, OverviewDoc, OverviewWhich } from '../../core/overview.ts'
import { noteBlocks } from '../../core/rootNotes.ts'
import type { Segment } from '../../core/rootNotes.ts'
import type { OverviewState } from '../../shared/ipc.ts'
import { MermaidDiagram } from './Mermaid.tsx'
import { isPaneKey } from './common.tsx'

const pad = (n: number) => String(n).padStart(3, '0')

const segmentText = (s: Segment) =>
  s.type === 'text' ? s.text : s.type === 'link' ? (s.label ?? `[[${s.id}]]`) : `[${s.analysis} q ${pad(s.number)}]`

/** One Markdown block, drawn as the note reader draws its blocks. */
function Block({ text }: { text: string }) {
  return (
    <>
      {noteBlocks(text).map((block, i) =>
        block.type === 'code' && block.lang === 'mermaid' ? (
          <MermaidDiagram key={i} text={block.text} />
        ) : block.type === 'code' ? (
          <pre key={i} className="filetext note-code">
            {block.text}
          </pre>
        ) : block.type === 'heading' ? (
          <div key={i} className={`note-heading h${block.level}`}>
            {block.segments.map(segmentText).join('')}
          </div>
        ) : (
          <p key={i} className="note-par">
            {block.segments.map(segmentText).join('')}
          </p>
        ),
      )}
    </>
  )
}

/** What the tab shows for `which`: the document, or why there is none. */
function shown(state: OverviewState, which: OverviewWhich, slug: string): { doc?: OverviewDoc; missing?: string } {
  if (which === 'analysis') return state.analysis ? { doc: state.analysis } : { missing: `No overview yet: analyses/${slug}/overview.md` }
  if (!state.analysis) return { missing: `No overview yet: analyses/${slug}/overview.md` }
  if (!state.system) return { missing: 'No system named: add "System: systems/<name>.md" to overview.md' }
  return state.systemDoc ? { doc: state.systemDoc } : { missing: `No file ${state.system}` }
}

export function OverviewTab(props: { overview: OverviewState; slug: string }) {
  const [which, setWhich] = useState<OverviewWhich>('analysis')
  const [isDiff, setDiff] = useState(false)
  const [flash, setFlash] = useState<string>()
  const root = useRef<HTMLDivElement>(null)
  const { doc, missing } = shown(props.overview, which, props.slug)
  const diff: DiffBlock[] = useMemo(() => (doc ? overviewDiff(doc.baseline, doc.text) : []), [doc?.text, doc?.baseline])
  const isRead = doc !== undefined && doc.baseline === doc.text
  const lines = doc ? lineCount(doc.text) : 0

  useEffect(() => setFlash(undefined), [which, doc?.text])

  function onKeyDown(e: KeyboardEvent) {
    if (!isPaneKey(e)) return
    const scroller = root.current
    if (e.key === 's') setWhich(w => (w === 'analysis' ? 'system' : 'analysis'))
    else if (e.key === 'd') setDiff(on => !on)
    else if (e.key === 'm') {
      if (!doc) return
      void window.app.overview.markRead(which, doc.text).then(result => setFlash(result.ok ? 'Marked read.' : result.message))
    } else if (e.key === 'j') scroller?.scrollBy(0, 40)
    else if (e.key === 'k') scroller?.scrollBy(0, -40)
    else if (e.key === 'g') scroller?.scrollTo(0, 0)
    else if (e.key === 'G') scroller?.scrollTo(0, scroller.scrollHeight)
    else return
    e.preventDefault()
  }

  return (
    <div className="note-reader overview" tabIndex={-1} ref={root} data-focus-target onKeyDown={onKeyDown}>
      <div className="subhead">
        {which === 'analysis' ? 'Analysis' : `System: ${props.overview.system?.replace(/^systems\/|\.md$/g, '') ?? '—'}`}
        {doc && <span className={lines > OVERVIEW_LINE_CAP ? 'overview-lines over' : 'overview-lines dim'}>{` · ${lines} lines`}</span>}
        {isDiff && <span className="dim"> · diff</span>}
        {isRead && <span className="dim"> · read</span>}
        <span className="dim">{'  (s analysis / system, d diff, m mark read)'}</span>
      </div>
      {missing && <div className="status dim">{missing}</div>}
      {doc && (
        <div className="note-body">
          {isDiff && !hasChanges(diff) ? (
            <div className="status dim">No change since you marked it read.</div>
          ) : (
            (isDiff ? diff : markdownBlocks(doc.text).map((text): DiffBlock => ({ kind: 'same', text }))).map((block, i) => (
              <div key={i} className={`overview-block ${block.kind}`}>
                <Block text={block.text} />
              </div>
            ))
          )}
        </div>
      )}
      {flash && <div className="status warn">{flash}</div>}
    </div>
  )
}
