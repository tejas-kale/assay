export const HOLD_MS = 500

/** Which hints a long press shows: `cmd` the Cmd shortcuts and analysis numbers, `ctrl` the pane numbers. */
export type HoldKind = 'cmd' | 'ctrl'

export type CmdHoldPort = {
  /** The hints to show, or undefined to hide them. */
  onChange(kind: HoldKind | undefined): void
  /** Starts a timer and returns the function that cancels it. */
  setTimer(cb: () => void, ms: number): () => void
}

const HOLD_KEYS: Record<string, HoldKind> = { MetaLeft: 'cmd', ControlLeft: 'ctrl' }
const MODIFIERS = /^(Shift|Alt|Control|Meta|CapsLock|Fn)/

/**
 * Long-pressing left Cmd or left Ctrl shows its hints. Any non-modifier key cancels them, so a normal shortcut (or
 * Ctrl-C in the terminal) never flashes them; holding both shows neither.
 */
export function cmdHold(port: CmdHoldPort) {
  let cancelTimer: (() => void) | undefined
  let visible: HoldKind | undefined
  const down = new Set<string>()

  function reset() {
    cancelTimer?.()
    cancelTimer = undefined
    if (visible) {
      visible = undefined
      port.onChange(undefined)
    }
  }

  return {
    key(type: 'keyDown' | 'keyUp', code: string) {
      const kind = HOLD_KEYS[code]
      if (kind) {
        if (type === 'keyUp') {
          down.delete(code)
          reset()
          return
        }
        down.add(code)
        if (down.size > 1) reset()
        else if (!cancelTimer && !visible) {
          cancelTimer = port.setTimer(() => {
            cancelTimer = undefined
            visible = kind
            port.onChange(kind)
          }, HOLD_MS)
        }
      } else if (type === 'keyDown' && !MODIFIERS.test(code)) {
        reset()
      }
    },
    blur() {
      down.clear()
      reset()
    },
  }
}
