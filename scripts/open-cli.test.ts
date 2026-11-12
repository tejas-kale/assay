import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'

import { backendStamp, installBackend } from '../src/main/backend.ts'
import { ledgerPath } from '../src/core/trustLedger.ts'

const exec = promisify(execFile)
let shared: string
let shipped: string
let version: string
before(async () => {
  shared = await mkdtemp(join(tmpdir(), 'assay-cli-bundle-'))
  shipped = join(shared, 'shipped')
  await mkdir(join(shipped, 'plugin/.claude-plugin'), { recursive: true })
  await writeFile(join(shipped, 'plugin/.claude-plugin/plugin.json'), '{}')
  await exec(process.execPath, ['scripts/build-server.mjs', join(shipped, 'out')])
  const raw: unknown = JSON.parse(await readFile('package.json', 'utf8'))
  assert.ok(raw && typeof raw === 'object' && 'version' in raw && typeof raw.version === 'string')
  version = raw.version
})
after(async () => { await rm(shared, { recursive: true, force: true }) })

async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'assay-cli-world-'))
  const home = join(dir, 'home')
  const root = join(dir, 'root')
  const userData = join(home, 'Library/Application Support/Assay')
  await mkdir(userData, { recursive: true })
  await mkdir(join(root, 'analyses/sales'), { recursive: true })
  await writeFile(join(root, 'analyses/sales/analysis.yaml'), 'title: Sales\n')
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ root }))
  const backend = await installBackend({ shipped, home: userData, version })
  const venv = join(userData, 'venvs', version)
  await mkdir(join(venv, 'bin'), { recursive: true })
  await writeFile(join(venv, 'bin/python'), '')
  await writeFile(join(venv, '.assay-stamp'), await backendStamp(shipped))
  await writeFile(`${venv}.status.json`, JSON.stringify({ state: 'ready' }))
  const launcher = join(dir, 'launcher')
  const capture = join(dir, 'capture')
  await writeFile(launcher, '#!/bin/sh\nprintf "%s\\n" "$ASSAY_ANALYSIS" "$ASSAY_LEDGER" "$ASSAY_THEME" "$@" > "$ASSAY_CAPTURE"\n', { mode: 0o755 })
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash', ASSAY_CLAUDE_BIN: launcher, ASSAY_CAPTURE: capture, ASSAY_THEME: 'light-ansi' }
  const run = (...args: string[]) => exec(process.execPath, [resolve(shipped, 'out/cli/assay.mjs'), 'open', ...args], { env })
  return { dir, root, userData, backend, venv, capture, run }
}

test('the bundled CLI lists analyses and launches a stub with the installed app contract', async () => {
  const w = await world()
  try {
    assert.equal((await w.run()).stdout.trim(), 'sales')
    await assert.rejects(w.run('absent'), /Unknown analysis: absent\nKnown analyses:\nsales/)
    await w.run('sales')
    const output = await readFile(w.capture, 'utf8')
    assert.ok(output.startsWith(`${w.root}/analyses/sales\n${ledgerPath(w.userData, w.root)}\nlight-ansi\n`))
    assert.match(output, /--mcp-config\n.*mcpServers.*\n--plugin-dir\n/)
    assert.ok(output.endsWith(`${w.backend}/plugin\n`))
  } finally {
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('the bundled CLI refuses an unprepared venv and a changed backend', async () => {
  const w = await world()
  try {
    await rm(join(w.venv, 'bin/python'))
    await assert.rejects(w.run('sales'), /venv is not ready/)
    await writeFile(join(w.backend, 'out/server/index.mjs'), 'tampered')
    await assert.rejects(w.run('sales'), /backend is missing/)
    await rm(join(w.userData, 'settings.json'))
    await assert.rejects(w.run('sales'), /root is missing/)
  } finally {
    await rm(w.dir, { recursive: true, force: true })
  }
})
