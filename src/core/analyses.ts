// The analyses under the root: `<root>/analyses/<slug>/analysis.yaml` marks one and holds its title and target, over
// an injected port. The slug is the folder name, made from the title once at creation and never changed.
import { slugify } from './rootNotes.ts'

export type FsStat = { isDirectory: boolean; mtimeMs: number }
export type FsPort = {
  /** Entry names of a folder; rejects when it does not exist. */
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<FsStat | undefined>
  exists(path: string): Promise<boolean>
  /** Makes the folder and its parents. */
  mkdir(path: string): Promise<void>
  /** A file's text; rejects when it does not exist. */
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
}

/** An analysis as the app and server name it: the folder name (the slug, which citations name), the title, the folder. */
export type AnalysisRef = { name: string; title: string; path: string }

export type Analysis = AnalysisRef & { modifiedMs: number }

export const ANALYSIS_FILE = 'analysis.yaml'
const ANALYSES = 'analyses'

/** The path without the `/`s at its end (a loop, not a regex: `/+$` is slow on a long run of slashes). */
export function stripTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') end--
  return path.slice(0, end)
}

const join = (root: string, ...parts: string[]) => [stripTrailingSlashes(root), ...parts].join('/')

/** The keys of analysis.yaml this app reads; any other key stays in the file untouched. */
export type AnalysisFile = { title?: string; created?: string; profile?: string; warehouse?: string; pgDatabase?: string }

const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*:(.*)$/

/** A `key: value` line, the key lowercased and the value as written; the colon must end the line or be followed by a space or tab. */
function keyLine(line: string): { key: string; value: string } | undefined {
  const match = KEY_LINE.exec(line)
  const value = match?.[2] ?? ''
  if (!match?.[1] || (value !== '' && !/^[ \t]/.test(value))) return undefined
  return { key: match[1].toLowerCase(), value }
}

/** A scalar as YAML writes it: quoted with '' or "", else up to a ` #` comment. Undefined when empty. */
function scalar(raw: string): string | undefined {
  const text = raw.trim()
  const quote = text[0]
  if (quote === '"') {
    const close = /^"(?:[^"\\]|\\.)*"/.exec(text)?.[0]
    if (close) {
      try {
        return String(JSON.parse(close))
      } catch {
        return close.slice(1, -1)
      }
    }
  } else if (quote === "'") {
    const close = /^'(?:[^']|'')*'/.exec(text)?.[0]
    if (close) return close.slice(1, -1).replace(/''/g, "'")
  }
  const bare = text.replace(/(^|\s)#.*$/, '').trim()
  return bare === '' ? undefined : bare
}

/** The top-level `key: value` lines of an analysis.yaml: the first line naming a key wins, in any case. */
export function parseAnalysisFile(text: string): AnalysisFile {
  const found: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const entry = keyLine(line)
    if (!entry || entry.key in found) continue
    const value = scalar(entry.value)
    if (value !== undefined) found[entry.key] = value
  }
  return {
    ...(found.title ? { title: found.title } : {}),
    ...(found.created ? { created: found.created } : {}),
    ...(found.profile ? { profile: found.profile } : {}),
    ...(found.warehouse ? { warehouse: found.warehouse } : {}),
    ...(found.pg_database ? { pgDatabase: found.pg_database } : {}),
  }
}

/** A value as YAML text: plain when that reads back as the same string, else double quoted. */
export function yamlScalar(value: string): string {
  const plain = /^[A-Za-z0-9][A-Za-z0-9 .,'()/&+_-]*$/.test(value) && !/^(true|false|null|yes|no|on|off|[0-9.+-]+)$/i.test(value) && !value.endsWith(' ')
  return plain ? value : JSON.stringify(value)
}

/** The text with `title:` set; every other line stays as it was, and so do the file's line endings. */
export function setTitle(text: string, title: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const line = `title: ${yamlScalar(title.trim())}`
  const lines = text.split('\n')
  const at = lines.findIndex(each => keyLine(each.replace(/\r$/, ''))?.key === 'title')
  if (at < 0) return `${line}${eol}${text}`
  lines[at] = lines[at]?.endsWith('\r') ? `${line}\r` : line
  return lines.join('\n')
}

/** The numbered slug: `slug`, else `slug-2`, `slug-3`, ... the first not in `taken`. */
export function slugFor(title: string, taken: Iterable<string>): string {
  // Compared ignoring case: the folders of a macOS volume are.
  const used = new Set([...taken].map(name => name.toLowerCase()))
  const slug = slugify(title)
  if (!used.has(slug)) return slug
  for (let n = 2; ; n++) if (!used.has(`${slug}-${String(n)}`)) return `${slug}-${String(n)}`
}

/** Every analysis under `root`, most recently changed first. Only folders holding analysis.yaml count. */
export async function listAnalyses(port: FsPort, root: string): Promise<Analysis[]> {
  const found: Analysis[] = []
  const names = await port.readdir(join(root, ANALYSES)).catch(() => [] as string[])
  for (const entry of names) {
    if (entry.startsWith('.')) continue
    const path = join(root, ANALYSES, entry)
    const info = await port.stat(path)
    if (!info?.isDirectory) continue
    const text = await port.readFile(join(path, ANALYSIS_FILE)).catch(() => undefined)
    if (text === undefined) continue
    found.push({ name: entry, title: parseAnalysisFile(text).title ?? entry, path, modifiedMs: info.mtimeMs })
  }
  return found.sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path))
}

/** A typed title as stored: trimmed, spaces collapsed; refused when it has no letter or digit to slug. */
export function cleanTitle(raw: string): { ok: true; title: string } | { ok: false; message: string } {
  const title = raw.trim().replace(/\s+/g, ' ')
  return /[A-Za-z0-9]/.test(title) ? { ok: true, title } : { ok: false, message: 'Type a title with letters or digits.' }
}

const titled = (raw: string) => {
  const cleaned = cleanTitle(raw)
  if (!cleaned.ok) throw new Error(cleaned.message)
  return cleaned.title
}

/** A local calendar day as `YYYY-MM-DD`. */
export const isoDay = (date: Date) => `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** The slug when `path` is exactly `<root>/analyses/<slug>`; undefined for anything else. */
export function analysisSlug(path: string, root: string): string | undefined {
  const prefix = `${stripTrailingSlashes(root)}/${ANALYSES}/`
  const slug = path.startsWith(prefix) ? path.slice(prefix.length) : ''
  return slug === '' || slug.includes('/') || slug.startsWith('.') ? undefined : slug
}

/** Makes `analyses/<slug>/analysis.yaml` from a typed title and returns the analysis. `today` is `YYYY-MM-DD`. */
export async function createAnalysis(port: FsPort, root: string, title: string, today: string): Promise<AnalysisRef> {
  const typed = titled(title)
  // Every folder counts as taken, marked or not, so nothing is written into another's folder.
  const taken = await port.readdir(join(root, ANALYSES)).catch(() => [] as string[])
  const name = slugFor(typed, taken)
  const path = join(root, ANALYSES, name)
  await port.mkdir(path)
  await port.writeFile(join(path, ANALYSIS_FILE), `title: ${yamlScalar(typed)}\ncreated: ${today}\n`)
  return { name, title: typed, path }
}

/** The folder name (the slug) of an analysis path. */
export const folderName = (path: string) => stripTrailingSlashes(path).split('/').at(-1) ?? path

/** The analysis in `path` and its analysis.yaml text; a folder without the file is refused, pointing at the migration. */
async function read(port: Pick<FsPort, 'readFile'>, path: string): Promise<{ ref: AnalysisRef; text: string }> {
  const text = await port.readFile(join(path, ANALYSIS_FILE)).catch(() => undefined)
  if (text === undefined) throw new Error(`${path} has no ${ANALYSIS_FILE}. Run "npm run migrate:root" in the Assay repo to convert the old layout.`)
  const name = folderName(path)
  return { ref: { name, title: parseAnalysisFile(text).title ?? name, path }, text }
}

export async function openAnalysis(port: Pick<FsPort, 'readFile'>, path: string): Promise<AnalysisRef> {
  return (await read(port, path)).ref
}

/** Changes `title:` in the analysis's analysis.yaml. The folder, and so the slug, stay. */
export async function renameAnalysis(port: Pick<FsPort, 'readFile' | 'writeFile'>, path: string, title: string): Promise<AnalysisRef> {
  const typed = titled(title)
  const { ref, text } = await read(port, path)
  await port.writeFile(join(path, ANALYSIS_FILE), setTitle(text, typed))
  return { ...ref, title: typed }
}
