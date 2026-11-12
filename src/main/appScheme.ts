// The app:// scheme the packaged renderer loads from (core/appProtocol.ts holds the rule for what it may read).
import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { APP_SCHEME, mimeType, resolveAppFile } from '../core/appProtocol.ts'

const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '../renderer')

/** Before the app is ready: a standard, secure scheme gives the page a real origin, so 'self' means the app alone. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

/** Once the app is ready: answers app:// requests from the renderer's folder only, and 404 for anything else. */
export function serveAppScheme() {
  protocol.handle(APP_SCHEME, async request => {
    const file = resolveAppFile(rendererRoot, request.url)
    if (!file) return new Response('Not found', { status: 404 })
    try {
      return new Response(new Uint8Array(await readFile(file)), { headers: { 'content-type': mimeType(file) } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
