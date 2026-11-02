// The analyses under the root: `<root>/analyses/<slug>/analysis.yaml` marks one and holds its title and target, over
// an injected port. The slug is the folder name, made from the title once at creation and never changed.
import { slugify } from './noteFiles.ts'

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

export type Analysis = {
  /** The folder name under `analyses/`: the slug, which citations name. */
  name: string
  title: string
  path: string
  modifiedMs: number
}

export const ANALYSIS_FILE = 'analysis.yaml'
const ANALYSES = 'analyses'

const join = (root: string, ...parts: string[]) => [root.replace(/\/+$/, ''), ...parts].join('/')

/** The keys of analysis.yaml this app reads; any other key stays in the file untouched. */
export type AnalysisFile = { title?: string; created?: string; profile?: string; warehouse?: string; pgDatabase?: string }

const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*))?$/

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
    const match = KEY_LINE.exec(line)
    const key = match?.[1]?.toLowerCase()
    if (!match || !key || key in found) continue
    const value = scalar(match[2] ?? '')
    if (value !== undefined) found[key] = value
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

/** The text with `title:` set; every other line stays as it was. */
export function setTitle(text: string, title: string): string {
  const line = `title: ${yamlScalar(title.trim())}`
  const lines = text.split('\n')
  const at = lines.findIndex(each => KEY_LINE.exec(each)?.[1]?.toLowerCase() === 'title')
  if (at < 0) return `${line}\n${text}`
  lines[at] = line
  return lines.join('\n')
}

/** The numbered slug: `slug`, else `slug-2`, `slug-3`, ... the first not in `taken`. */
export function slugFor(title: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const slug = slugify(title)
  if (!used.has(slug)) return slug
  for (let n = 2; ; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`
}

const hasWords = (title: string) => /[A-Za-z0-9]/.test(title)

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

type Opened = Pick<Analysis, 'name' | 'title' | 'path'>

/** Makes `analyses/<slug>/analysis.yaml` from a typed title and returns the analysis. `today` is `YYYY-MM-DD`. */
export async function createAnalysis(port: FsPort, root: string, title: string, today: string): Promise<Opened> {
  const typed = title.trim().replace(/\s+/g, ' ')
  if (!hasWords(typed)) throw new Error('Type a title with letters or digits.')
  // Every folder counts as taken, marked or not, so nothing is written into another's folder.
  const taken = await port.readdir(join(root, ANALYSES)).catch(() => [] as string[])
  const name = slugFor(typed, taken)
  const path = join(root, ANALYSES, name)
  await port.mkdir(path)
  await port.writeFile(join(path, ANALYSIS_FILE), `title: ${yamlScalar(typed)}\ncreated: ${today}\n`)
  return { name, title: typed, path }
}

const lastPart = (path: string) => path.replace(/\/+$/, '').split('/').at(-1) ?? path

/** The analysis in `path`; a folder without analysis.yaml is refused, pointing at the migration. */
export async function openAnalysis(port: FsPort, path: string): Promise<Opened> {
  const text = await port.readFile(join(path, ANALYSIS_FILE)).catch(() => undefined)
  if (text === undefined) throw new Error(`${path} has no ${ANALYSIS_FILE}. Run "npm run migrate:root" in the Assay repo to convert the old layout.`)
  const name = lastPart(path)
  return { name, title: parseAnalysisFile(text).title ?? name, path }
}

/** Changes `title:` in the analysis's analysis.yaml. The folder, and so the slug, stay. */
export async function renameAnalysis(port: FsPort, path: string, title: string): Promise<Opened> {
  const typed = title.trim().replace(/\s+/g, ' ')
  if (!hasWords(typed)) throw new Error('Type a title with letters or digits.')
  const found = await openAnalysis(port, path)
  const file = join(path, ANALYSIS_FILE)
  await port.writeFile(file, setTitle(await port.readFile(file), typed))
  return { ...found, title: typed }
}
