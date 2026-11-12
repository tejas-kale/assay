// The Overview tab (docs/slice-10.md, slice 10a): the analysis overview or its system overview, rendered, with a diff
// against the text the user last marked read.
import { useMemo, useRef, useState } from 'react'
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react'

import { hasChanges, lineCount, markdownBlocks, OVERVIEW_LINE_CAP, overviewDiff } from '../../core/overview.ts'
import type { DiffBlock, OverviewDoc, OverviewWhich } from '../../core/overview.ts'
import { overviewHeading, overviewKey, overviewShown, segmentText } from '../../core/overviewView.ts'
import { noteBlocks } from '../../core/rootNotes.ts'
import type { Block as NoteBlock } from '../../core/rootNotes.ts'
import type { OverviewState } from '../../shared/ipc.ts'
import { MermaidDiagram } from './Mermaid.tsx'
import { isPaneKey } from './common.tsx'

const SCROLL_STEP = 40

function NoteBlockView({ block }: Readonly<{ block: NoteBlock }>) {
  if (block.type === 'code') {
    if (block.lang === 'mermaid') return <MermaidDiagram text={block.text} />
    return <pre className="filetext note-code">{block.text}</pre>
  }
  const text = block.segments.map(segmentText).join('')
  if (block.type === 'heading') return <div className={`note-heading h${String(block.level)}`}>{text}</div>
  return <p className="note-par">{text}</p>
}

/** One Markdown block, drawn as the note reader draws its blocks. */
function Block({ text }: Readonly<{ text: string }>) {
  return (
    <>
      {noteBlocks(text).map((block, i) => (
        <NoteBlockView key={i} block={block} />
      ))}
    </>
  )
}

function DocBody(props: Readonly<{ doc: OverviewDoc; isDiff: boolean; diff: DiffBlock[] }>) {
  const { doc, isDiff, diff } = props
  if (isDiff && !hasChanges(diff)) return <div className="status dim">No change since you marked it read.</div>
  const blocks = isDiff ? diff : markdownBlocks(doc.text).map((text): DiffBlock => ({ kind: 'same', text }))
  return (
    <>
      {blocks.map((block, i) => (
        <div key={i} className={`overview-block ${block.kind}`}>
          <Block text={block.text} />
        </div>
      ))}
    </>
  )
}

/** The note after "Mark read", kept for the document and side it was made for. */
function useFlash(which: OverviewWhich, text: string | undefined) {
  const [flash, setFlash] = useState<{ which: OverviewWhich; text: string | undefined; message: string }>()
  const current = flash?.which === which && flash.text === text ? flash.message : undefined
  return [current, (message: string) => { setFlash({ which, text, message }) }] as const
}

type KeyArgs = {
  root: RefObject<HTMLDivElement | null>
  doc: OverviewDoc | undefined
  which: OverviewWhich
  setWhich: Dispatch<SetStateAction<OverviewWhich>>
  setDiff: Dispatch<SetStateAction<boolean>>
  setFlash: (message: string) => void
}

/** Keys: switch between the analysis and its system, the diff, Mark read, and scrolling. */
function useOverviewKeys({ root, doc, which, setWhich, setDiff, setFlash }: KeyArgs) {
  return (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    const key = overviewKey(e.key)
    if (key === undefined) return
    const scroller = root.current
    if (key === 'toggleWhich') setWhich(w => (w === 'analysis' ? 'system' : 'analysis'))
    else if (key === 'toggleDiff') setDiff(on => !on)
    else if (key === 'markRead') {
      if (!doc) return
      void window.app.overview.markRead(which, doc.text).then(result => { setFlash(result.ok ? 'Marked read.' : result.message) })
    } else if (key === 'down') scroller?.scrollBy(0, SCROLL_STEP)
    else if (key === 'up') scroller?.scrollBy(0, -SCROLL_STEP)
    else if (key === 'top') scroller?.scrollTo(0, 0)
    else scroller?.scrollTo(0, scroller.scrollHeight)
    e.preventDefault()
  }
}

export function OverviewTab(props: Readonly<{ overview: OverviewState; slug: string }>) {
  const [which, setWhich] = useState<OverviewWhich>('analysis')
  const [isDiff, setDiff] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const { doc, missing } = overviewShown(props.overview, which, props.slug)
  const [flash, setFlash] = useFlash(which, doc?.text)
  const text = doc?.text
  const baseline = doc?.baseline
  const diff = useMemo(() => (text === undefined ? [] : overviewDiff(baseline, text)), [text, baseline])
  const lines = text === undefined ? 0 : lineCount(text)

  const onKeyDown = useOverviewKeys({ root, doc, which, setWhich, setDiff, setFlash })

  return (
    <div className="note-reader overview" tabIndex={-1} ref={root} data-focus-target onKeyDown={onKeyDown}>
      <div className="subhead">
        {overviewHeading(which, props.overview.system)}
        {doc && <span className={lines > OVERVIEW_LINE_CAP ? 'overview-lines over' : 'overview-lines dim'}>{` · ${String(lines)} lines`}</span>}
        {isDiff && <span className="dim"> · diff</span>}
        {doc !== undefined && doc.baseline === doc.text && <span className="dim"> · read</span>}
        <span className="dim">{'  (s analysis / system, d diff, m mark read)'}</span>
      </div>
      {missing && <div className="status dim">{missing}</div>}
      {doc && (
        <div className="note-body">
          <DocBody doc={doc} isDiff={isDiff} diff={diff} />
        </div>
      )}
      {flash && <div className="status warn">{flash}</div>}
    </div>
  )
}
