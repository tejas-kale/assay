// The overview documents of an analysis and its system (specs/slices/slice-10.md, slice 10a): reading them with their
// baselines, the change signature the poll watches, "Mark read", and freezing/resetting the preface (specs/delegated-runs.md).
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { COVERAGE_FILE, parseCoverage } from '../core/coverage.ts'
import { OVERVIEW_FILE, baselinePath, systemOf } from '../core/overview.ts'
import type { OverviewDoc, OverviewState, OverviewWhich } from '../core/overview.ts'
import { FROZEN_PREFACE_FILE, PREFACE_DRAFT_FILE, freezePreface, readFrozenPreface, resetPreface } from '../core/preface.ts'
import type { PrefaceFs } from '../core/preface.ts'
import { statSignature } from '../core/watch.ts'
import type { EditResult } from '../shared/ipc.ts'
import { isMissing, maybeText, rootOf, writeAtomic } from './fsAccess.ts'

const MAX_PREFACE_BYTES = 1 << 20

/** Ensures `path` is a real directory, creating it when missing; a symlink or regular file in its place is refused. */
async function realFolder(path: string): Promise<void> {
  const info = await lstat(path).catch((err: unknown) => {
    if (isMissing(err)) return undefined
    throw err
  })
  if (!info) await mkdir(path).catch(() => undefined)
  const now = info ?? (await lstat(path))
  if (!now.isDirectory()) throw new Error(`${path} is not a real folder (a link or a file): it is refused.`)
}

async function checkParentFolder(path: string): Promise<void> {
  const parent = dirname(path)
  const info = await lstat(parent).catch((err: unknown) => {
    if (isMissing(err)) return undefined
    throw err
  })
  if (info && !info.isDirectory()) throw new Error(`${parent} is not a real folder (a link or a file): it is refused.`)
}

async function readNoFollow(path: string): Promise<string> {
  await checkParentFolder(path)
  const info = await lstat(path)
  if (!info.isFile()) throw new Error(`${path} is not a regular file: it is refused.`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.size > MAX_PREFACE_BYTES) throw new Error(`${path} cannot be read as a regular file.`)
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

async function writeNoFollow(path: string, text: string): Promise<void> {
  const dir = dirname(path)
  const dirInfo = await lstat(dir)
  if (!dirInfo.isDirectory()) throw new Error(`${dir} is not a real folder (a link or a file): it is refused.`)
  const targetInfo = await lstat(path).catch((err: unknown) => {
    if (isMissing(err)) return undefined
    throw err
  })
  if (targetInfo && !targetInfo.isFile()) throw new Error(`${path} is not a regular file: it is refused.`)
  const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(text, 'utf8')
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw err
  }
}

async function unlinkNoFollow(path: string): Promise<void> {
  await checkParentFolder(path)
  const info = await lstat(path)
  if (!info.isFile()) throw new Error(`${path} is not a regular file: it is refused.`)
  await unlink(path)
}

async function readdirNoFollow(path: string): Promise<string[]> {
  await checkParentFolder(path)
  const info = await lstat(path)
  if (!info.isDirectory()) throw new Error(`${path} is not a real folder (a link or a file): it is refused.`)
  return readdir(path)
}

const prefaceFs: PrefaceFs = {
  readdir: path => readdirNoFollow(path),
  mkdir: async path => {
    if (basename(path) === 'preface-archive') await realFolder(dirname(path))
    await realFolder(path)
  },
  readFile: path => readNoFollow(path),
  writeFile: (path, text) => writeNoFollow(path, text),
  unlink: path => unlinkNoFollow(path),
}

/** One document with its baseline, read from the analysis folder (`path` is what the state shows, from the root). */
async function readDoc(analysisPath: string, shown: { path: string; text: string; which: OverviewWhich; system?: string }): Promise<OverviewDoc> {
  const base = baselinePath(shown.which, shown.system)
  const baseline = base === undefined ? undefined : await maybeText(join(analysisPath, base))
  return { path: shown.path, text: shown.text, ...(baseline === undefined ? {} : { baseline }) }
}

/**
 * The analysis overview, the system overview it names, the baseline of each (specs/slices/slice-10.md, slice 10a), and
 * the current frozen preface (specs/delegated-runs.md). Paths in the state are from the root.
 */
export async function readOverview(analysisPath: string): Promise<OverviewState> {
  const [text, preface, coverageText] = await Promise.all([
    maybeText(join(analysisPath, OVERVIEW_FILE)),
    readFrozenPreface(prefaceFs, analysisPath),
    readNoFollow(join(analysisPath, COVERAGE_FILE)).catch(() => undefined),
  ])
  const coverage = parseCoverage(coverageText ?? '')
  const state: OverviewState = { ...(preface ? { preface } : {}), ...(coverage ? { coverage } : {}) }
  if (text === undefined) return state
  state.analysis = await readDoc(analysisPath, { path: `analyses/${basename(analysisPath)}/${OVERVIEW_FILE}`, text, which: 'analysis' })
  const system = systemOf(text)
  if (!system) return state
  state.system = system
  const systemText = await maybeText(join(rootOf(analysisPath), system))
  if (systemText !== undefined) state.systemDoc = await readDoc(analysisPath, { path: system, text: systemText, which: 'system', system })
  return state
}

/** A signature of the overview files, their baselines, and the preface files, so main pushes the state when any of them changes. */
export async function overviewSignature(analysisPath: string): Promise<string> {
  const text = (await maybeText(join(analysisPath, OVERVIEW_FILE))) ?? ''
  const system = systemOf(text)
  const paths = [
    join(analysisPath, OVERVIEW_FILE),
    join(analysisPath, baselinePath('analysis', undefined) ?? ''),
    join(analysisPath, FROZEN_PREFACE_FILE),
    join(analysisPath, PREFACE_DRAFT_FILE),
    join(analysisPath, COVERAGE_FILE),
  ]
  if (system) paths.push(join(rootOf(analysisPath), system), join(analysisPath, baselinePath('system', system) ?? ''))
  const parts = await Promise.all(paths.map(async path => statSignature(await stat(path).catch(() => undefined))))
  return parts.join('|')
}

/** The text of the document `which` names now, or undefined when there is no such document. */
async function currentOverviewText(analysisPath: string, which: OverviewWhich, text: string, system: string | undefined) {
  if (which === 'analysis') return text
  return system ? maybeText(join(rootOf(analysisPath), system)) : undefined
}

/**
 * "Mark read": the shown document's text becomes its baseline, when the file still holds `expectedText` (what the tab
 * showed); else `stale`, so the user never marks read a text they did not see.
 */
export async function markOverviewRead(analysisPath: string, which: OverviewWhich, expectedText: string): Promise<EditResult> {
  const text = (await maybeText(join(analysisPath, OVERVIEW_FILE))) ?? ''
  const system = systemOf(text)
  const current = await currentOverviewText(analysisPath, which, text, system)
  const base = baselinePath(which, system)
  if (current === undefined || base === undefined) return { ok: false, reason: 'invalid', message: 'No such overview.' }
  if (current !== expectedText) return { ok: false, reason: 'stale', message: 'Changed on disk, reloaded' }
  const path = join(analysisPath, base)
  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(path, current)
  return { ok: true }
}

/** Freezes `preface.json` in the analysis folder into `.assay/preface.json`. */
export const freezeOverviewPreface = (analysisPath: string): Promise<EditResult> => freezePreface(prefaceFs, analysisPath)

/** Resets `.assay/preface.json`, archiving it under `.assay/preface-archive/<id>.json`. */
export const resetOverviewPreface = (analysisPath: string): Promise<EditResult> => resetPreface(prefaceFs, analysisPath)
