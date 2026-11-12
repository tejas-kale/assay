import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const exec = promisify(execFile)
async function installerWorld() {
  const home = await mkdtemp(join(tmpdir(), 'assay-cli-install-'))
  const bin = join(home, 'bin')
  await mkdir(bin)
  const run = () => exec(process.execPath, [resolve('scripts/install-cli.mjs')], { env: { ...process.env, HOME: home, PATH: bin } })
  return { home, bin, run, target: join(bin, 'assay') }
}

test('installing the CLI writes an executable on PATH and can update its own launcher', async () => {
  const w = await installerWorld()
  try {
    await w.run()
    await w.run()
    assert.match(await readFile(w.target, 'utf8'), /exec node \/Applications\/Assay.app/)
    assert.equal((await stat(w.target)).mode & 0o111, 0o111)
  } finally {
    await rm(w.home, { recursive: true, force: true })
  }
})

test('installing the CLI preserves an unrelated command with the same name', async () => {
  const w = await installerWorld()
  try {
    await writeFile(w.target, '# custom command\n')
    await assert.rejects(w.run(), /already exists and is not Assay/)
    assert.equal(await readFile(w.target, 'utf8'), '# custom command\n')
  } finally {
    await rm(w.home, { recursive: true, force: true })
  }
})
