import { Menu, app, session as electronSession } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { fileURLToPath } from 'node:url'

import { CHANNELS } from '../shared/ipc.ts'
import { registerIpc } from './ipc.ts'
import { onDoctorChange, prepareBackend } from './runtime.ts'
import { installAndRelaunch, onUpdateChange, setOnRestart, startUpdater } from './update.ts'
import { allContexts, broadcast, closeAll, ensureWindow, followSystemTheme, hostWindow, isLive, setOnClosed, setOnKeepWaiting } from './windows.ts'

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

// Cmd+Q: run the close flow in every analysis and quit when the last session has exited. Restart to update runs the
// same flow and then installs the update instead of quitting; the open set is saved, so the relaunch reopens it.
let quitPending = false
let quitting = false
let installPending = false

function finishQuitIfDone() {
  if (!quitPending || quitting) return
  if (allContexts().some(isLive)) return
  quitting = true
  if (installPending) installAndRelaunch()
  else app.quit()
}

setOnRestart(() => {
  installPending = true
  quitPending = true
  closeAll()
  finishQuitIfDone()
})

app.on('before-quit', event => {
  if (quitting) return
  const live = allContexts().filter(isLive)
  if (live.length === 0) {
    quitting = true
    return
  }
  event.preventDefault()
  quitPending = true
  closeAll()
})

setOnClosed(() => {
  finishQuitIfDone()
})

// "Keep waiting" cancels the quit, so the next analysis close must not quit the app.
setOnKeepWaiting(() => {
  quitPending = false
  installPending = false
})

app.on('window-all-closed', () => {
  // A pending quit or restart ends through finishQuitIfDone, so a restart installs the update rather than just quitting.
  if (quitPending) finishQuitIfDone()
  else if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (!hostWindow() && !quitPending) ensureWindow(true)
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
  onDoctorChange(view => {
    broadcast(CHANNELS.doctorChanged, view)
  })
  onUpdateChange(view => {
    broadcast(CHANNELS.updateChanged, view)
  })
  void startUpdater()
  // Before any analysis starts Claude: startPty waits for the install.
  void prepareBackend().catch(() => undefined)
  followSystemTheme()
  ensureWindow(true)
})
