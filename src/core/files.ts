// The Files tab: every file in an analysis folder, and how each opens.

export type FileKind = 'text' | 'image' | 'other'
export type FileEntry = { path: string; size: number; mtimeMs: number; kind: FileKind }

export type WalkPort = {
  /** Entries of a folder; rejects when it cannot be read. */
  list(path: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]>
  stat(path: string): Promise<{ size: number; mtimeMs: number } | undefined>
}

/** Folders that are tooling, not analysis. */
const SKIP_DIRS = new Set(['.git', '.venv', 'node_modules', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.assay', '__marimo__', '.ipynb_checkpoints'])
const SKIP_FILES = new Set(['.DS_Store'])
export const MAX_FILES = 5000

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const TEXT = new Set([
  'md', 'txt', 'sql', 'py', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'sh', 'zsh', 'bash',
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'html', 'css', 'xml', 'r', 'ipynb', 'log', 'env', 'lock', 'gitignore', 'analysis',
])
const BINARY = new Set(['npy', 'npz', 'parquet', 'pkl', 'pickle', 'feather', 'arrow', 'zip', 'gz', 'tar', 'pdf', 'xlsx', 'xls', 'docx', 'pptx', 'db', 'sqlite', 'duckdb', 'h5', 'mp4', 'mov'])

/** By extension; `undefined` when the extension does not say, so the caller looks at the bytes. */
export function kindByName(name: string): FileKind | undefined {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  const ext = dot < 0 ? '' : base.slice(dot + 1).toLowerCase()
  if (dot === 0) return 'text' // .gitignore, .analysis, .env
  if (IMAGE.has(ext)) return 'image'
  if (TEXT.has(ext)) return 'text'
  if (BINARY.has(ext)) return 'other'
  return undefined
}

/** Text unless the first bytes hold a NUL. */
export const kindByBytes = (head: Uint8Array): FileKind => (head.includes(0) ? 'other' : 'text')

/** Every file under `root`, newest first, as paths relative to it. Stops at MAX_FILES. */
export async function walkFiles(port: WalkPort, root: string): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  const found: { path: string; size: number; mtimeMs: number }[] = []
  const queue = ['']
  while (queue.length > 0 && found.length < MAX_FILES) {
    const rel = queue.shift() ?? ''
    const entries = await port.list(rel ? `${root}/${rel}` : root).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path)
      } else if (entry.isFile && !SKIP_FILES.has(entry.name)) {
        const info = await port.stat(`${root}/${path}`)
        if (info) found.push({ path, ...info })
        if (found.length >= MAX_FILES) break
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
}

/** Ghostty's arguments to open `file` in Neovim, starting in `cwd`. `-e` takes the rest of the line, so it comes last. */
export const ghosttyArgs = (nvim: string, cwd: string, file: string) => [
  '-na', 'Ghostty', '--args', `--working-directory=${cwd}`, '--quit-after-last-window-closed=true', '-e', nvim, file,
]
