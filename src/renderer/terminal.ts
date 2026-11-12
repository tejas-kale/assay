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
//     read from the renderer's metrics and divided into the element's size inside its padding.
//  7. `term.focus()` exists and focuses a hidden textarea or the canvas. `focus()` below checks that
//     focus really landed inside the element and falls back to focusing an inner element.
//  8. Text selection and Cmd+C copy work inside the terminal (Verify-first item 1).
//
// Read from ghostty-web 0.4.0's source and run: colours are fixed at creation, and `options.theme` and
// OSC 10/11/4 do nothing afterwards. A live theme switch therefore relies on `term.renderer`,
// `term.wasmTerm`, `term.viewportY` and the private `renderer.renderLine(cells, y, cols)`. Without them,
// a terminal keeps the theme it was created with and everything else still works.
import * as ghostty from 'ghostty-web'

import { cellAt, fitGrid, reportedSize, sizeChanged } from '../core/terminalGrid.ts'
import { inputOverride, leavesTerminal, wheelLines, wheelReport } from '../core/terminalKeys.ts'
import { MONO_FONT, THEMES, cellRecolor, minimumContrast } from '../core/theme.ts'
import type { CellColors, ThemeMode } from '../core/theme.ts'
import { currentMode, onModeChange } from './appearance.ts'

const FONT_SIZE = 13
const FONT_FAMILY = MONO_FONT
// Row height as a multiple of the font size. ghostty-web measures rows from "M", which has no
// descender, so its rows clip g, j and y and set lines touching; `roomyRows` replaces that.
const LINE_HEIGHT = 1.35
const RESIZE_DEBOUNCE_MS = 100
const FONT_SPEC = `${String(FONT_SIZE)}px ${FONT_FAMILY}`

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
  attachCustomKeyEventHandler?: (handler: (event: KeyboardEvent) => boolean) => void
  attachCustomWheelEventHandler?: (handler: (event: WheelEvent) => boolean) => void
  renderer?: RawRenderer
  wasmTerm?: RawWasmTerm
  viewportY?: number
  dispose(): void
}
type RawWasmTerm = { hasMouseTracking?: () => boolean; getMode?: (mode: number, isAnsi?: boolean) => boolean }
type CellMetrics = { width: number; height: number; baseline: number }
type RawRenderer = {
  metrics?: CellMetrics
  measureFont?: () => CellMetrics
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
  // Always on, after the theme swap: text a program drew in its own colour must still read.
  let legible = minimumContrast(original)
  renderer.renderLine = (cells, y, cols) => {
    drawLine.call(renderer, legible(recolor ? recolor(cells) : cells), y, cols)
  }

  return onModeChange(mode => {
    recolor = mode === created ? undefined : cellRecolor(original, THEMES[mode].terminal)
    legible = minimumContrast(THEMES[mode].terminal)
    renderer.setTheme(THEMES[mode].terminal)
    // The scrollbar comes back on the next scroll; the library tracks its fade privately.
    renderer.render(term.wasmTerm, true, term.viewportY ?? 0, term, 0)
  })
}

/** Cell metrics with room for ascenders and descenders, the glyphs centred in a `LINE_HEIGHT` row. */
function cellMetrics(): CellMetrics {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return { width: Math.ceil(FONT_SIZE * 0.6), height: Math.ceil(FONT_SIZE * LINE_HEIGHT), baseline: FONT_SIZE }
  ctx.font = FONT_SPEC
  const m = ctx.measureText('M')
  const ascent = m.fontBoundingBoxAscent || FONT_SIZE * 0.8
  const descent = m.fontBoundingBoxDescent || FONT_SIZE * 0.2
  const height = Math.max(Math.ceil(ascent + descent), Math.ceil(FONT_SIZE * LINE_HEIGHT))
  return { width: Math.ceil(m.width), height, baseline: Math.round((height - ascent - descent) / 2 + ascent) }
}

/** Makes the library use `cellMetrics`, now and whenever it remeasures. */
function roomyRows(term: RawTerminal) {
  const renderer = term.renderer
  if (!renderer?.metrics) return
  renderer.measureFont = cellMetrics
  renderer.metrics = cellMetrics()
}

/** The element's size inside its padding. */
function innerSize(el: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(el)
  const px = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0
  return {
    width: el.clientWidth - px('padding-left') - px('padding-right'),
    height: el.clientHeight - px('padding-top') - px('padding-bottom'),
  }
}

type Listeners = Set<(data: string) => void>

/** Starts the library and makes a terminal in `el`, in the system's theme and with room in its rows. */
async function openTerminal(el: HTMLElement) {
  await (library['init'] as () => Promise<unknown>)()
  // The canvas measures cells from the font as it is when the terminal is made: load it first, or the
  // cells are sized for the fallback. A missing font resolves to nothing and the fallback is used.
  await document.fonts.load(FONT_SPEC).catch(() => undefined)
  const Ctor = library['Terminal'] as new (options: unknown) => RawTerminal
  const created = currentMode()
  const term = new Ctor({ fontSize: FONT_SIZE, fontFamily: FONT_FAMILY, theme: THEMES[created].terminal })
  term.open(el)
  roomyRows(term)
  return { term, stopFollowingTheme: followSystemTheme(term, created) }
}

/** The library's fit addon, when it has one and the terminal can load it. */
function loadFitAddon(term: RawTerminal): RawFit | undefined {
  const FitCtor = library['FitAddon'] as (new () => RawFit) | undefined
  if (typeof FitCtor !== 'function' || typeof term.loadAddon !== 'function') return undefined
  const addon = new FitCtor()
  term.loadAddon(addon)
  return addon
}

/**
 * Keys the app owns, rewrites and wheel reports: all of them send input to `listeners`. Returns the undo.
 * The library listens on `el` and its textarea is the target, so stopping a Cmd key here in the capture phase
 * keeps it from the library without preventDefault, and the app menu still gets it.
 */
function routeInput(term: RawTerminal, el: HTMLElement, listeners: Listeners): () => void {
  const releaseKey = (event: KeyboardEvent) => {
    if (leavesTerminal(event)) event.stopPropagation()
  }
  el.addEventListener('keydown', releaseKey, true)
  // The library treats `true` as "handled": it skips its own encoding and calls preventDefault.
  term.attachCustomKeyEventHandler?.(event => {
    if (event.type !== 'keydown') return false
    const data = inputOverride(event)
    if (data === undefined) return false
    for (const cb of listeners) cb(data)
    return true
  })
  routeWheel(term, el, listeners)
  return () => {
    el.removeEventListener('keydown', releaseKey, true)
  }
}

/**
 * With mouse tracking on (Claude's full-screen view), the library turns the wheel into arrow keys;
 * send wheel reports instead so Claude scrolls its transcript. `true` means handled.
 */
function routeWheel(term: RawTerminal, el: HTMLElement, listeners: Listeners) {
  let carried = 0
  term.attachCustomWheelEventHandler?.(event => {
    const wasm = term.wasmTerm
    if (!wasm?.hasMouseTracking?.()) return false
    const [lines, carry] = wheelLines(event.deltaY, carried)
    carried = carry
    if (lines !== 0) {
      const cell = term.renderer?.metrics ?? cellMetrics()
      const origin = (el.querySelector('canvas') ?? el).getBoundingClientRect()
      const grid = { cols: term.cols ?? 80, rows: term.rows ?? 24 }
      const { col, row } = cellAt({ x: event.clientX, y: event.clientY }, origin, cell, grid)
      const data = wheelReport(lines, col, row, wasm.getMode?.(1006, false) ?? true)
      for (const cb of listeners) cb(data)
    }
    return true
  })
}

/** Fits the terminal to `el` and tells `listeners` when the size changed. Resizing the element refits after a pause. */
function createFitter(term: RawTerminal, el: HTMLElement, fitAddon: RawFit | undefined) {
  const listeners = new Set<(cols: number, rows: number) => void>()
  let last: TerminalSize | undefined

  function fit(): TerminalSize {
    if (fitAddon) {
      fitAddon.fit()
    } else if (typeof term.resize === 'function') {
      const grid = fitGrid(term.renderer?.metrics ?? cellMetrics(), innerSize(el))
      if (grid) term.resize(grid.cols, grid.rows)
    }
    const now = reportedSize(term.cols, term.rows)
    if (sizeChanged(last, now)) {
      last = now
      for (const cb of listeners) cb(now.cols, now.rows)
    }
    return now
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new ResizeObserver(() => {
    clearTimeout(timer)
    timer = setTimeout(fit, RESIZE_DEBOUNCE_MS)
  })
  observer.observe(el)

  return {
    fit,
    onResize(cb: (cols: number, rows: number) => void) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    stop() {
      clearTimeout(timer)
      observer.disconnect()
      listeners.clear()
    },
  }
}

/** Gives the terminal the keyboard focus, even when the library's own focus does nothing we can see. */
function focusTerminal(term: RawTerminal, el: HTMLElement) {
  term.focus?.()
  if (el.contains(document.activeElement)) return
  const inner = el.querySelector<HTMLElement>('textarea, [contenteditable="true"], canvas')
  if (!inner) {
    el.tabIndex = -1
    el.focus()
    return
  }
  if (inner.tabIndex < 0) inner.tabIndex = 0
  inner.focus()
}

export async function createTerminal(el: HTMLElement): Promise<TerminalHandle> {
  const { term, stopFollowingTheme } = await openTerminal(el)
  // Input goes to these, whether it comes from the library or from a key rewritten here.
  const dataListeners: Listeners = new Set()
  const stopRoutingInput = routeInput(term, el, dataListeners)
  const fitter = createFitter(term, el, loadFitAddon(term))
  return {
    write: data => {
      term.write(data)
    },
    onData(cb) {
      dataListeners.add(cb)
      const sub = term.onData(cb)
      return () => {
        dataListeners.delete(cb)
        sub?.dispose()
      }
    },
    onResize: cb => fitter.onResize(cb),
    fit: () => fitter.fit(),
    focus: () => {
      focusTerminal(term, el)
    },
    hasFocus: () => el.contains(document.activeElement),
    dispose() {
      fitter.stop()
      stopFollowingTheme()
      stopRoutingInput()
      dataListeners.clear()
      term.dispose()
    },
  }
}
