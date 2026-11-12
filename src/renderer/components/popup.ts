// What the pop-ups over the window share: they take the keys shortly after opening, and Esc, Tab or q closes them.
import { useEffect } from 'react'
import type { KeyboardEvent, RefObject } from 'react'

const FOCUS_DELAY_MS = 50

/** Takes the focus shortly after opening, unless something inside already has it (an editor, say). */
export function useFocusOnOpen(box: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!box.current?.contains(document.activeElement)) box.current?.focus()
    }, FOCUS_DELAY_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [box])
}

/** The key handler of a pop-up: Esc, Tab or q (without Cmd, Ctrl or Alt) closes it, and the key goes no further. */
export function closeOnKeys(onClose: () => void) {
  return (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Escape' || e.key === 'Tab' || e.key === 'q') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }
}
