// parseNote, parseFileNote, notesFrom and notesText are ported from the analysis mod's hooks/model.ts.
import { StaleEdit } from './errors.ts'
import { oneLine } from './text.ts'

export type Label = 'trusted' | 'queried' | 'computed' | 'unverified'
/** What a note citing run `n` gets: derived from the runs (see `citedLabel` in runs.ts). */
export type LabelOf = (n: number) => 'queried' | 'computed' | 'unverified'
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

const NOTE_TAG = /^(.*?)\s*\[(?:(trusted|queried|computed|unverified)(?: q (\d+))?|q (\d+))\]$/
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

/** Builds a line. `trusted` only comes from a caller that already holds it, never from the user's tag. */
function build(text: string, query: number | undefined, labelOf: LabelOf, keepTrusted: boolean) {
  const derived = query === undefined ? 'unverified' : labelOf(query)
  const label: Label = derived === 'queried' && keepTrusted ? 'trusted' : derived
  return `${text} [${query === undefined ? label : `${label} q ${queryLabel(query)}`}]`
}

/** The user's input split into its text and the query it cites (the label in the tag is ignored). */
function readInput(input: string) {
  const { text, label, query } = parseNote(oneLine(input))
  if (text === '') throw new Error('Fact is empty')
  return { text, query, hasTag: label !== undefined || query !== undefined }
}

export function addFact(text: string, input: string, labelOf: LabelOf): string {
  const fact = readInput(input)
  return notesText([...notesFrom(text), build(fact.text, fact.query, labelOf, false)])
}

function lineAt(text: string, index: number, expected: string) {
  const lines = notesFrom(text)
  if (lines[index] !== expected) throw new StaleEdit(`Note ${index + 1} changed on disk`)
  return lines
}

export function editFact(text: string, index: number, expectedLine: string, input: string, labelOf: LabelOf): string {
  const lines = lineAt(text, index, expectedLine)
  if (parseFileNote(expectedLine)) throw new Error('A file note cannot be edited as a fact')
  const fact = readInput(input)
  const old = parseNote(expectedLine)
  const query = fact.hasTag ? fact.query : old.query
  // Like the mod: an edit that changes neither text nor citation writes nothing, so it cannot downgrade a label.
  if (fact.text === old.text && query === old.query) return text
  const keepTrusted = old.label === 'trusted' && query !== undefined && query === old.query
  const line = build(fact.text, query, labelOf, keepTrusted)
  return notesText(lines.map((each, i) => (i === index ? line : each)))
}

export function deleteFact(text: string, index: number, expectedLine: string): string {
  const lines = lineAt(text, index, expectedLine)
  return notesText(lines.filter((_, i) => i !== index))
}

// The labels the server writes, ported from the analysis mod's hooks/model.ts. Each fact ends in one, derived
// from the run it cites, never chosen by Claude:
//   [trusted q 007]    a run of a trusted calculation, with its .csv
//   [queried q 005]    any other SQL run whose .csv exists
//   [computed q 014]   a Python run that ended ok
//   [unverified q 004] a SQL run without .csv, or a Python run that did not end ok; [unverified] cites none

/** The tag a note line ends with: its label and the run it cites, if any. */
export const noteTag = (label: Label, query?: number) => (query === undefined ? label : `${label} q ${queryLabel(query)}`)

/** A note line: one line of text and its tag. */
export const noteLine = (text: string, label: Label, query?: number) => `${oneLine(text)} [${noteTag(label, query)}]`

/** What labelling a note needs to know of the run it cites. */
export type QueryFacts = {
  hasCsv: boolean
  isTrustedRun: boolean
  /** `python` for a run saved as .py; absent for SQL. */
  language?: 'sql' | 'python'
  /** A Python run's `status` in its .json; absent when there is no readable .json. */
  status?: string
}

/**
 * The label a note citing a run gets: computed for a Python run that ended ok, unverified for any other Python
 * run; for SQL, trusted for a trusted run's result, queried for any other result, unverified with no run or no
 * .csv. Old notes are relabelled with `mayTrust` false: nothing becomes trusted after the fact.
 */
export function deriveLabel(facts: QueryFacts | undefined, mayTrust = true): Label {
  if (facts?.language === 'python') return facts.status === 'ok' ? 'computed' : 'unverified'
  if (!facts?.hasCsv) return 'unverified'
  return facts.isTrustedRun && mayTrust ? 'trusted' : 'queried'
}

/** The index of the fact `ref` names: its line number, its exact text or a part no other fact shares; else why not. */
export function findFact(lines: readonly string[], ref: string): number | string {
  const isFact = (line: string) => !parseFileNote(line)
  if (/^\d+$/.test(ref)) {
    const index = Number(ref) - 1
    return lines[index] !== undefined && isFact(lines[index] ?? '') ? index : `No note ${ref} in notes.md.`
  }
  const wanted = ref.toLowerCase()
  const exact = lines.findIndex(line => isFact(line) && (line.toLowerCase() === wanted || parseNote(line).text.toLowerCase() === wanted))
  if (exact >= 0) return exact
  const matches = lines.flatMap((line, i) => (isFact(line) && line.toLowerCase().includes(wanted) ? [i] : []))
  if (matches.length > 1) return `${matches.length} notes match "${ref}"; give its line number.`
  return matches[0] ?? `No note matches "${ref}".`
}
