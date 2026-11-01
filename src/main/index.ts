import { Menu, app, session as electronSession } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { registerIpc } from './ipc.ts'
import { allContexts, createWindow, isLive, requestClose, setOnClosed } from './windows.ts'

function analysisRoot(): string {
  const configured = process.env['ANALYSIS_ROOT']
  if (!configured) return join(homedir(), 'Code', 'notes-src')
  return configured === '~' || configured.startsWith('~/') ? join(homedir(), configured.slice(1)) : configured
}

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitPending) app.quit()
})

app.on('activate', () => {
  if (allContexts().length === 0 && !quitPending) createWindow()
})

void app.whenReady().then(() => {
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  Menu.setApplicationMenu(buildMenu())
  registerIpc(analysisRoot())
  createWindow()
})
