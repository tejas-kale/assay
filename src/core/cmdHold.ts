export const HOLD_MS = 500

export type CmdHoldPort = {
  onChange(visible: boolean): void
  /** Starts a timer and returns the function that cancels it. */
  setTimer(cb: () => void, ms: number): () => void
}

const HOLD_KEY = 'MetaLeft'
const MODIFIERS = /^(Shift|Alt|Control|Meta|CapsLock|Fn)/

/**
 * Long-pressing left Cmd shows the navigation hints. Any non-modifier key cancels them, so a
 * normal shortcut never flashes them.
 */
export function cmdHold(port: CmdHoldPort) {
  let cancelTimer: (() => void) | undefined
  let visible = false

  function reset() {
    cancelTimer?.()
    cancelTimer = undefined
    if (visible) {
      visible = false
      port.onChange(false)
    }
  }

  return {
    key(type: 'keyDown' | 'keyUp', code: string) {
      if (code === HOLD_KEY) {
        if (type === 'keyUp') reset()
        else if (!cancelTimer && !visible) {
          cancelTimer = port.setTimer(() => {
            cancelTimer = undefined
            visible = true
            port.onChange(true)
          }, HOLD_MS)
        }
      } else if (type === 'keyDown' && !MODIFIERS.test(code)) {
        reset()
      }
    },
    blur: reset,
  }
}
