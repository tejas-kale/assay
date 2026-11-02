// Ayu Light and Ayu Dark, the only source of the app's colours. The terminal colours are Ghostty's
// "Ayu" and "Ayu Light" themes. The UI colours are from the `ayu` npm package 9.1, using its darker
// `l1` shades for coloured text in Light, because Ayu's syntax colours are hard to read as small text there.

export type ThemeMode = 'light' | 'dark'

export type TerminalColors = {
  foreground: string
  background: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionForeground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export type Theme = {
  /** Each key becomes the CSS variable `--<key>`. */
  ui: Record<
    | 'bg' | 'panel' | 'line' | 'text' | 'dim' | 'accent' | 'info' | 'sel' | 'good' | 'warn' | 'bad' | 'closing' | 'ended'
    // Ayu's syntax colours, for the Code tab.
    | 'syn-keyword' | 'syn-string' | 'syn-number' | 'syn-comment' | 'syn-function' | 'syn-operator',
    string
  >
  terminal: TerminalColors
}

export const THEMES: Record<ThemeMode, Theme> = {
  light: {
    ui: {
      bg: '#f8f9fa',
      panel: '#fafafa',
      line: '#6b7d8f1f',
      text: '#5c6166',
      dim: '#828e9f',
      accent: '#f29718',
      info: '#1a91cd',
      sel: '#6b7d8f24',
      good: '#719700',
      warn: '#b37c00',
      bad: '#e65050',
      closing: '#ffe294',
      ended: '#ebeef0',
      'syn-keyword': '#e8790b',
      'syn-string': '#6c8f00',
      'syn-number': '#9461c7',
      'syn-comment': '#8a8f96',
      'syn-function': '#d18d0f',
      'syn-operator': '#d9733f',
    },
    terminal: {
      foreground: '#5c6166',
      background: '#f8f9fa',
      cursor: '#ffaa33',
      cursorAccent: '#f8f9fa',
      selectionBackground: '#035bd6',
      selectionForeground: '#f8f9fa',
      black: '#000000',
      red: '#ea6c6d',
      green: '#6cbf43',
      yellow: '#eca944',
      blue: '#3199e1',
      magenta: '#9e75c7',
      cyan: '#46ba94',
      white: '#bababa',
      brightBlack: '#686868',
      brightRed: '#f07171',
      brightGreen: '#86b300',
      brightYellow: '#f2ae49',
      brightBlue: '#399ee6',
      brightMagenta: '#a37acc',
      brightCyan: '#4cbf99',
      brightWhite: '#d1d1d1',
    },
  },
  dark: {
    ui: {
      bg: '#0b0e14',
      panel: '#141821',
      line: '#1b1f29',
      text: '#bfbdb6',
      dim: '#5a6378',
      accent: '#e6b450',
      info: '#59c2ff',
      sel: '#47526640',
      good: '#aad94c',
      warn: '#ffb454',
      bad: '#d95757',
      closing: '#4c4126',
      ended: '#1b1f29',
      'syn-keyword': '#ff8f40',
      'syn-string': '#aad94c',
      'syn-number': '#d2a6ff',
      'syn-comment': '#7d8590',
      'syn-function': '#ffb454',
      'syn-operator': '#f29668',
    },
    terminal: {
      foreground: '#bfbdb6',
      background: '#0b0e14',
      cursor: '#e6b450',
      cursorAccent: '#0b0e14',
      selectionBackground: '#409fff',
      selectionForeground: '#0b0e14',
      black: '#11151c',
      red: '#ea6c73',
      green: '#7fd962',
      yellow: '#f9af4f',
      blue: '#53bdfa',
      magenta: '#cda1fa',
      cyan: '#90e1c6',
      white: '#c7c7c7',
      brightBlack: '#686868',
      brightRed: '#f07178',
      brightGreen: '#aad94c',
      brightYellow: '#ffb454',
      brightBlue: '#59c2ff',
      brightMagenta: '#d2a6ff',
      brightCyan: '#95e6cb',
      brightWhite: '#ffffff',
    },
  },
}

/** The terminal colours a cell can hold: its default foreground and background and the 16 ANSI colours. */
const CELL_COLORS = [
  'foreground',
  'background',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

export type CellColors = { fg_r: number; fg_g: number; fg_b: number; bg_r: number; bg_g: number; bg_b: number }

const hexToInt = (hex: string) => Number.parseInt(hex.slice(1), 16)

/**
 * ghostty-web fixes a terminal's colours when it is created and stores each cell as plain RGB, with
 * no way to change them later. So a terminal keeps the theme it was created with, and this returns
 * what repaints its cells in another theme. Colours outside the theme, such as a program's own
 * truecolor, are left alone. The input is not changed, because the library may render the same cells again.
 */
export function cellRecolor(from: TerminalColors, to: TerminalColors) {
  const swaps = new Map(CELL_COLORS.map(name => [hexToInt(from[name]), hexToInt(to[name])]))
  return <Cell extends CellColors>(cells: readonly Cell[]): Cell[] =>
    cells.map(cell => {
      const fg = swaps.get((cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b)
      const bg = swaps.get((cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b)
      if (fg === undefined && bg === undefined) return cell
      const next = { ...cell }
      if (fg !== undefined) {
        next.fg_r = fg >> 16
        next.fg_g = (fg >> 8) & 255
        next.fg_b = fg & 255
      }
      if (bg !== undefined) {
        next.bg_r = bg >> 16
        next.bg_g = (bg >> 8) & 255
        next.bg_b = bg & 255
      }
      return next
    })
}

/** WCAG relative luminance of an sRGB colour. */
function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio of two colours, 1 (same) to 21 (black on white). */
export function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [x, y] = [luminance(...a), luminance(...b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Below this, text is unreadable (white on Light's background is 1.05); Claude's dim grey is about 3, and stays. */
export const MIN_CONTRAST = 2

const rgb = (hex: string): [number, number, number] => {
  const n = hexToInt(hex)
  return [n >> 16, (n >> 8) & 255, n & 255]
}

/**
 * A program can draw text in its own truecolor, such as Claude Code's dark-theme white, which the
 * theme cannot recolour. This repaints any text under MIN_CONTRAST against its own cell background
 * with whichever of the theme's text and background colours reads better there. Input is not changed.
 */
export function minimumContrast(theme: TerminalColors) {
  const choices = [rgb(theme.foreground), rgb(theme.background)]
  // Every line is checked on every draw, so each fg/bg pair is worked out once: undefined means it reads.
  const memo = new Map<string, [number, number, number] | undefined>()
  const fixFor = (fg: [number, number, number], bg: [number, number, number]) => {
    const key = `${fg.join()},${bg.join()}`
    if (memo.has(key)) return memo.get(key)
    const fix = contrastRatio(fg, bg) >= MIN_CONTRAST ? undefined : choices.reduce((a, b) => (contrastRatio(b, bg) > contrastRatio(a, bg) ? b : a))
    if (memo.size > 4096) memo.clear()
    memo.set(key, fix)
    return fix
  }
  return <Cell extends CellColors>(cells: readonly Cell[]): Cell[] =>
    cells.map(cell => {
      const best = fixFor([cell.fg_r, cell.fg_g, cell.fg_b], [cell.bg_r, cell.bg_g, cell.bg_b])
      return best ? { ...cell, fg_r: best[0], fg_g: best[1], fg_b: best[2] } : cell
    })
}
