// A terminal adapter only: launch decisions and the spawn contract live in core.
import { writeSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { emitKeypressEvents } from 'node:readline'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cliVerb, helpText, USAGE } from '../core/cliHelp.ts'
import { cleanTitle, createAnalysis, isoDay, listAnalyses } from '../core/analyses.ts'
import { newCommand, openCommand } from '../core/open.ts'
import type { Choice, OpenCommand } from '../core/open.ts'
import { pickerScreen, pickerStep } from '../core/termPicker.ts'
import type { TermKey, TermPickerEffect } from '../core/termPicker.ts'
import { parseSettings } from '../core/settings.ts'
import { parseVenvBuild, venvFailed, venvStatusPath } from '../core/venv.ts'
import { backendStamp, buildReleaseVenv, installBackend, installedStamp } from '../main/backend.ts'
import { uvWith } from '../main/doctor.ts'
import { fsPort } from '../main/fsAccess.ts'
import { resolveRoot } from '../main/rootPath.ts'

// Replaced at bundle time, so the CLI always selects its installed app version.
declare const ASSAY_VERSION: string
const read = (path: string) => readFile(path, 'utf8').catch(() => undefined)
const fileExists = (path: string) => stat(path).then(info => info.isFile(), () => false)

// The CLI ships inside the app's backend folder (Resources/backend/out/cli).
const shipped = fileURLToPath(new URL('../../', import.meta.url))

async function preparedBackend(backend: string) {
  const expected = await backendStamp(shipped, { skipCaches: true }).catch(() => undefined)
  if (!expected) return undefined
  const actual = await backendStamp(backend).catch(() => undefined)
  return actual === expected && await installedStamp(backend) === expected ? expected : undefined
}

// The app's userData folder, in the case Electron gives it (package.json's name). macOS ignores the case, but a
// sandbox launcher's Linux VM mounts the ledger folder by this exact path.
const userData = join(homedir(), 'Library', 'Application Support', 'assay')

/** The root chosen in the app's Settings, resolved through links; undefined when unset or missing. */
async function rootPath() {
  const settings = parseSettings(await read(join(userData, 'settings.json')))
  const resolved = settings.root ? await resolveRoot(settings.root, homedir()) : undefined
  return resolved?.ok ? resolved.path : undefined
}

async function facts(slug?: string) {
  const root = await rootPath()
  const backend = join(userData, 'backend', ASSAY_VERSION)
  const venv = join(userData, 'venvs', ASSAY_VERSION)
  const stamp = await preparedBackend(backend)
  const build = parseVenvBuild(await read(venvStatusPath(venv)))
  return {
    slug, root, rootExists: root !== undefined, userData, version: ASSAY_VERSION, env: process.env,
    analyses: root ? (await listAnalyses(fsPort, root)).map(({ name, title }) => ({ name, title })) : [],
    backendReady: stamp !== undefined && await fileExists(join(backend, 'out/server/index.mjs')) && await fileExists(join(backend, 'plugin/.claude-plugin/plugin.json')),
    venvReady: stamp !== undefined && await installedStamp(venv) === stamp && build?.state === 'ready' && await fileExists(join(venv, 'bin/python')),
  }
}

type Facts = Awaited<ReturnType<typeof facts>>

/**
 * Installs this version's backend and builds its venv, as the app does at launch, so the terminal never needs the
 * app open. Only the steps still due run; a ready backend and venv cost two hash checks.
 */
async function prepared(known: Facts): Promise<Facts> {
  if (known.backendReady && known.venvReady) return known
  const backend = await installBackend({ shipped, home: known.userData, version: ASSAY_VERSION }).catch((error: unknown) => {
    throw new Error(`Could not install Assay's backend: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (!known.venvReady) writeSync(2, "Preparing Assay's Python environment for this version (about a minute)...\n")
  const build = await buildReleaseVenv({
    project: join(backend, 'python'), venv: join(known.userData, 'venvs', ASSAY_VERSION),
    runUv: uvWith(process.env.PATH ?? ''), stamp: (await installedStamp(backend)) ?? 'none',
  })
  if (build.state === 'failed') throw new Error(venvFailed(build.error))
  return facts(known.slug)
}

/** A launch whose only problem is the backend gets it prepared, then tries again. */
async function launch(known: Facts): Promise<OpenCommand> {
  const result = openCommand(known)
  // With a root and a known analysis, only the backend or venv can stop the launch.
  return result.kind === 'error' && known.root ? openCommand(await prepared(known)) : result
}

/**
 * Asks which analysis to open, or which to create, with a fuzzy search starting from `query`. Draws below the cursor
 * and erases itself when done, so the launch starts on a clean line.
 */
function pick(analyses: Choice[], query: string): Promise<TermPickerEffect> {
  const { stdin, stdout } = process
  let state = { query, selected: 0 }
  const draw = () => {
    const { lines, cursor } = pickerScreen(analyses, state, { columns: stdout.columns || 80, rows: stdout.rows || 24 })
    // Raw mode turns off output processing, so each line ends in \r\n; the cursor goes back to the query, where the
    // next draw starts.
    const up = lines.length > 1 ? `\x1b[${String(lines.length - 1)}A` : ''
    stdout.write(`\r\x1b[J${lines.join('\r\n')}${up}\r\x1b[${String(cursor)}C`)
  }
  return new Promise(resolve => {
    const finish = (effect: TermPickerEffect) => {
      stdin.off('keypress', onKey)
      stdout.off('resize', draw)
      stdout.write('\r\x1b[J')
      stdin.setRawMode(false)
      stdin.pause()
      resolve(effect)
    }
    const onKey = (_: unknown, key: TermKey | undefined) => {
      const step = pickerStep(analyses, state, key ?? {})
      state = step.state
      if (step.effect) finish(step.effect)
      else draw()
    }
    emitKeypressEvents(stdin)
    stdin.setRawMode(true)
    stdin.on('keypress', onKey)
    stdout.on('resize', draw)
    stdin.resume()
    draw()
  })
}

/** Creates the analysis titled `title` and launches it; nothing is written when the launch could not follow. */
async function created(known: Facts, title: string): Promise<OpenCommand> {
  const ready = known.root && cleanTitle(title).ok ? await prepared(known) : known
  return newCommand(ready, title, async (root, title) => (await createAnalysis(fsPort, root, title, isoDay(new Date()))).name)
}

/** Undefined when the user cancelled the choice. */
async function command(argv: string[]): Promise<OpenCommand | undefined> {
  const [, ...args] = argv
  const verb = cliVerb(argv)
  if (verb === 'help' || verb === 'version') {
    console.log(verb === 'help' ? helpText({ version: ASSAY_VERSION, root: await rootPath() }) : ASSAY_VERSION)
    return undefined
  }
  if (verb === 'usage') throw new Error(USAGE)
  if (verb === 'open') {
    const known = await facts(args[0])
    const result = await launch(known)
    // Output that is not a terminal (a script, a pipe) gets the list or the error instead of a question.
    if (result.kind !== 'choose' || !process.stdin.isTTY || !process.stdout.isTTY) return result
    const picked = await pick(known.analyses, result.failed ? args[0] ?? '' : '')
    if (picked.do === 'cancel') return undefined
    return picked.do === 'open' ? launch({ ...known, slug: picked.name }) : created(known, picked.title)
  }
  // Unquoted words make one title: `assay new Panel churn Q4`.
  return created(await facts(), args.join(' '))
}

async function main() {
  const result = await command(process.argv.slice(2))
  if (!result) return
  if (result.kind === 'error' || (result.kind === 'choose' && result.failed)) throw new Error(result.message)
  if (result.kind === 'choose') {
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
