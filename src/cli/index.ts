// A terminal adapter only: launch decisions and the spawn contract live in core.
import { writeSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAnalysis, isoDay, listAnalyses } from '../core/analyses.ts'
import { newCommand, openCommand } from '../core/open.ts'
import type { OpenCommand } from '../core/open.ts'
import { parseSettings } from '../core/settings.ts'
import { parseVenvBuild, venvStatusPath } from '../core/venv.ts'
import { backendStamp, installedStamp } from '../main/backend.ts'
import { fsPort } from '../main/fsAccess.ts'
import { resolveRoot } from '../main/rootPath.ts'

// Replaced at bundle time, so the CLI always selects its installed app version.
declare const ASSAY_VERSION: string
const read = (path: string) => readFile(path, 'utf8').catch(() => undefined)
const fileExists = (path: string) => stat(path).then(info => info.isFile(), () => false)

async function preparedBackend(backend: string) {
  const shipped = fileURLToPath(new URL('../../', import.meta.url))
  const expected = await backendStamp(shipped, { skipCaches: true }).catch(() => undefined)
  if (!expected) return undefined
  const actual = await backendStamp(backend).catch(() => undefined)
  return actual === expected && await installedStamp(backend) === expected ? expected : undefined
}

async function facts(slug?: string) {
  const userData = join(homedir(), 'Library', 'Application Support', 'Assay')
  const settings = parseSettings(await read(join(userData, 'settings.json')))
  const resolved = settings.root ? await resolveRoot(settings.root, homedir()) : undefined
  const root = resolved?.ok ? resolved.path : undefined
  const backend = join(userData, 'backend', ASSAY_VERSION)
  const venv = join(userData, 'venvs', ASSAY_VERSION)
  const stamp = await preparedBackend(backend)
  const build = parseVenvBuild(await read(venvStatusPath(venv)))
  return {
    slug, root, rootExists: root !== undefined, userData, version: ASSAY_VERSION, env: process.env,
    analyses: root ? (await listAnalyses(fsPort, root)).map(analysis => analysis.name) : [],
    backendReady: stamp !== undefined && await fileExists(join(backend, 'out/server/index.mjs')) && await fileExists(join(backend, 'plugin/.claude-plugin/plugin.json')),
    venvReady: stamp !== undefined && await installedStamp(venv) === stamp && build?.state === 'ready' && await fileExists(join(venv, 'bin/python')),
  }
}

const USAGE = 'Usage: assay open [slug] | assay new <title>'

async function command(verb: string | undefined, args: string[]): Promise<OpenCommand> {
  if (verb === 'open' && args.length <= 1) return openCommand(await facts(args[0]))
  if (verb !== 'new' || args.length === 0) throw new Error(USAGE)
  const known = await facts()
  // Unquoted words make one title: `assay new Panel churn Q4`.
  return newCommand(known, args.join(' '), async (root, title) => (await createAnalysis(fsPort, root, title, isoDay(new Date()))).name)
}

async function main() {
  const [, , verb, ...args] = process.argv
  const result = await command(verb, args)
  if (result.kind === 'error') throw new Error(result.message)
  if (result.kind === 'list') {
    console.log(result.message)
    return
  }
  if (!process.execve) throw new Error('assay requires Node 22.15 or later with process.execve support.')
  // Written synchronously: execve replaces the process before an async write to a pipe would finish.
  if (result.notice) writeSync(1, `${result.notice}\n`)
  process.chdir(result.spec.cwd)
  process.execve(result.spec.file, [result.spec.file, ...result.spec.args], result.spec.env)
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
