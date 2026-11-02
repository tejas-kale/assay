// Follows the system's light or dark setting. Main leaves `nativeTheme.themeSource` on `system`, so
// this media query tracks macOS, including an automatic switch while the app is open.
import { THEMES } from '../core/theme.ts'
import type { ThemeMode } from '../core/theme.ts'

const media = window.matchMedia('(prefers-color-scheme: dark)')

export const currentMode = (): ThemeMode => (media.matches ? 'dark' : 'light')

export function onModeChange(cb: (mode: ThemeMode) => void): () => void {
  const listener = () => cb(currentMode())
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function applyUi(mode: ThemeMode) {
  const { style } = document.documentElement
  for (const [name, value] of Object.entries(THEMES[mode].ui)) style.setProperty(`--${name}`, value)
}

/** Sets the CSS colour variables now and whenever the system setting changes. */
export function startAppearance() {
  applyUi(currentMode())
  onModeChange(applyUi)
}
