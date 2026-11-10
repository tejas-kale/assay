// The data dictionary and trusted calculations as plain data, ported from the analysis mod's hooks/trust.ts:
// what the Python helper (python/analysis_trust.py) answers, and the text Claude is given.
import type { TrustState } from './trust.ts'

/** Where the user approves a proposal, in every message that points there. */
export const TRUST_TAB = 'the Trust tab in Assay'

/** In the shared folder (ASSAY_ROOT): one YAML file per table, and the glossary. */
export const DICTIONARIES = 'dictionaries'
/** In the shared folder: the trusted calculations. */
export const TRUSTED = 'trusted'
/** In an analysis: drafts and proposals, for the user to approve in the Trust tab. */
export const DRAFT_DICTIONARIES = 'lib/dictionaries'
export const DRAFT_TRUSTED = 'lib/trusted'
/** The skill that drafts a trusted calculation or a dictionary entry. */
export const PROPOSE_SKILL = 'assay:propose-trusted'

/** One table a statement touches, as `analysis_trust dictionary` answers. */
export type DictionaryTable = { name: string; entry?: string; text?: string; terms?: string[] }
export type DictionaryAnswer = { tables: DictionaryTable[]; glossary: Record<string, string> }

/** What this session has been given already: tables by name (or entry) and glossary terms. */
export type Seen = { tables: Set<string>; terms: Set<string> }

export const newSeen = (): Seen => ({ tables: new Set(), terms: new Set() })

/**
 * The text appended to a run's result the first time this session touches a
 * table: its dictionary entry and the glossary terms it names, or how to draft
 * one. Marks what it gives as seen. Undefined when every table was seen.
 */
export function dictionaryText(answer: DictionaryAnswer, seen: Seen): string | undefined {
  const parts: string[] = []
  const terms: string[] = []
  const missing: string[] = []
  for (const table of answer.tables) {
    const key = table.entry ?? table.name
    if (seen.tables.has(key)) continue
    seen.tables.add(key)
    if (table.entry && table.text !== undefined) {
      parts.push(`## ${table.entry}\n${table.text.trimEnd()}`)
      for (const term of table.terms ?? []) {
        if (!seen.terms.has(term) && !terms.includes(term)) terms.push(term)
      }
    } else missing.push(table.name)
  }
  for (const term of terms) seen.terms.add(term)
  const lines: string[] = []
  if (parts.length > 0) lines.push('Data dictionary (first use this session):', ...parts)
  if (terms.length > 0) lines.push('Glossary:', ...terms.map(term => `- ${term}: ${answer.glossary[term] ?? ''}`))
  for (const name of missing) lines.push(draftHint(name))
  return lines.length > 0 ? lines.join('\n') : undefined
}

/** How to draft a missing entry: only a full name can name its file. */
export function draftHint(name: string): string {
  if (name.split('.').length !== 3) {
    return `No data dictionary entry for ${name}. To draft one, find its catalog and schema: its entry is named catalog.schema.table.`
  }
  return `No data dictionary entry for ${name}. Draft it with the ${PROPOSE_SKILL} skill and the table's full name: ${name}.`
}

/** A path with `.` and `..` segments resolved, relative ones taken from `base`. */
export function normalPath(path: string, base: string): string {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/**
 * Whether `path` is inside the shared folder's dictionaries/ or trusted/: what only the user's approval writes.
 * Compared ignoring case (macOS); callers pass real paths, so a symlink cannot hide the folder.
 */
export function isGuarded(path: string, home: string, base: string): boolean {
  const full = normalPath(path, base).toLowerCase()
  const root = home.toLowerCase()
  return [DICTIONARIES, TRUSTED].some(folder => full === `${root}/${folder}` || full.startsWith(`${root}/${folder}/`))
}

/**
 * The `analyses/<slug>` folder `path` is in when it is another analysis than the open one; undefined otherwise.
 * Compared ignoring case (macOS). Callers pass real paths, so a symlink cannot hide the folder.
 */
export function otherAnalysis(path: string, home: string, analysis: string, base: string): string | undefined {
  const full = normalPath(path, base)
  const prefix = `${home}/analyses/`
  if (!full.toLowerCase().startsWith(prefix.toLowerCase())) return undefined
  const slug = full.slice(prefix.length).split('/')[0] ?? ''
  return `${prefix}${slug}`.toLowerCase() === analysis.toLowerCase() ? undefined : `analyses/${slug}`
}

// ---------------------------------------------------------------------------
// Trusted calculations, as `analysis_trust list` answers.

/** `list`: a list of names, a definition's `by` and `filters`. */
export type ParamType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'list'
export type Param = { name: string; type: ParamType; required: boolean }
export type Calculation = {
  name: string
  kind: 'sql' | 'python' | 'definition'
  file: string
  /** Its file from the shared folder: trusted/<file>, or dictionaries/<file> for a definition. */
  path?: string
  description: string
  parameters: Param[]
  /** A template's SQL, without its front matter. */
  sql?: string
  /** A block's contract (docs/slice-10.md): the columns that identify one row, and every output column in order. */
  block?: { grain: string[]; columns: string[] }
  /** The commit that last changed its file, 12 hex digits; '' when never committed. */
  commit: string
  /** Its file differs from that commit, or was never committed: not trusted until approved again. */
  dirty: boolean
}
export type CalculationList = { calculations: Calculation[]; problems: string[] }

/** A calculation as the per-prompt list names it: `name(start: date, status?: string)`. */
export const signature = (calc: Pick<Calculation, 'name' | 'parameters'>) =>
  `${calc.name}(${calc.parameters.map(param => `${param.name}${param.required ? '' : '?'}: ${param.type}`).join(', ')})`

/** A block as the per-prompt list names it: `name(start: date) -> grain session_id: session_id, buyer_id`. */
export const blockSignature = (calc: Pick<Calculation, 'name' | 'parameters'> & { block: { grain: string[]; columns: string[] } }) =>
  `${signature(calc)} -> grain ${calc.block.grain.join(', ') || 'one row'}: ${calc.block.columns.join(', ')}`

/**
 * The arguments, checked against the declared parameters' types: none
 * unknown, every required one given, each of its type (a date as YYYY-MM-DD).
 */
export function checkArgs(params: readonly Param[], given: unknown): { args: Record<string, unknown> } | { error: string } {
  if (given === undefined) given = {}
  if (!given || typeof given !== 'object' || Array.isArray(given)) return { error: 'Give args as an object of named arguments.' }
  const args = given as Record<string, unknown>
  const unknown = Object.keys(args).filter(name => !params.some(param => param.name === name))
  if (unknown.length > 0) return { error: `Unknown arguments: ${unknown.join(', ')}. It takes ${params.map(param => param.name).join(', ') || 'none'}.` }
  for (const param of params) {
    const value = args[param.name]
    if (value === undefined) {
      if (param.required) return { error: `Missing argument: ${param.name} (${param.type}).` }
      continue
    }
    const ok =
      param.type === 'string' ? typeof value === 'string'
      : param.type === 'integer' ? Number.isInteger(value)
      : param.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : param.type === 'boolean' ? typeof value === 'boolean'
      : param.type === 'list' ? Array.isArray(value) && value.every(each => typeof each === 'string')
      : typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && !Number.isNaN(Date.parse(value))
    const said = param.type === 'date' ? 'a date as YYYY-MM-DD' : param.type === 'list' ? 'a list of names' : `a ${param.type}`
    if (!ok) return { error: `Argument ${param.name} must be ${said}.` }
  }
  return { args }
}

/** What a trusted run's .sql records at its top: the calculation, its arguments and its file's commit. */
export type RunHeader = { name: string; args: Record<string, unknown>; commit: string }

export const runHeader = ({ name, args, commit }: RunHeader) =>
  [`-- trusted: ${name}`, `-- args: ${JSON.stringify(args)}`, `-- commit: ${commit}`].join('\n')

/** The header of a saved query that is a trusted run, if it is one. */
export function parseTrustedHeader(text: string): RunHeader | undefined {
  const name = /^-- trusted: (\S+)\s*$/m.exec(text)?.[1]
  if (!name) return undefined
  const commit = /^-- commit: (\S*)\s*$/m.exec(text)?.[1] ?? ''
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(/^-- args: (.*)$/m.exec(text)?.[1] ?? '{}')
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
  } catch {
    // An unreadable args line still names the calculation.
  }
  return { name, args, commit }
}

// ---------------------------------------------------------------------------
// The trust review: what `analysis_trust check` answers for a proposal.

export type CheckStep = {
  step: string
  ok: boolean
  text: string
  /** A test's name: `case 2`, or `test_x.py::test_y`. */
  name?: string
  /** A failed fixture case's line diff of expected and got, as CSV. */
  diff?: string
}
export type CheckAnswer = {
  name: string
  ok: boolean
  steps: CheckStep[]
  kind?: string
  file?: string
  description?: string
  code?: string
  /** The proposal's files, by name, that approving copies. */
  files?: string[]
  sample?: { columns: string[]; rows: string[][]; total: number }
}

/** A proposal's name: a calculation's (lower case, digits, _) or a table's full name. */
export const PROPOSAL_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,2}$/

/** One line of `analysis_trust check --stream`. */
export type CheckEvent =
  | { event: 'start'; name: string; kind?: string; file?: string; description?: string; code?: string; files?: string[]; block?: { grain: string[]; columns: string[] } }
  | { event: 'step'; step: CheckStep }
  | { event: 'done'; answer: CheckAnswer | { error: string } }

const isStep = (value: unknown): value is CheckStep => {
  const step = value as Partial<CheckStep> | null
  return !!step && typeof step.step === 'string' && typeof step.ok === 'boolean' && typeof step.text === 'string'
}

/** The complete event lines in `buffer` (the helper's stdout so far), and the partial line left. Other lines are ignored. */
export function splitCheckEvents(buffer: string): { events: CheckEvent[]; rest: string } {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  const events: CheckEvent[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown> | null
      if (!parsed || typeof parsed !== 'object') continue
      if (parsed.event === 'start' && typeof parsed.name === 'string') events.push(parsed as CheckEvent)
      else if (parsed.event === 'step' && isStep(parsed.step)) events.push({ event: 'step', step: parsed.step })
      else if (parsed.event === 'done' && parsed.answer && typeof parsed.answer === 'object') events.push({ event: 'done', answer: parsed.answer as CheckAnswer })
    } catch {
      // Not an event: a stray print.
    }
  }
  return { events, rest }
}

/** `.assay/trust/<name>.json`: the review as the app's Trust tab reads it. */
export type TrustFile = {
  name: string
  kind: 'calculation' | 'dictionary'
  what: 'SQL template' | 'SQL block' | 'Python function' | 'dictionary entry'
  language: 'sql' | 'python' | 'yaml'
  replaces: boolean
  state: TrustState
  startedAt: number
  endedAt?: number
  description?: string
  code?: string
  steps: CheckStep[]
  sample?: { columns: string[]; rows: string[][]; total: number }
  message?: string
}
