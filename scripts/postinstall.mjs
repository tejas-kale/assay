// Everywhere: points git at .githooks, so `git push` runs `npm run check` first (docs/developer/testing.md).
// Mac only (the Linux container has no Electron):
// 1. Repairs Electron's unpack. On Node 26, electron's install.js exits 0 having unpacked only part of the zip
//    and written no path.txt (extract-zip 2.0.1 is the likely cause). Unpacks the same verified zip with ditto.
// 2. Rebuilds node-pty for Electron's ABI and makes spawn-helper executable.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const ELECTRON_BIN = 'Electron.app/Contents/MacOS/Electron'

async function repairElectron() {
  const dir = join('node_modules', 'electron')
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const dist = join(dir, 'dist')
  const pathTxt = join(dir, 'path.txt')
  const ok = () => {
    try {
      execFileSync(join(dist, ELECTRON_BIN), ['--version'], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      return existsSync(pathTxt) && readFileSync(pathTxt, 'utf8') === ELECTRON_BIN
    } catch {
      return false
    }
  }
  if (ok()) return

  console.log(`postinstall: Electron ${version} is not unpacked correctly; unpacking it with ditto`)
  // @electron/get is electron's own dependency: it returns the cached zip, downloading and checksumming if needed.
  const { downloadArtifact } = createRequire(join(process.cwd(), dir, 'install.js'))('@electron/get')
  const zip = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: 'darwin',
    arch: process.arch,
    cacheRoot: process.env.electron_config_cache,
    checksums: JSON.parse(readFileSync(join(dir, 'checksums.json'), 'utf8')),
  })
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist)
  execFileSync('ditto', ['-x', '-k', zip, dist], { stdio: 'inherit' })
  writeFileSync(pathTxt, ELECTRON_BIN)
  if (!ok()) throw new Error(`postinstall: Electron still does not run after unpacking ${zip}`)
  console.log(`postinstall: Electron ${version} unpacked`)
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' })
} catch {
  // Not a git checkout (an installed tarball): no hooks to set.
}

if (process.platform === 'darwin') {
  await repairElectron()
  execFileSync('npx', ['electron-rebuild', '-f', '-w', 'node-pty'], { stdio: 'inherit' })

  const prebuilds = join('node_modules', 'node-pty', 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) {
      const helper = join(prebuilds, dir, 'spawn-helper')
      if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o111)
    }
  }
}
