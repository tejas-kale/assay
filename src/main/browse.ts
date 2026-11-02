// The Files tab: lists the analysis folder and opens a file. Paths from the renderer are relative
// and are checked to stay inside the analysis folder, symlinks included.
import { execFile } from 'node:child_process'
import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'

import { shell } from 'electron'

import { chartPage, ghosttyArgs, ghosttyTabArgs, isMermaidFile, kindByBytes, kindByName, walkFiles } from '../core/files.ts'
import type { FileEntry, FileKind } from '../core/files.ts'
import { resolveInside } from '../core/safePath.ts'
import type { OpenFileResult, PreviewResult } from '../shared/ipc.ts'

const run = promisify(execFile)
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
}

async function sniff(path: string): Promise<FileKind> {
  const file = await open(path, 'r')
  try {
    const head = new Uint8Array(4096)
    const { bytesRead } = await file.read(head, 0, head.length, 0)
    return kindByBytes(head.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}

export async function listFiles(folder: string): Promise<FileEntry[]> {
  const files = await walkFiles(
    {
      list: async path =>
        (await readdir(path, { withFileTypes: true })).map(e => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })),
      stat: async path => {
        try {
          const info = await stat(path)
          return { size: info.size, mtimeMs: info.mtimeMs }
        } catch {
          return undefined
        }
      },
    },
    folder,
  )
  return Promise.all(
    files.map(async f => ({ ...f, kind: kindByName(f.path) ?? (await sniff(`${folder}/${f.path}`).catch(() => 'other' as const)) })),
  )
}

// The GUI app's PATH is thin, so nvim is found once through the login shell.
let nvimPath: Promise<string> | undefined
const findNvim = () =>
  (nvimPath ??= run(process.env['SHELL'] || '/bin/zsh', ['-lic', 'command -v nvim'], { timeout: 10_000 })
    .then(({ stdout }) => stdout.trim().split('\n').pop() || 'nvim')
    .catch(() => 'nvim'))

/** The real path of a file inside `folder`, symlinks resolved, or why it cannot be used. Throws when it cannot be read. */
async function realFileInside(folder: string, target: string): Promise<{ real: string; size: number } | { message: string }> {
  const lexical = resolveInside(folder, target)
  if (!lexical) return { message: 'Outside the analysis folder' }
  const [realFolder, real] = await Promise.all([realpath(folder), realpath(lexical)])
  if (!resolveInside(realFolder, real)) return { message: 'Outside the analysis folder' }
  const info = await stat(real)
  if (!info.isFile()) return { message: 'Not a file' }
  return { real, size: info.size }
}

const imageDataUrl = async (real: string) =>
  `data:${MIME[extname(real).toLowerCase()] ?? 'application/octet-stream'};base64,${(await readFile(real)).toString('base64')}`

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const isMissing = (err: unknown) => err instanceof Error && 'code' in err && err.code === 'ENOENT'

export async function openFile(folder: string, target: string): Promise<OpenFileResult> {
  try {
    const found = await realFileInside(folder, target)
    if ('message' in found) return { ok: false, message: found.message }
    const { real, size } = found
    const kind = kindByName(target) ?? (await sniff(real))
    if (kind === 'image') {
      if (size > MAX_IMAGE_BYTES) return { ok: false, message: 'Image is too large to preview' }
      return { ok: true, how: 'image', dataUrl: await imageDataUrl(real) }
    }
    if (kind === 'text') {
      const nvim = await findNvim()
      // A new tab in the user's Ghostty; if that fails (say, Automation was denied), a new instance.
      await run('osascript', ghosttyTabArgs(nvim, folder, real), { timeout: 15_000 }).catch(() =>
        run('open', ghosttyArgs(nvim, folder, real)),
      )
      return { ok: true, how: 'nvim' }
    }
    const failed = await shell.openPath(real)
    return failed ? { ok: false, message: failed } : { ok: true, how: 'default' }
  } catch (err) {
    return { ok: false, message: messageOf(err) }
  }
}

const MAX_CHART_BYTES = 10 * 1024 * 1024

/**
 * Opens a Mermaid file's chart, drawn by the renderer as `svg`, in the default browser: as a page in a temp
 * folder, named after the file, which must be a Mermaid file inside the analysis.
 */
export async function openChart(folder: string, target: string, svg: string, colors: { bg: string; text: string }): Promise<OpenFileResult> {
  try {
    if (!isMermaidFile(target)) return { ok: false, message: 'Not a Mermaid file' }
    if (svg.length > MAX_CHART_BYTES) return { ok: false, message: 'The chart is too large to open' }
    const found = await realFileInside(folder, target)
    if ('message' in found) return { ok: false, message: found.message }
    const dir = join(tmpdir(), 'assay-charts')
    await mkdir(dir, { recursive: true })
    const page = join(dir, `${basename(folder)}-${basename(target).replace(/\.[^.]+$/, '')}.html`)
    await writeFile(page, chartPage(target, svg, colors), 'utf8')
    const failed = await shell.openPath(page)
    return failed ? { ok: false, message: failed } : { ok: true, how: 'browser' }
  } catch (err) {
    return { ok: false, message: messageOf(err) }
  }
}

const MAX_PREVIEW_BYTES = 256 * 1024

/** A file's content for a preview: the first MAX_PREVIEW_BYTES of text, an image, or just the size of anything else. */
export async function previewFile(folder: string, target: string): Promise<PreviewResult> {
  try {
    const found = await realFileInside(folder, target)
    if ('message' in found) return { ok: false, message: found.message }
    const { real, size } = found
    const kind = kindByName(target) ?? (await sniff(real))
    if (kind === 'image') {
      if (size > MAX_IMAGE_BYTES) return { ok: false, message: 'Image is too large to preview' }
      return { ok: true, kind: 'image', dataUrl: await imageDataUrl(real) }
    }
    if (kind === 'other') return { ok: true, kind: 'binary', size }
    const file = await open(real, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(size, MAX_PREVIEW_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return { ok: true, kind: 'text', text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: size > MAX_PREVIEW_BYTES }
    } finally {
      await file.close()
    }
  } catch (err) {
    return { ok: false, message: isMissing(err) ? 'File not found' : `Could not read: ${messageOf(err)}` }
  }
}
