// What a preview shows for a file's content: one of a few views, decided here so the component only draws it.
import type { PreviewResult } from '../shared/ipc.ts'

export type PreviewView =
  | { view: 'reading' }
  | { view: 'error'; message: string }
  | { view: 'image'; dataUrl: string }
  | { view: 'binary'; size: string }
  | { view: 'diagram'; text: string }
  | { view: 'code'; text: string; truncated: boolean }

const KB = 1024
const MB = KB ** 2

/** A byte count for people: bytes below 1 KB, whole KB below 1 MB, MB with one decimal above. */
export function fileSize(bytes: number): string {
  if (bytes < KB) return `${String(bytes)} B`
  if (bytes < MB) return `${String(Math.round(bytes / KB))} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

const isMermaidPath = (path: string | undefined) => path !== undefined && /\.(mmd|mermaid)$/i.test(path)

/** The view for `shown` (still being read when undefined) from the file at `path` (none for a piece of text). */
export function previewView(shown: PreviewResult | undefined, path: string | undefined): PreviewView {
  if (shown === undefined) return { view: 'reading' }
  if (!shown.ok) return { view: 'error', message: shown.message }
  if (shown.kind === 'image') return { view: 'image', dataUrl: shown.dataUrl }
  if (shown.kind === 'binary') return { view: 'binary', size: fileSize(shown.size) }
  if (isMermaidPath(path)) return { view: 'diagram', text: shown.text }
  return { view: 'code', text: shown.text, truncated: shown.truncated }
}
