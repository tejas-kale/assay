// parseNote, parseFileNote, notesFrom and notesText are ported from the analysis mod's hooks/model.ts.
import { StaleEdit } from './errors.ts'
import { oneLine } from './text.ts'

export type Label = 'trusted' | 'queried' | 'unverified'
export type Note = { text: string; label?: Label; query?: number }
export type Fact = {
  /** Position among the non-blank lines of notes.md. */
  index: number
  /** The whole line as written: pass it back as `expectedLine`. */
  line: string
  text: string
  label?: Label
  query?: number
  /** Set when the line links a note file; its text is then the title. */
  file?: { title: string; path: string }
}

const NOTE_TAG = /^(.*?)\s*\[(?:(trusted|queried|unverified)(?: q (\d+))?|q (\d+))\]$/
const FILE_NOTE = /^\[(.*)\]\(<(.+)>\)$/

export function parseNote(line: string): Note {
  const match = NOTE_TAG.exec(line)
  if (!match) return { text: line }
  const [, text = '', label, labelled, bare] = match
  // `[trusted]` and `[queried]` without a query are not tags the mod writes.
  if (label && label !== 'unverified' && labelled === undefined) return { text: line }
  const number = labelled ?? bare
  return { text, ...(label ? { label: label as Label } : {}), ...(number === undefined ? {} : { query: Number(number) }) }
}

export function parseFileNote(line: string): { title: string; path: string } | undefined {
  const match = FILE_NOTE.exec(line)
  return match ? { title: match[1] ?? '', path: match[2] ?? '' } : undefined
}

/** The mod's own writer of a link line; tests use it, the app only reads links. */
export const fileNoteLine = (title: string, path: string) => `[${oneLine(title).replace(/[[\]]/g, '')}](<${path}>)`

export const notesFrom = (text: string) => text.split('\n').filter(line => line.trim() !== '')

export const notesText = (lines: readonly string[]) => lines.map(line => `${line}\n`).join('')

export function listFacts(text: string): Fact[] {
  return notesFrom(text).map((line, index) => {
    const file = parseFileNote(line)
    if (file) return { index, line, text: file.title, file }
    const { text: body, label, query } = parseNote(line)
    return { index, line, text: body, ...(label ? { label } : {}), ...(query === undefined ? {} : { query }) }
  })
}

const queryLabel = (n: number) => String(n).padStart(3, '0')

function hasCsv(queries: readonly string[], query: number) {
  return queries.some(name => {
    const match = /^(\d{3,})_.+\.csv$/.exec(name)
    return match !== null && Number(match[1]) === query
  })
}

/** Builds a line. `trusted` only comes from a caller that already holds it, never from the user's tag. */
function build(text: string, query: number | undefined, queries: readonly string[], keepTrusted: boolean) {
  const cited = query !== undefined && hasCsv(queries, query)
  const label: Label = cited ? (keepTrusted ? 'trusted' : 'queried') : 'unverified'
  return `${text} [${query === undefined ? label : `${label} q ${queryLabel(query)}`}]`
}

/** The user's input split into its text and the query it cites (the label in the tag is ignored). */
function readInput(input: string) {
  const { text, label, query } = parseNote(oneLine(input))
  if (text === '') throw new Error('Fact is empty')
  return { text, query, hasTag: label !== undefined || query !== undefined }
}

export function addFact(text: string, input: string, queries: readonly string[]): string {
  const fact = readInput(input)
  return notesText([...notesFrom(text), build(fact.text, fact.query, queries, false)])
}

function lineAt(text: string, index: number, expected: string) {
  const lines = notesFrom(text)
  if (lines[index] !== expected) throw new StaleEdit(`Note ${index + 1} changed on disk`)
  return lines
}

export function editFact(text: string, index: number, expectedLine: string, input: string, queries: readonly string[]): string {
  const lines = lineAt(text, index, expectedLine)
  if (parseFileNote(expectedLine)) throw new Error('A file note cannot be edited as a fact')
  const fact = readInput(input)
  const old = parseNote(expectedLine)
  const query = fact.hasTag ? fact.query : old.query
  const keepTrusted = old.label === 'trusted' && query !== undefined && query === old.query
  const line = build(fact.text, query, queries, keepTrusted)
  return notesText(lines.map((each, i) => (i === index ? line : each)))
}

export function deleteFact(text: string, index: number, expectedLine: string): string {
  const lines = lineAt(text, index, expectedLine)
  return notesText(lines.filter((_, i) => i !== index))
}
