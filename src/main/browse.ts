// The Files tab: lists the analysis folder and opens a file. Paths from the renderer are relative
// and are checked to stay inside the analysis folder, symlinks included.
import { execFile } from 'node:child_process'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { promisify } from 'node:util'

import { shell } from 'electron'

import { ghosttyArgs, ghosttyTabArgs, kindByBytes, kindByName, walkFiles } from '../core/files.ts'
import type { FileEntry, FileKind } from '../core/files.ts'
import { resolveInside } from '../core/safePath.ts'
import type { OpenFileResult } from '../shared/ipc.ts'

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

export async function openFile(folder: string, target: string): Promise<OpenFileResult> {
  const lexical = resolveInside(folder, target)
  if (!lexical) return { ok: false, message: 'Outside the analysis folder' }
  try {
    const [realFolder, real] = await Promise.all([realpath(folder), realpath(lexical)])
    if (!resolveInside(realFolder, real)) return { ok: false, message: 'Outside the analysis folder' }
    const info = await stat(real)
    if (!info.isFile()) return { ok: false, message: 'Not a file' }
    const kind = kindByName(target) ?? (await sniff(real))
    if (kind === 'image') {
      if (info.size > MAX_IMAGE_BYTES) return { ok: false, message: 'Image is too large to preview' }
      const mime = MIME[extname(real).toLowerCase()] ?? 'application/octet-stream'
      return { ok: true, how: 'image', dataUrl: `data:${mime};base64,${(await readFile(real)).toString('base64')}` }
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
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
