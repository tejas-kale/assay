// Rebuilds node-pty for Electron's ABI. Only on the Mac: the Linux container has no Electron.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform === 'darwin') {
  execFileSync('npx', ['electron-rebuild', '-f', '-w', 'node-pty'], { stdio: 'inherit' })

  const prebuilds = join('node_modules', 'node-pty', 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) {
      const helper = join(prebuilds, dir, 'spawn-helper')
      if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o111)
    }
  }
}
