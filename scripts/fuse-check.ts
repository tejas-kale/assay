// The fuse check (docs/developer/security.md): the release job reads the fuses of the built app and fails unless each
// one is as `build.electronFuses` in package.json sets it. electron-builder flips them at packaging; this proves it did.
// `node scripts/fuse-check.ts <path to Assay.app>`.
import { getCurrentFuseWire } from '@electron/fuses'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The fuse wire's order (@electron/fuses' FuseV1Options), under electron-builder's names for them.
export const FUSE_NAMES = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
] as const

// @electron/fuses' FuseState: the ASCII bytes '0' and '1' in the binary.
const DISABLED = 48
const ENABLED = 49

/**
 * The problems with a built app's fuses: each fuse package.json does not set (so that a fuse a new Electron adds is
 * decided, not inherited), and each one whose state in the binary differs from the setting.
 */
export function fuseProblems(expected: Readonly<Record<string, unknown>>, wire: Readonly<Record<number, number | undefined>>): string[] {
  const problems: string[] = []
  FUSE_NAMES.forEach((name, index) => {
    const want = expected[name]
    if (typeof want !== 'boolean') {
      problems.push(`${name}: not set in package.json build.electronFuses`)
      return
    }
    const state = wire[index]
    if (state !== (want ? ENABLED : DISABLED)) problems.push(`${name}: expected ${want ? 'on' : 'off'}, the app has ${describe(state)}`)
  })
  return problems
}

function describe(state: number | undefined): string {
  if (state === ENABLED) return 'on'
  if (state === DISABLED) return 'off'
  return state === undefined ? 'no such fuse' : `state ${String(state)}`
}

async function main(app: string): Promise<number> {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { build: { electronFuses: Record<string, unknown> } }
  const wire = (await getCurrentFuseWire(app)) as unknown as Record<number, number | undefined>
  const problems = fuseProblems(pkg.build.electronFuses, wire)
  for (const problem of problems) console.error(`fuse ${problem}`)
  if (problems.length === 0) console.log(`All ${String(FUSE_NAMES.length)} fuses are as package.json sets them`)
  return problems.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = process.argv[2]
  if (!app) {
    console.error('usage: node scripts/fuse-check.ts <path to Assay.app>')
    process.exit(2)
  }
  process.exit(await main(app))
}
