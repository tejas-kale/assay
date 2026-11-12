// How the Files tab words and decides things; the component only draws and sends.
import { isMermaidFile } from './files.ts'
import type { FileEntry } from './files.ts'

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 ** 2) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

const KIND_LABEL = { text: 'nvim', image: 'preview', other: 'open' } as const

/** What Enter does to the file, as the chip on its row says. */
export function chipLabel(file: FileEntry): string {
  return file.kind === 'text' && isMermaidFile(file.path) ? 'browser' : KIND_LABEL[file.kind]
}

/** A path as its folder (with the trailing slash, empty at the top) and its file name. */
export function splitPath(path: string): { folder: string; name: string } {
  const cut = path.lastIndexOf('/') + 1
  return { folder: path.slice(0, cut), name: path.slice(cut) }
}

export function openedMessage(how: 'nvim' | 'browser' | 'default', path: string): string {
  if (how === 'nvim') return `Opened ${path} in Neovim`
  if (how === 'browser') return `Opened the chart of ${path} in your browser`
  return `Opened ${path}`
}

/** The image `delta` places from `current` among `images`, wrapping; undefined when it would be `current` itself. */
export function stepImage<T extends { path: string }>(images: readonly T[], current: string, delta: number): T | undefined {
  const at = images.findIndex(f => f.path === current)
  const next = images[(at + delta + images.length) % images.length]
  return next && next.path !== current ? next : undefined
}

export type PreviewKey = 'close' | 'next' | 'previous'

const CLOSE_KEYS = new Set(['Escape', 'Enter', ' '])
const NEXT_KEYS = new Set(['j', 'l', 'ArrowRight', 'ArrowDown'])
const PREVIOUS_KEYS = new Set(['k', 'h', 'ArrowLeft', 'ArrowUp'])

/** A key while an image preview is open. */
export function previewKey(key: string): PreviewKey | undefined {
  if (CLOSE_KEYS.has(key)) return 'close'
  if (NEXT_KEYS.has(key)) return 'next'
  if (PREVIOUS_KEYS.has(key)) return 'previous'
  return undefined
}
