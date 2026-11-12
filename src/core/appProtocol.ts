// The packaged renderer is served from the app:// scheme, so the page's origin is the app alone and not every file:
// URL (audit UI-3). This is the rule for which file a request may read: only a file inside the renderer's folder.
import { realpathSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'

export const APP_SCHEME = 'app'
export const APP_HOST = 'assay'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_ENTRY = `${APP_ORIGIN}/index.html`

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
}

/** The content type for a file; a type the renderer does not use is served as opaque bytes. */
export const mimeType = (file: string) => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'

/**
 * The file an app:// request names, or undefined when it names anything else: another scheme or host, an encoded or
 * plain `..`, a path with a backslash or NUL, a missing file or folder, or a symlink that leads out of `root`.
 */
export function resolveAppFile(root: string, requestUrl: string): string | undefined {
  let url: URL
  let path: string
  try {
    url = new URL(requestUrl)
    path = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return undefined
  if (path.includes('\0') || path.includes('\\')) return undefined
  const parts = path.split('/').filter(part => part !== '')
  if (parts.some(part => part === '..' || part === '.')) return undefined
  try {
    const base = realpathSync(root)
    const real = realpathSync(join(base, ...(parts.length === 0 ? ['index.html'] : parts)))
    if (!real.startsWith(base + sep) || !statSync(real).isFile()) return undefined
    return real
  } catch {
    return undefined
  }
}
