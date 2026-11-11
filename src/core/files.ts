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
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'html', 'css', 'xml', 'r', 'ipynb', 'log', 'env', 'lock', 'gitignore', 'analysis', 'mmd', 'mermaid',
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

/** A Mermaid chart file: Enter draws it and opens the chart in the default browser, instead of Neovim. */
export const isMermaidFile = (path: string) => /\.(mmd|mermaid)$/i.test(path)

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => `&#${String(c.charCodeAt(0))};`)

/**
 * A page holding one drawn chart, for the browser. Its policy allows no scripts, so the page shows the
 * SVG and nothing it carries can run. `colors` are the app theme's, so the page matches the app.
 */
export function chartPage(title: string, svg: string, colors: { bg: string; text: string }): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>${escapeHtml(title)}</title>
<style>
body { margin: 0; padding: 24px; background: ${colors.bg}; color: ${colors.text}; font: 13px -apple-system, sans-serif; }
h1 { font-size: 13px; font-weight: 600; margin: 0 0 16px; }
svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
</style></head>
<body><h1>${escapeHtml(title)}</h1>
${svg}
</body></html>
`
}

/** Text unless the first bytes hold a NUL. */
export const kindByBytes = (head: Uint8Array): FileKind => (head.includes(0) ? 'other' : 'text')

type FoundFile = { path: string; size: number; mtimeMs: number }
type WalkEntry = Awaited<ReturnType<WalkPort['list']>>[number]
type Walk = { port: WalkPort; root: string; queue: string[]; found: FoundFile[] }

/** Queues a folder for the walk, or adds a file's size and time to `found`. */
async function visit(walk: Walk, rel: string, entry: WalkEntry) {
  const path = rel ? `${rel}/${entry.name}` : entry.name
  if (entry.isDirectory) {
    if (!SKIP_DIRS.has(entry.name)) walk.queue.push(path)
  } else if (entry.isFile && !SKIP_FILES.has(entry.name)) {
    const info = await walk.port.stat(`${walk.root}/${path}`)
    if (info) walk.found.push({ path, ...info })
  }
}

/** Every file under `root`, newest first, as paths relative to it. Stops at MAX_FILES. */
export async function walkFiles(port: WalkPort, root: string): Promise<FoundFile[]> {
  const walk: Walk = { port, root, queue: [''], found: [] }
  while (walk.queue.length > 0 && walk.found.length < MAX_FILES) {
    const rel = walk.queue.shift() ?? ''
    const entries = await port.list(rel ? `${root}/${rel}` : root).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      await visit(walk, rel, entry)
      if (walk.found.length >= MAX_FILES) break
    }
  }
  return walk.found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
}

const QUOTE_ESCAPE = "'\\''"

/** POSIX single-quoting, so a path with spaces or quotes stays one word. */
const shellQuote = (word: string) => `'${word.replace(/'/g, QUOTE_ESCAPE)}'`

const NEW_TAB_SCRIPT = `on run argv
  set cmd to item 1 of argv
  set dir to item 2 of argv
  tell application "Ghostty"
    set cfg to new surface configuration
    set command of cfg to cmd
    set initial working directory of cfg to dir
    if (count of windows) > 0 then
      new tab in front window with configuration cfg
    else
      new window with configuration cfg
    end if
    activate
  end tell
end run`

/** `osascript` arguments that open `file` in Neovim as a new tab of Ghostty's front window (a new window when none is open). Paths travel as `argv`, never inside the script text. */
export const ghosttyTabArgs = (nvim: string, cwd: string, file: string) => [
  '-e', NEW_TAB_SCRIPT, `${shellQuote(nvim)} ${shellQuote(file)}`, cwd,
]

/** Fallback: a new Ghostty instance running Neovim. `-e` takes the rest of the line, so it comes last. */
export const ghosttyArgs = (nvim: string, cwd: string, file: string) => [
  '-na', 'Ghostty', '--args', `--working-directory=${cwd}`, '--quit-after-last-window-closed=true', '-e', nvim, file,
]
