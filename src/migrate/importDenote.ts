// A one-off import of denote notes (`<ID>--<title>__<tags>.md` with YAML front matter, as in ~/Code/notes/claude) into
// root notes (`<root>/notes/<ID>-<slug>.md`). The denote ID is kept, so `[[ID|label]]` links between them still resolve.
// The front matter becomes a `# Title` line and one metadata line; body headings move one level down, below the title.
// Recaps and sources are skipped. It never overwrites (an ID already in notes/ is skipped), lists no note in any
// analysis.yaml, and a rerun finds nothing to do. Dry run unless applied.
import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { byCodeUnit } from './codeUnitOrder.ts'
import { isNoteId, noteFileName, noteIds, noteLines, noteSegments, noteText, NOTES_DIR } from '../core/rootNotes.ts'

const SKIP_TAGS = ['recap', 'source']
const FRONT = /^---\n([\s\S]*?)\n---\n?/

export type ImportedNote = { id: string; file: string; text: string; from: string; mtimeMs?: number }
export type Converted = ({ ok: true } & Omit<ImportedNote, 'from' | 'mtimeMs'>) | { ok: false; reason: string }
export type ImportPlan = { notes: ImportedNote[]; skipped: { from: string; reason: string }[]; unresolved: string[] }

/** A YAML scalar as denote writes it: a double-quoted string (with `\"` escapes) or bare text. */
function scalar(value: string): string {
  const text = value.trim()
  if (!text.startsWith('"')) return text
  try {
    return String(JSON.parse(text))
  } catch {
    return text.replace(/^"|"$/g, '')
  }
}

/** A `key: value` line: a lower-case key, its colon, then the value after any white space; not a line whose value holds a line break character. */
export function parseField(line: string): { key: string; value: string } | undefined {
  const match = /^([a-z_]+):([\s\S]*)$/.exec(line)
  const key = match?.[1]
  const value = match?.[2]?.trimStart()
  if (!key || value === undefined || /[\n\r\u2028\u2029]/.test(value)) return undefined
  return { key, value }
}

function frontMatter(yaml: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of yaml.split('\n')) {
    const field = parseField(line)
    if (field) fields[field.key] = field.value
  }
  return fields
}

const tagsOf = (value = '') =>
  value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(tag => scalar(tag))
    .filter(Boolean)

/** Body headings one level down, outside fenced code, so the title stays the only `#` heading. */
const demote = (body: string) => noteLines(body).map(({ line, eol, fenced }) => (!fenced && /^#{1,5} /.test(line) ? `#${line}` : line) + eol).join('')

export function convertDenote(name: string, text: string): Converted {
  const front = FRONT.exec(text)
  if (!front) return { ok: false, reason: 'no front matter' }
  const fields = frontMatter(front[1] ?? '')
  const tags = tagsOf(fields.tags)
  const skip = SKIP_TAGS.find(tag => tags.includes(tag))
  if (skip) return { ok: false, reason: `skipped: ${skip}` }
  const id = scalar(fields.identifier ?? '') || name.slice(0, 15)
  if (!isNoteId(id)) return { ok: false, reason: 'no denote ID' }
  const title = scalar(fields.title ?? '')
  if (!title) return { ok: false, reason: 'no title' }
  const meta = [
    tags.length > 0 ? `Tags: ${tags.join(', ')}` : '',
    fields.status ? `Status: ${scalar(fields.status)}` : '',
    fields.as_of ? `As of: ${scalar(fields.as_of)}` : '',
  ].filter(Boolean)
  const body = demote(text.slice(front[0].length).trim())
  return { ok: true, id, file: noteFileName(id, title), text: noteText(title, [meta.join(' · '), body].filter(Boolean).join('\n\n')) }
}

/** What importing every `.md` in `from` into `<root>/notes/` would write and skip. */
export async function planImport(from: string, root: string): Promise<ImportPlan> {
  const existing = new Set(noteIds(await readdir(join(root, NOTES_DIR)).catch(() => [] as string[])))
  const plan: ImportPlan = { notes: [], skipped: [], unresolved: [] }
  for (const name of (await readdir(from)).filter(each => each.endsWith('.md')).sort(byCodeUnit)) {
    const path = join(from, name)
    const converted = convertDenote(name, await readFile(path, 'utf8'))
    if (!converted.ok) plan.skipped.push({ from: name, reason: converted.reason })
    else if (existing.has(converted.id) || plan.notes.some(note => note.id === converted.id)) plan.skipped.push({ from: name, reason: 'ID already in notes/' })
    else plan.notes.push({ id: converted.id, file: converted.file, text: converted.text, from: name, mtimeMs: (await stat(path)).mtimeMs })
  }
  const known = new Set([...existing, ...plan.notes.map(note => note.id)])
  const linked = plan.notes.flatMap(note => noteSegments(note.text).flatMap(segment => (segment.type === 'link' ? [segment.id] : [])))
  plan.unresolved = [...new Set(linked.filter(id => !known.has(id)))].sort(byCodeUnit)
  return plan
}

/** Writes the planned notes, never over an existing file, keeping each source file's mtime. */
export async function applyImport(root: string, plan: ImportPlan): Promise<void> {
  for (const note of plan.notes) {
    const path = join(root, NOTES_DIR, note.file)
    await writeFile(path, note.text, { encoding: 'utf8', flag: 'wx' })
    if (note.mtimeMs !== undefined) await utimes(path, new Date(), new Date(note.mtimeMs))
  }
}

export function printImportReport(plan: ImportPlan, applied: boolean): string {
  const reasons = new Map<string, number>()
  for (const each of plan.skipped) reasons.set(each.reason, (reasons.get(each.reason) ?? 0) + 1)
  return [
    `${applied ? 'Wrote' : 'Would write'} ${String(plan.notes.length)} notes.`,
    ...[...reasons].map(([reason, count]) => `Not imported (${reason}): ${String(count)}`),
    ...(plan.unresolved.length > 0 ? [`Links to notes not imported (they show as written): ${String(plan.unresolved.length)}: ${plan.unresolved.join(', ')}`] : []),
    ...(applied ? [] : ['Dry run: pass --apply to write.']),
    '',
  ].join('\n')
}
