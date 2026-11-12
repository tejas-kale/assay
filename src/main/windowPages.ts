// The pages a window's views load, and the rules every one of them follows.
import { app, nativeTheme } from 'electron'
import type { WebContents } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { THEMES } from '../core/theme.ts'
import { windowState } from './windowState.ts'

const here = dirname(fileURLToPath(import.meta.url))

export const webPreferences = {
  preload: join(here, '../preload/index.cjs'),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
}

export const windowBackground = () => THEMES[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'].ui.bg

/** Keeps the colour the window shows before and around its views in step with the system. */
export function followSystemTheme() {
  nativeTheme.on('updated', () => {
    const host = windowState.host
    if (host && !host.win.isDestroyed()) host.win.setBackgroundColor(windowBackground())
  })
}

export function loadPage(wc: WebContents, hash?: string) {
  // Only a dev build loads the dev server: a packaged app would show any page this names with the preload's API.
  const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void wc.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
  else void wc.loadFile(join(here, '../renderer/index.html'), hash ? { hash } : {})
}

/** The rules every page here follows: no new windows, no navigation away, no webviews. */
export function guardPage(wc: WebContents) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (url !== wc.getURL()) event.preventDefault()
  }
  wc.on('will-navigate', (event, url) => {
    guard(event, url)
  })
  wc.on('will-redirect', (event, url) => {
    guard(event, url)
  })
  wc.on('will-attach-webview', event => {
    event.preventDefault()
  })
}
