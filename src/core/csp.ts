// The renderer's content security policy, written into index.html at build (electron.vite.config.ts). The page shows
// text and diagrams that Claude or a query wrote; the policy is what stops a sanitiser bypass from running script.

// ghostty-web compiles its WebAssembly; nothing else is evaluated, and no script is inline.
const SCRIPTS = "'self' 'wasm-unsafe-eval'"
const CONNECT = "'self' data: blob:"

const PRODUCTION: Record<string, string> = {
  'default-src': "'self'",
  'script-src': SCRIPTS,
  'style-src': "'self' 'unsafe-inline'",
  'connect-src': CONNECT,
  'img-src': "'self' data:",
  'object-src': "'none'",
  'frame-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
}

// The dev server's React refresh preamble is an inline script, and its hot reload a websocket.
const DEV: Record<string, string> = {
  ...PRODUCTION,
  'script-src': `${SCRIPTS} 'unsafe-inline'`,
  'connect-src': `${CONNECT} ws:`,
}

/** The policy for the built app, or for the dev server. */
export const rendererCsp = (isDev: boolean) =>
  Object.entries(isDev ? DEV : PRODUCTION)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ')

/** The placeholder in index.html the build replaces with the policy. */
export const CSP_PLACEHOLDER = '__ASSAY_CSP__'
