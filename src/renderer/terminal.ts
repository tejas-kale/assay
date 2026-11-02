// The only file that imports ghostty-web. If Verify-first item 1 forces a swap to xterm.js, this
// is the one file to change; the rest of the renderer sees only `TerminalHandle`.
//
// UNVERIFIED ASSUMPTIONS (the package was not installed when this was written; nothing here ran):
//  1. `init()` is an exported async function that loads the WASM with no arguments.
//  2. `new Terminal(options)` accepts `fontSize`, `fontFamily` and `theme` ({ background, foreground, ... }).
//     Unknown options are expected to be ignored.
//  3. `term.open(el)`, `term.write(string)` and `term.dispose()` exist, as in xterm.js.
//  4. `term.onData(cb)` calls `cb(string)` for user input and returns `{ dispose() }`.
//  5. `term.cols` and `term.rows` are numbers; `term.resize(cols, rows)` exists. Both are feature-detected.
//  6. A `FitAddon` export with `fit()` may exist. It is feature-detected; without it, the cell size is
//     measured from a hidden span that uses the same font family and size (assumes ghostty-web draws
//     cells of that size, and that the terminal element has no padding of its own).
//  7. `term.focus()` exists and focuses a hidden textarea or the canvas. `focus()` below checks that
//     focus really landed inside the element and falls back to focusing an inner element.
//  8. Text selection and Cmd+C copy work inside the terminal (Verify-first item 1).
//
// Read from ghostty-web 0.4.0's source and run: colours are fixed at creation, and `options.theme` and
// OSC 10/11/4 do nothing afterwards. A live theme switch therefore relies on `term.renderer`,
// `term.wasmTerm`, `term.viewportY` and the private `renderer.renderLine(cells, y, cols)`. Without them,
// a terminal keeps the theme it was created with and everything else still works.
import * as ghostty from 'ghostty-web'

import { THEMES, cellRecolor } from '../core/theme.ts'
import type { CellColors, ThemeMode } from '../core/theme.ts'
import { currentMode, onModeChange } from './appearance.ts'

const FONT_SIZE = 13
const FONT_FAMILY = 'Menlo, "SF Mono", Monaco, monospace'
const RESIZE_DEBOUNCE_MS = 100

export type TerminalSize = { cols: number; rows: number }

export type TerminalHandle = {
  write(data: string): void
  /** User input, as the string to send to the pty. */
  onData(cb: (data: string) => void): () => void
  /** Called when a fit changes the size, debounced when it comes from the element resizing. */
  onResize(cb: (cols: number, rows: number) => void): () => void
  /** Fits to the element now and returns the size. Call it before `pty.start`. */
  fit(): TerminalSize
  /** Gives the terminal keyboard focus. */
  focus(): void
  /** Whether keyboard focus is inside the terminal element. */
  hasFocus(): boolean
  dispose(): void
}

// What this file uses of the library, as guessed above.
type Disposable = { dispose(): void }
type RawTerminal = {
  cols?: number
  rows?: number
  open(el: HTMLElement): void
  write(data: string): void
  onData(cb: (data: string) => void): Disposable | undefined
  resize?: (cols: number, rows: number) => void
  focus?: () => void
  loadAddon?: (addon: unknown) => void
  renderer?: RawRenderer
  wasmTerm?: unknown
  viewportY?: number
  dispose(): void
}
type RawRenderer = {
  setTheme(theme: unknown): void
  render(buffer: unknown, forceAll: boolean, viewportY: number, scrollback: unknown, scrollbarOpacity: number): void
  renderLine?: (cells: CellColors[], y: number, cols: number) => void
}
type RawFit = { fit(): void }

const library = ghostty as unknown as Record<string, unknown>

/** Keeps an open terminal in the system's theme and repaints it on a switch. Returns the unsubscribe. */
function followSystemTheme(term: RawTerminal, created: ThemeMode): () => void {
  const renderer = term.renderer
  const drawLine = renderer?.renderLine
  if (!renderer || !drawLine || !term.wasmTerm) return () => {}

  const original = THEMES[created].terminal
  let recolor: ((cells: CellColors[]) => CellColors[]) | undefined
  renderer.renderLine = (cells, y, cols) => drawLine.call(renderer, recolor ? recolor(cells) : cells, y, cols)

  return onModeChange(mode => {
    recolor = mode === created ? undefined : cellRecolor(original, THEMES[mode].terminal)
    renderer.setTheme(THEMES[mode].terminal)
    // The scrollbar comes back on the next scroll; the library tracks its fade privately.
    renderer.render(term.wasmTerm, true, term.viewportY ?? 0, term, 0)
  })
}

/** Measures one cell of the terminal font. Fallback for when there is no fit addon. */
function measureCell(host: HTMLElement): { width: number; height: number } {
  const probe = document.createElement('span')
  probe.textContent = 'W'.repeat(20)
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${FONT_SIZE}px ${FONT_FAMILY};`
  host.appendChild(probe)
  const box = probe.getBoundingClientRect()
  probe.remove()
  return { width: box.width / 20, height: box.height }
}

export async function createTerminal(el: HTMLElement): Promise<TerminalHandle> {
  await (library['init'] as () => Promise<unknown>)()
  const Ctor = library['Terminal'] as new (options: unknown) => RawTerminal
  const created = currentMode()
  const term = new Ctor({ fontSize: FONT_SIZE, fontFamily: FONT_FAMILY, theme: THEMES[created].terminal })
  term.open(el)
  const stopFollowingTheme = followSystemTheme(term, created)

  let fitAddon: RawFit | undefined
  const FitCtor = library['FitAddon'] as (new () => RawFit) | undefined
  if (typeof FitCtor === 'function' && typeof term.loadAddon === 'function') {
    fitAddon = new FitCtor()
    term.loadAddon(fitAddon)
  }

  const resizeListeners = new Set<(cols: number, rows: number) => void>()
  let last: TerminalSize | undefined

  const size = (): TerminalSize => ({ cols: Math.max(1, term.cols ?? 80), rows: Math.max(1, term.rows ?? 24) })

  function fit(): TerminalSize {
    if (fitAddon) {
      fitAddon.fit()
    } else if (typeof term.resize === 'function') {
      const cell = measureCell(el)
      if (cell.width > 0 && cell.height > 0 && el.clientWidth > 0 && el.clientHeight > 0) {
        term.resize(Math.max(2, Math.floor(el.clientWidth / cell.width)), Math.max(1, Math.floor(el.clientHeight / cell.height)))
      }
    }
    const now = size()
    if (!last || last.cols !== now.cols || last.rows !== now.rows) {
      last = now
      for (const cb of resizeListeners) cb(now.cols, now.rows)
    }
    return now
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new ResizeObserver(() => {
    clearTimeout(timer)
    timer = setTimeout(fit, RESIZE_DEBOUNCE_MS)
  })
  observer.observe(el)

  const hasFocus = () => el.contains(document.activeElement)

  function focus() {
    term.focus?.()
    if (hasFocus()) return
    // The library's focus did nothing we can see: focus an inner element, else the host itself.
    const inner = el.querySelector<HTMLElement>('textarea, [contenteditable="true"], canvas')
    if (inner) {
      if (inner.tabIndex < 0) inner.tabIndex = 0
      inner.focus()
    } else {
      el.tabIndex = -1
      el.focus()
    }
  }

  return {
    write: data => term.write(data),
    onData(cb) {
      const sub = term.onData(cb)
      return () => sub?.dispose()
    },
    onResize(cb) {
      resizeListeners.add(cb)
      return () => resizeListeners.delete(cb)
    },
    fit,
    focus,
    hasFocus,
    dispose() {
      clearTimeout(timer)
      stopFollowingTheme()
      observer.disconnect()
      resizeListeners.clear()
      term.dispose()
    },
  }
}
