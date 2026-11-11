// A query's lineage: the CTE graph `python -m analysis_sql lineage` prints and the server saves next to the run as
// `queries/NNN.lineage.json` (docs/slice-9.md, slice 9b). Pure: parsing that file and drawing it as Mermaid text.
import { codeBody } from './runs.ts'
import { stepMarks } from './steps.ts'
import type { StepsFile } from './steps.ts'

export type Cardinality = '1:1' | '1:many' | 'many:1' | 'many:many'
export type LineageNode = {
  id: string
  kind: 'table' | 'cte' | 'final'
  name: string
  grain?: string[]
  /** The trusted block this CTE includes (docs/slice-10.md): drawn as one node, without the tables inside it. */
  block?: string
}
/** `join` is absent for a FROM source or a subquery's; `{}` for a JOIN with no (well-formed) `-- join:` line. */
export type LineageEdge = { from: string; to: string; join?: { cardinality?: Cardinality; keys?: string[] } }
export type Lineage = { nodes: LineageNode[]; edges: LineageEdge[]; note?: string }
export type LineageFile = Lineage | { error: string }

const KINDS = ['table', 'cte', 'final']
const CARDINALITIES = ['1:1', '1:many', 'many:1', 'many:many']

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null && !Array.isArray(v)
const field = (v: object, key: string): unknown => Reflect.get(v, key)
const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).filter((s): s is string => typeof s === 'string') : [])

function parseNode(raw: unknown): LineageNode[] {
  if (!isObject(raw)) return []
  const id = field(raw, 'id')
  const kind = field(raw, 'kind')
  const name = field(raw, 'name')
  if (typeof id !== 'string' || typeof name !== 'string' || typeof kind !== 'string' || !KINDS.includes(kind)) return []
  const grain = field(raw, 'grain')
  const block = field(raw, 'block')
  return [{ id, kind: kind as LineageNode['kind'], name, ...(Array.isArray(grain) && { grain: strings(grain) }), ...(typeof block === 'string' && block && { block }) }]
}

function parseEdge(raw: unknown, ids: ReadonlySet<string>): LineageEdge[] {
  if (!isObject(raw)) return []
  const from = field(raw, 'from')
  const to = field(raw, 'to')
  if (typeof from !== 'string' || typeof to !== 'string' || !ids.has(from) || !ids.has(to)) return []
  const join = field(raw, 'join')
  if (!isObject(join)) return [{ from, to }]
  const cardinality = field(join, 'cardinality')
  // A join without a readable cardinality is a join with no line.
  if (typeof cardinality !== 'string' || !CARDINALITIES.includes(cardinality)) return [{ from, to, join: {} }]
  return [{ from, to, join: { cardinality: cardinality as Cardinality, keys: strings(field(join, 'keys')) } }]
}

/** Reads `NNN.lineage.json` safely: malformed nodes and edges are dropped; undefined when it is neither a lineage nor an error. */
export function parseLineage(text: string): LineageFile | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(raw)) return undefined
  const error = field(raw, 'error')
  if (typeof error === 'string') return { error }
  const nodes = field(raw, 'nodes')
  const edges = field(raw, 'edges')
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return undefined
  const kept = (nodes as unknown[]).flatMap(parseNode)
  const ids = new Set(kept.map(node => node.id))
  const note = field(raw, 'note')
  return { nodes: kept, edges: (edges as unknown[]).flatMap(edge => parseEdge(edge, ids)), ...(typeof note === 'string' && { note }) }
}

/** Whether there is anything to draw: a CTE or a JOIN. One table read plainly is not a diagram. */
export const hasStructure = (lineage: Lineage) => lineage.nodes.some(node => node.kind === 'cte') || lineage.edges.some(edge => edge.join !== undefined)

/** How a step went (slice 9c); marks colour the nodes. */
export type LineageMark = 'ok' | 'bad' | 'running' | 'skipped'
export type MarkColors = { good: string; bad: string; dim: string }

const quote = (text: string) => `"${text.replaceAll('"', '#quot;')}"`

function label(node: LineageNode): string {
  const grain = node.grain === undefined || node.kind === 'table' ? [] : [node.grain.length === 0 ? 'grain: one row' : `grain: ${node.grain.join(', ')}`]
  return quote([node.name, ...(node.block ? [`block ${node.block}`] : []), ...grain].join('<br/>'))
}

function edgeLabel(edge: LineageEdge): string | undefined {
  if (edge.join === undefined) return undefined
  return edge.join.cardinality === undefined ? 'join: no line' : `${edge.join.cardinality} on ${(edge.join.keys ?? []).join(', ')}`.trim()
}

const nodeId = (index: number) => `n${String(index)}`

function nodeLine(node: LineageNode, index: number): string {
  const id = nodeId(index)
  if (node.kind === 'table') return `  ${id}([${label(node)}])`
  return node.block ? `  ${id}[[${label(node)}]]` : `  ${id}[${label(node)}]`
}

/**
 * The Mermaid text of a lineage. Node ids are `n0`, `n1`, ... by position, never the table or CTE name, so no name
 * can break the syntax. `marks` maps a node's index to how it went, drawn in `colors`.
 */
export function lineageMermaid(lineage: Lineage, marks: Readonly<Record<number, LineageMark>> = {}, colors: MarkColors = { good: '#2e9e5b', bad: '#d95757', dim: '#828e9f' }): string {
  const index = new Map(lineage.nodes.map((node, i) => [node.id, i]))
  const lines = ['flowchart LR']
  // Tables are stadiums, an included block a subroutine box, other CTEs and the final SELECT boxes.
  lineage.nodes.forEach((node, i) => lines.push(nodeLine(node, i)))
  for (const edge of lineage.edges) {
    const from = index.get(edge.from)
    const to = index.get(edge.to)
    if (from === undefined || to === undefined) continue
    const text = edgeLabel(edge)
    lines.push(text === undefined ? `  ${nodeId(from)} --> ${nodeId(to)}` : `  ${nodeId(from)} -->|${quote(text)}| ${nodeId(to)}`)
  }
  const used = new Set(Object.values(marks))
  const styles: Record<LineageMark, string> = {
    ok: `stroke:${colors.good},stroke-width:2px`,
    bad: `stroke:${colors.bad},stroke-width:2px,fill:${colors.bad}33`,
    running: `stroke:${colors.dim},stroke-width:2px,stroke-dasharray:4 3`,
    skipped: `stroke:${colors.dim},color:${colors.dim},opacity:0.6`,
  }
  for (const mark of Object.keys(styles) as LineageMark[]) if (used.has(mark)) lines.push(`  classDef ${mark} ${styles[mark]}`)
  for (const [i, mark] of Object.entries(marks)) if (Number(i) < lineage.nodes.length) lines.push(`  class ${nodeId(Number(i))} ${mark}`)
  return lines.join('\n')
}

/** The node a click landed on: mermaid names a flowchart node's element `flowchart-<our id>-<n>`; our ids are `n0`, `n1`, ... */
export function mermaidNodeIndex(elementId: string): number | undefined {
  const match = /^flowchart-n(\d+)-\d+$/.exec(elementId)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

export const NOT_SQL = 'Steps reads SQL runs.'
export const NOTHING_TO_DRAW = 'One table, no CTE: nothing to draw.'

/** What the Steps tab shows for a run. `reading` means the lineage is not there yet: the tab asks for it. */
export type StepsView =
  | { kind: 'message'; text: string; note?: string }
  | { kind: 'reading' }
  | { kind: 'error'; error: string }
  | { kind: 'diagram'; lineage: Lineage; note?: string; plan?: StepsFile; marks?: Record<number, LineageMark> }

type RunInfo = { language?: 'sql' | 'python'; trusted?: string }

/** A Python run, or a trusted run whose body is `-- python:`: not SQL, so nothing to step through. */
const readsNoSql = (run: RunInfo, code: string | undefined) => run.language === 'python' || (run.trusted !== undefined && /^-- python:/m.test(codeBody(code ?? '', 'sql')))

/**
 * What the Steps tab shows. `code` is the run's saved file; `plan` is `NNN.steps.json` (slice 9c), which adds each
 * step's status and the marks that colour the diagram.
 */
export function stepsView(run: RunInfo, code: string | undefined, lineage: LineageFile | undefined, plan?: StepsFile): StepsView {
  if (readsNoSql(run, code)) return { kind: 'message', text: NOT_SQL }
  if (lineage === undefined) return { kind: 'reading' }
  if ('error' in lineage) return { kind: 'error', error: lineage.error }
  const notes = [lineage.note, plan?.note].filter((text): text is string => text !== undefined).join(' ')
  const note = notes === '' ? {} : { note: notes }
  if (!hasStructure(lineage)) return { kind: 'message', text: NOTHING_TO_DRAW, ...note }
  return plan && plan.steps.length > 0 ? { kind: 'diagram', lineage, ...note, plan, marks: stepMarks(plan.steps) } : { kind: 'diagram', lineage, ...note }
}

/**
 * The request the Steps tab should send for a run, once per run per window: `steps` when no `NNN.steps.json` exists; a
 * trusted run is read for its lineage only (its arguments are not replayed). Nothing for a run that is not SQL.
 */
export function stepsRequest(run: RunInfo, code: string | undefined, lineage: LineageFile | undefined, plan: StepsFile | undefined): 'steps' | 'lineage' | undefined {
  if (readsNoSql(run, code) || plan !== undefined) return undefined
  if (run.trusted !== undefined) return lineage === undefined ? 'lineage' : undefined
  return 'steps'
}
