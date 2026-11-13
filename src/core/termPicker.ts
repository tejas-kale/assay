// The terminal picker behind `assay open`: what a key does and what the screen shows. src/cli reads keys and draws.
import type { Choice } from './open.ts'
import { pickerView } from './picker.ts'
import { slugify } from './rootNotes.ts'

export type TermPickerState = { query: string; selected: number }
/** A key as Node's readline `keypress` event describes it. */
export type TermKey = { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }
export type TermPickerEffect = { do: 'open'; name: string } | { do: 'create'; title: string } | { do: 'cancel' }
type Row = { kind: 'open'; choice: Choice } | { kind: 'create'; title: string }
type Step = { state: TermPickerState; effect?: TermPickerEffect }

/**
 * The fuzzy matches, best first, as the app's picker ranks them, then a row creating the typed title unless an
 * analysis already has it in any case.
 */
export function pickerRows(analyses: readonly Choice[], query: string): Row[] {
  const view = pickerView(analyses.map(a => ({ ...a, path: a.name })), query)
  const rows: Row[] = view.ranked.map(({ name, title }) => ({ kind: 'open', choice: { name, title } }))
  const taken = analyses.some(a => a.title.toLowerCase() === view.title.toLowerCase())
  return view.title !== '' && !taken ? [...rows, { kind: 'create', title: view.title }] : rows
}

const clamp = (selected: number, count: number) => Math.max(0, Math.min(selected, count - 1))
const typedText = (query: string): TermPickerState => ({ query, selected: 0 })

function chosen(row: Row | undefined): TermPickerEffect | undefined {
  if (!row) return undefined
  return row.kind === 'open' ? { do: 'open', name: row.choice.name } : { do: 'create', title: row.title }
}

/** Keys that edit the query; undefined for any other key. */
function edited(query: string, key: TermKey): TermPickerState | undefined {
  if (key.name === 'backspace') return typedText(query.slice(0, -1))
  if (key.ctrl && key.name === 'u') return typedText('')
  if (key.ctrl && key.name === 'w') {
    const trimmed = query.trimEnd()
    return typedText(trimmed.slice(0, trimmed.lastIndexOf(' ') + 1))
  }
  const text = key.sequence ?? ''
  // One printable character; control keys and escape sequences type nothing.
  if (!key.ctrl && !key.meta && text.length === 1 && text >= ' ' && text !== '\x7f') return typedText(query + text)
  return undefined
}

function moved(key: TermKey): number | undefined {
  if (key.name === 'up' || (key.ctrl && key.name === 'p')) return -1
  if (key.name === 'down' || (key.ctrl && key.name === 'n')) return 1
  return undefined
}

const cancels = (key: TermKey, query: string) =>
  key.name === 'escape' || (key.ctrl && key.name === 'c') || (key.ctrl && key.name === 'd' && query === '')

/** One key: move, edit the query, open the selected analysis, create the typed title, or cancel. */
export function pickerStep(analyses: readonly Choice[], state: TermPickerState, key: TermKey): Step {
  const rows = pickerRows(analyses, state.query)
  const selected = clamp(state.selected, rows.length)
  if (cancels(key, state.query)) return { state, effect: { do: 'cancel' } }
  if (key.name === 'return' || key.name === 'enter') {
    const effect = chosen(rows[selected])
    return effect ? { state: { ...state, selected }, effect } : { state: { ...state, selected } }
  }
  const step = moved(key)
  if (step !== undefined) return { state: { ...state, selected: clamp(selected + step, rows.length) } }
  return { state: edited(state.query, key) ?? { ...state, selected } }
}

const INVERSE = '\x1b[7m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const PROMPT = 'Open analysis: '
const HINT = '↑↓ move · Enter open · Esc cancel'

const fit = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text)

function rowLine(row: Row, isSelected: boolean, width: number): string {
  const marker = isSelected ? '> ' : '  '
  if (row.kind === 'create') {
    const text = fit(`${marker}+ New analysis "${row.title}"`, width)
    return isSelected ? `${INVERSE}${text}${RESET}` : text
  }
  const { name, title } = row.choice
  const head = fit(`${marker}${title}`, width)
  // The folder name, dimmed, when it is not the title's own slug and fits.
  const tail = name !== slugify(title) && head.length + 2 + name.length <= width ? `  ${name}` : ''
  return isSelected ? `${INVERSE}${head}${tail}${RESET}` : `${head}${DIM}${tail}${RESET}`
}

function emptyLine(analyses: readonly Choice[], query: string): string {
  if (analyses.length === 0 && query.trim() === '') return `${DIM}  No analyses yet. Type a title to create one.${RESET}`
  return `${DIM}  No match, and "${query.trim()}" is no title: use letters or digits.${RESET}`
}

/**
 * The picker's lines for a terminal `columns` wide and `rows` tall: the query, a window of rows that keeps the
 * selection in view, and a hint. `cursor` is the column the cursor sits at on the first line.
 */
export function pickerScreen(analyses: readonly Choice[], state: TermPickerState, size: { columns: number; rows: number }) {
  const width = Math.max(10, size.columns - 1)
  const all = pickerRows(analyses, state.query)
  const selected = clamp(state.selected, all.length)
  const height = Math.max(1, Math.min(10, size.rows - 3))
  const start = Math.max(0, selected - height + 1)
  const shown = all.slice(start, start + height).map((row, i) => rowLine(row, start + i === selected, width))
  const room = Math.max(0, width - PROMPT.length)
  const query = state.query.length > room ? state.query.slice(state.query.length - room) : state.query
  const count = analyses.length > 0 ? `${DIM}${String(all.filter(row => row.kind === 'open').length)}/${String(analyses.length)}${RESET}` : ''
  return {
    lines: [`${PROMPT}${query}`, ...(shown.length > 0 ? shown : [emptyLine(analyses, state.query)]), `${count}${count ? '  ' : ''}${DIM}${fit(HINT, width - 8)}${RESET}`],
    cursor: PROMPT.length + query.length,
  }
}
