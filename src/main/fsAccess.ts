// The file reads and writes every other file module in main builds on. Paths here always come from main's own state
// (the window's analysis folder and its root), never from the renderer.
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { FsPort } from '../core/analyses.ts'
import type { WatchPort } from '../core/watch.ts'

/** The root of an analysis folder: `<root>/analyses/<slug>`. */
export const rootOf = (analysisPath: string) => dirname(dirname(analysisPath))

export const isMissing = (err: unknown) => err instanceof Error && 'code' in err && err.code === 'ENOENT'
export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const fsPort: FsPort = {
  readdir: path => readdir(path),
  stat: async path => {
    try {
      const info = await stat(path)
      return { isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs }
    } catch {
      return undefined
    }
  },
  exists: async path => {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
  mkdir: async path => {
    await mkdir(path, { recursive: true })
  },
  readFile: path => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
}

export const watchPort: WatchPort = {
  stat: async path => {
    try {
      const info = await stat(path)
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      return undefined
    }
  },
  setInterval: (cb, ms) => {
    const timer = setInterval(cb, ms)
    return () => {
      clearInterval(timer)
    }
  },
}

/** The file's text, or '' when it does not exist yet. */
export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (isMissing(err)) return ''
    throw err
  }
}

/** The file's text, or undefined when it does not exist or cannot be read. */
export const maybeText = (path: string) => readFile(path, 'utf8').catch(() => undefined)

/** Writes to a temp file in the same folder, then renames over the target. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${String(process.pid)}.${String(Date.now())}.tmp`)
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw err
  }
}

/** The first `max` bytes of a file as text. */
export async function readHead(path: string, max: number): Promise<{ text: string; cut: boolean }> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const buffer = Buffer.alloc(Math.min(size, max))
    await file.read(buffer, 0, buffer.length, 0)
    return { text: buffer.toString('utf8'), cut: size > max }
  } finally {
    await file.close()
  }
}
