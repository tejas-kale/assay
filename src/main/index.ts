import { Menu, app, session as electronSession } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { fileURLToPath } from 'node:url'

import { registerIpc } from './ipc.ts'
import { allContexts, createWindow, isLive, requestClose, setOnClosed, setOnKeepWaiting } from './windows.ts'

// Only standard roles. Shortcuts of the app's own commands (Cmd+W, Cmd+N, ...) live in core/keymap.ts
// and are caught in before-input-event; a duplicate accelerator here would fire twice.
function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
  ]
  return Menu.buildFromTemplate(template)
}

// Cmd+Q: run the close flow in every window and quit when the last session has exited.
let quitPending = false
let quitting = false

function finishQuitIfDone() {
  if (!quitPending || quitting) return
  if (allContexts().some(isLive)) return
  quitting = true
  app.quit()
}

app.on('before-quit', event => {
  if (quitting) return
  const live = allContexts().filter(isLive)
  if (live.length === 0) {
    quitting = true
    return
  }
  event.preventDefault()
  quitPending = true
  for (const ctx of allContexts()) requestClose(ctx)
})

setOnClosed(() => {
  finishQuitIfDone()
})

// "Keep waiting" cancels the quit, so the next window close must not quit the app.
setOnKeepWaiting(() => {
  quitPending = false
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitPending) app.quit()
})

app.on('activate', () => {
  if (allContexts().length === 0 && !quitPending) createWindow()
})

void app.whenReady().then(() => {
  // Terminal paste needs the clipboard; everything else stays denied.
  const allowed = (permission: string) => permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)))
  electronSession.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission))
  // v1 runs unpackaged, so the Dock icon is set here rather than from an app bundle.
  app.dock?.setIcon(fileURLToPath(new URL('../../resources/icon.png', import.meta.url)))
  Menu.setApplicationMenu(buildMenu())
  registerIpc()
  createWindow()
})
