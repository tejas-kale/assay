// The delegated-analysis preface (specs/delegated-runs.md): validating the draft `preface.json`, freezing an
// agent-immutable copy in `.assay/preface.json`, and resetting it into `.assay/preface-archive/<id>.json`.
import { createHash } from 'node:crypto'

import { stripTrailingSlashes } from './slugText.ts'

/** The draft preface the agent writes in the analysis folder. */
export const PREFACE_DRAFT_FILE = 'preface.json'
/** The current frozen preface in `.assay/` (agent-immutable). */
export const FROZEN_PREFACE_FILE = '.assay/preface.json'
/** Where reset archives each frozen preface as `<id>.json`. */
export const PREFACE_ARCHIVE_DIR = '.assay/preface-archive'

export type PrefaceSpec = { id: string; text: string }

export type Preface = {
  low: number
  high: number
  known_total?: number
  tolerance?: number
  falsifiers: string[]
  answer: string
  reconciliation: string
  specs: PrefaceSpec[]
}

export type FrozenPreface = Preface & { id: string; frozenAt: string }

export type PrefaceFs = {
  readdir(path: string): Promise<string[]>
  mkdir(path: string): Promise<void>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  unlink(path: string): Promise<void>
}

const join = (base: string, ...parts: string[]) => [stripTrailingSlashes(base), ...parts].join('/')
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const trimmedText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function parseBounds(raw: Record<string, unknown>): { low: number; high: number; known_total?: number; tolerance?: number } | { error: string } {
  const { low, high, known_total: known, tolerance } = raw
  if (!isFiniteNumber(low) || !isFiniteNumber(high) || low > high) {
    return { error: 'preface.json needs finite "low" and "high" with low <= high.' }
  }
  const hasKnown = known !== undefined && known !== null
  if (hasKnown && !isFiniteNumber(known)) return { error: 'preface.json "known_total" must be a finite number when set.' }
  const hasTol = tolerance !== undefined && tolerance !== null
  if ((hasKnown && !hasTol) || (hasTol && (!isFiniteNumber(tolerance) || tolerance < 0))) {
    return { error: 'preface.json needs a non-negative "tolerance" when "known_total" is set.' }
  }
  return {
    low,
    high,
    ...(hasKnown ? { known_total: known } : {}),
    ...(hasTol ? { tolerance } : {}),
  }
}

function parseFalsifiers(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: string[] = []
  for (const item of raw) {
    const text = trimmedText(item)
    if (!text) return undefined
    out.push(text)
  }
  return out
}

function parseSpecs(raw: unknown): PrefaceSpec[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const seen = new Set<string>()
  const out: PrefaceSpec[] = []
  for (const item of raw) {
    if (!isRecord(item)) return undefined
    const id = trimmedText(item.id)
    const text = trimmedText(item.text)
    if (!id || !text || seen.has(id)) return undefined
    seen.add(id)
    out.push({ id, text })
  }
  return out
}

/** Validates a draft `preface.json` string against the preface schema. */
export function parsePreface(text: string): { preface: Preface } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: 'preface.json is not valid JSON.' }
  }
  if (!isRecord(raw)) return { error: 'preface.json must be a JSON object.' }
  const bounds = parseBounds(raw)
  if ('error' in bounds) return bounds
  const falsifiers = parseFalsifiers(raw.falsifiers)
  if (!falsifiers) return { error: 'preface.json needs a non-empty "falsifiers" list of sentences.' }
  const specs = parseSpecs(raw.specs)
  if (!specs) return { error: 'preface.json needs a non-empty "specs" list of unique { id, text } entries.' }
  const answer = trimmedText(raw.answer)
  const reconciliation = trimmedText(raw.reconciliation)
  const ids = new Set(specs.map(spec => spec.id))
  if (!answer || !reconciliation || !ids.has(answer) || !ids.has(reconciliation)) {
    return { error: 'preface.json "answer" and "reconciliation" must name ids present in "specs".' }
  }
  return { preface: { ...bounds, falsifiers, answer, reconciliation, specs } }
}

/** Parses `.assay/preface.json` back into a `FrozenPreface`, or `undefined` when missing or damaged. */
export function parseFrozenPreface(text: string): FrozenPreface | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const id = trimmedText(raw.id)
  const frozenAt = trimmedText(raw.frozenAt)
  if (!id || !frozenAt) return undefined
  const parsed = parsePreface(text)
  return 'preface' in parsed ? { ...parsed.preface, id, frozenAt } : undefined
}

/** Reads the current frozen preface of an analysis, or `undefined` when none is frozen. */
export async function readFrozenPreface(port: Pick<PrefaceFs, 'readFile'>, analysisPath: string): Promise<FrozenPreface | undefined> {
  const text = await port.readFile(join(analysisPath, FROZEN_PREFACE_FILE)).catch(() => undefined)
  return text === undefined ? undefined : parseFrozenPreface(text)
}

/** Freezes `preface.json` into `.assay/preface.json` unless a preface is already frozen. */
export async function freezePreface(
  port: PrefaceFs,
  analysisPath: string,
  now: Date = new Date(),
): Promise<{ ok: true; preface: FrozenPreface } | { ok: false; reason: 'invalid'; message: string }> {
  const existing = await port.readFile(join(analysisPath, FROZEN_PREFACE_FILE)).catch(() => undefined)
  if (existing !== undefined) {
    return { ok: false, reason: 'invalid', message: 'A preface is already frozen. Reset it before freezing a new one.' }
  }
  const draft = await port.readFile(join(analysisPath, PREFACE_DRAFT_FILE)).catch(() => undefined)
  if (draft === undefined) {
    return { ok: false, reason: 'invalid', message: `No draft preface: write ${PREFACE_DRAFT_FILE} in the analysis folder first.` }
  }
  const parsed = parsePreface(draft)
  if ('error' in parsed) return { ok: false, reason: 'invalid', message: parsed.error }
  const archived = await port.readdir(join(analysisPath, PREFACE_ARCHIVE_DIR)).catch(() => [] as string[])
  const frozenAt = now.toISOString()
  const id = createHash('sha256').update(JSON.stringify({ preface: parsed.preface, frozenAt, seq: archived.length })).digest('hex').slice(0, 12)
  const preface: FrozenPreface = { ...parsed.preface, id, frozenAt }
  const frozenPath = join(analysisPath, FROZEN_PREFACE_FILE)
  await port.mkdir(join(analysisPath, '.assay'))
  await port.writeFile(frozenPath, `${JSON.stringify(preface, null, 2)}\n`)
  return { ok: true, preface }
}

/** Archives `.assay/preface.json` into `.assay/preface-archive/<id>.json` and removes the current frozen preface. */
export async function resetPreface(
  port: PrefaceFs,
  analysisPath: string,
): Promise<{ ok: true; archived: FrozenPreface } | { ok: false; reason: 'invalid'; message: string }> {
  const frozenPath = join(analysisPath, FROZEN_PREFACE_FILE)
  const text = await port.readFile(frozenPath).catch(() => undefined)
  const frozen = text === undefined ? undefined : parseFrozenPreface(text)
  if (!frozen) return { ok: false, reason: 'invalid', message: 'No frozen preface to reset.' }
  const archiveDir = join(analysisPath, PREFACE_ARCHIVE_DIR)
  await port.mkdir(archiveDir)
  await port.writeFile(join(archiveDir, `${frozen.id}.json`), `${JSON.stringify(frozen, null, 2)}\n`)
  await port.unlink(frozenPath)
  return { ok: true, archived: frozen }
}
