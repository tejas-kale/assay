import { paletteKey } from './dialogKeys.ts'
import type { PaletteKey } from './dialogKeys.ts'

/** What a key does in the search box: the palette's keys, Tab for the preview, Ctrl-D and Ctrl-U to scroll it. */
export type SearchKey = PaletteKey | 'togglePreview' | 'scrollDown' | 'scrollUp'

export function searchKey(key: string, ctrl: boolean, composing: boolean): SearchKey | undefined {
  if (composing) return undefined
  const moved = paletteKey(key, ctrl, composing)
  if (moved === 'next' || moved === 'previous') return moved
  if (key === 'Tab') return 'togglePreview'
  if (ctrl && key === 'd') return 'scrollDown'
  if (ctrl && key === 'u') return 'scrollUp'
  return moved
}
