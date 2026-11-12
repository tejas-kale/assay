import { citationKey } from '../../../core/citationLabels.ts'
import { citationText, linkTitle } from '../../../core/notesView.ts'
import type { Block, Segment } from '../../../core/rootNotes.ts'
import type { CitationLabel, RootNote } from '../../../shared/ipc.ts'
import { MermaidDiagram } from '../Mermaid.tsx'

export type NoteBodyContext = {
  notes: readonly RootNote[]
  slug: string
  labels: ReadonlyMap<string, CitationLabel>
  /** Each link or citation segment's place among the note's targets, and the selected place. */
  indices: ReadonlyMap<Segment, number>
  current: number
}

/** A link that no note answers to stays as written. */
function writtenLink(id: string, label: string | undefined): string {
  const suffix = label ? `|${label}` : ''
  return `[[${id}${suffix}]]`
}

function SegmentView({ segment, context }: Readonly<{ segment: Segment; context: NoteBodyContext }>) {
  if (segment.type === 'text') return <span>{segment.text}</span>
  const { notes, slug, labels, indices, current } = context
  const place = (indices.get(segment) ?? -1) === current ? 'target sel' : 'target'
  if (segment.type === 'link') {
    const title = linkTitle(segment.id, notes)
    return (
      <span className={title === undefined ? place : `${place} wikilink`}>
        {title === undefined ? writtenLink(segment.id, segment.label) : (segment.label ?? title)}
      </span>
    )
  }
  const label = labels.get(citationKey(segment))
  return (
    <span className={`${place} citation`}>
      {citationText(segment, slug)}
      {label && <span className={`chip chip-${label}`}>{label}</span>}
    </span>
  )
}

function Segments({ segments, context }: Readonly<{ segments: Segment[]; context: NoteBodyContext }>) {
  return segments.map((segment, i) => <SegmentView key={i} segment={segment} context={context} />)
}

function BlockView({ block, context }: Readonly<{ block: Block; context: NoteBodyContext }>) {
  if (block.type === 'code') {
    if (block.lang === 'mermaid') return <MermaidDiagram text={block.text} />
    return <pre className="filetext note-code">{block.text}</pre>
  }
  if (block.type === 'heading') {
    return (
      <div className={`note-heading h${String(block.level)}`}>
        <Segments segments={block.segments} context={context} />
      </div>
    )
  }
  return (
    <p className="note-par">
      <Segments segments={block.segments} context={context} />
    </p>
  )
}

/** The note's blocks: headings, paragraphs, code and diagrams, with the links and citations drawn as targets. */
export function NoteBody({ blocks, context }: Readonly<{ blocks: readonly Block[]; context: NoteBodyContext }>) {
  return (
    <div className="note-body">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} context={context} />
      ))}
    </div>
  )
}
