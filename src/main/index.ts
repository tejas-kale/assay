import { Menu, app, session as electronSession } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { fileURLToPath } from 'node:url'

import { RUNNING, shutdownOn } from '../core/shutdown.ts'
import type { Shutdown, ShutdownAction, ShutdownEvent } from '../core/shutdown.ts'
import { CHANNELS } from '../shared/ipc.ts'
import { registerIpc } from './ipc.ts'
import { onDoctorChange, prepareBackend } from './runtime.ts'
import { installAndRelaunch, onUpdateChange, setOnRestart, startUpdater } from './update.ts'
import { ensureWindow } from './windows.ts'
import { followSystemTheme } from './windowPages.ts'
import { allContexts, broadcast, hostWindow, isLive, setOnClosed } from './windowState.ts'
import { closeAll } from './windowViews.ts'

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

// Cmd+Q and Restart to update both close every analysis first, so each Claude exits and a launcher finishes its
// import; then the app quits or installs. The decisions are in core/shutdown.ts. The open set is not saved while the
// analyses close, so the next launch, or a failed install, reopens it.
let shutdown: Shutdown = RUNNING

const isAnyLive = () => allContexts().some(isLive)

function step(event: ShutdownEvent): ShutdownAction {
  const next = shutdownOn(shutdown, event)
  shutdown = next.state
  if (next.action === 'close-all') closeAll()
  else if (next.action === 'quit') app.quit()
  else if (next.action === 'install') installAndRelaunch(() => step({ type: 'install-failed' }))
  else if (next.action === 'reopen') ensureWindow(true)
  return next.action
}

setOnRestart(() => step({ type: 'restart', live: isAnyLive() }))

app.on('before-quit', event => {
  if (step({ type: 'quit', live: isAnyLive() }) !== 'allow-quit') event.preventDefault()
})

setOnClosed(() => step({ type: 'closed', live: isAnyLive() }))

app.on('window-all-closed', () => {
  if (step({ type: 'closed', live: isAnyLive() }) === 'none' && shutdown.phase === 'running' && process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (!hostWindow() && shutdown.phase === 'running') ensureWindow(true)
})

void app.whenReady().then(() => {
  // Terminal paste needs the clipboard; everything else stays denied.
  const allowed = (permission: string) => permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed(permission))
  })
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
