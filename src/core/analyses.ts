// What the mod's /an picker lists (hooks/register.tsx listAnalyses, FOLDER_NAME, setUp's marker), over an injected port.

export type FsStat = { isDirectory: boolean; mtimeMs: number }
export type FsPort = {
  /** Entry names of a folder; rejects when it does not exist. */
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<FsStat | undefined>
  exists(path: string): Promise<boolean>
  /** Makes the folder and its parents. */
  mkdir(path: string): Promise<void>
  writeFile(path: string, text: string): Promise<void>
}

export type Analysis = {
  /** `analyses/` entries by folder name; migrated ones as `investigations/<name>`. */
  name: string
  path: string
  modifiedMs: number
}

const MARKER = '.analysis'
const MARKER_TEXT = '# Marks this folder for the analysis mod.\n'
const ANALYSES = 'analyses'
// Folders migrated from the investigate and explore mods count only once marked.
const MIGRATED = ['investigations', 'explorations'] as const
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const validName = (name: string) => FOLDER_NAME.test(name)

const join = (root: string, ...parts: string[]) => [root.replace(/\/+$/, ''), ...parts].join('/')

/** Every analysis under `root`, most recently changed first. */
export async function listAnalyses(port: FsPort, root: string): Promise<Analysis[]> {
  const found: Analysis[] = []
  for (const parent of [ANALYSES, ...MIGRATED]) {
    const names = await port.readdir(join(root, parent)).catch(() => [] as string[])
    for (const entry of names) {
      if (entry.startsWith('.')) continue
      const path = join(root, parent, entry)
      const info = await port.stat(path)
      if (!info?.isDirectory) continue
      if (parent !== ANALYSES && !(await port.exists(join(path, MARKER)))) continue
      found.push({ name: parent === ANALYSES ? entry : `${parent}/${entry}`, path, modifiedMs: info.mtimeMs })
    }
  }
  return found.sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path))
}

/**
 * Makes `analyses/<name>/.analysis` and returns the folder. The mod creates its other
 * files on activation and never overwrites, so nothing else is written here.
 */
export async function createAnalysis(port: FsPort, root: string, name: string): Promise<string> {
  if (!validName(name)) throw new Error('Name a folder: letters, digits, ".", "_" or "-".')
  const dir = join(root, ANALYSES, name)
  await port.mkdir(dir)
  if (!(await port.exists(join(dir, MARKER)))) await port.writeFile(join(dir, MARKER), MARKER_TEXT)
  return dir
}
