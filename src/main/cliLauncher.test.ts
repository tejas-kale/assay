import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { installLauncher } from './cliLauncher.ts'

async function world() {
  const home = await mkdtemp(join(tmpdir(), 'assay-launcher-'))
  return { home, local: join(home, '.local/bin'), bin: join(home, 'bin') }
}

test('the launcher goes into the first writable PATH folder and runs the given app', async () => {
  const w = await world()
  try {
    const result = await installLauncher({ entry: '/Apps/Assay.app/cli.mjs', path: `/usr/bin:${w.bin}:${w.local}`, home: w.home })
    assert.deepEqual(result, { state: 'installed', target: join(w.local, 'assay') })
    assert.match(await readFile(result.target, 'utf8'), /\nexec node \/Apps\/Assay.app\/cli.mjs "\$@"\n$/)
    assert.equal((await stat(result.target)).mode & 0o111, 0o111)
    assert.deepEqual(await installLauncher({ entry: '/Apps/Assay.app/cli.mjs', path: w.local, home: w.home }), { state: 'current', target: result.target })
    // The app moved: Assay's own launcher follows it.
    assert.equal((await installLauncher({ entry: '/Moved/cli.mjs', path: w.local, home: w.home })).state, 'installed')
    assert.match(await readFile(result.target, 'utf8'), /exec node \/Moved\/cli.mjs/)
  } finally {
    await rm(w.home, { recursive: true, force: true })
  }
})

test('the launcher never replaces another command, and needs a command folder on PATH', async () => {
  const w = await world()
  try {
    await mkdir(w.bin, { recursive: true })
    await writeFile(join(w.bin, 'assay'), '# custom command\n')
    await assert.rejects(installLauncher({ entry: '/x.mjs', path: w.bin, home: w.home }), /already exists and is not Assay/)
    assert.equal(await readFile(join(w.bin, 'assay'), 'utf8'), '# custom command\n')
    await assert.rejects(installLauncher({ entry: '/x.mjs', path: '/usr/bin', home: w.home }), /No writable command folder on PATH/)
  } finally {
    await rm(w.home, { recursive: true, force: true })
  }
})
