/** What a key does in a one-input dialog: Enter confirms, Escape cancels, anything else (or an IME) is left alone. */
export type DialogKey = 'confirm' | 'cancel'

export function dialogKey(key: string, composing: boolean): DialogKey | undefined {
  if (composing) return undefined
  if (key === 'Enter') return 'confirm'
  if (key === 'Escape') return 'cancel'
  return undefined
}

/** What a key does in the command palette: the dialog keys, plus Down/Up (arrows or Ctrl-n/Ctrl-p) as a step. */
export type PaletteKey = DialogKey | 'next' | 'previous'

export function paletteKey(key: string, ctrl: boolean, composing: boolean): PaletteKey | undefined {
  if (composing) return undefined
  if (key === 'ArrowDown' || (ctrl && key === 'n')) return 'next'
  if (key === 'ArrowUp' || (ctrl && key === 'p')) return 'previous'
  return dialogKey(key, composing)
}
