// The trust ledger's file (specs/trust-ledger.md): one per root, in the app's data folder, written by main only.
// No Electron here, so the tests run it on a temp folder.
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { emptyLedger, parseLedger, serializeLedger } from '../core/trustLedger.ts'
import type { Ledger, ParsedLedger } from '../core/trustLedger.ts'

export { ledgerPath } from '../core/trustLedger.ts'

const isLink = async (path: string): Promise<boolean | undefined> => {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return undefined
  }
}

/** A missing file is an empty ledger. A link, a damaged file or a wrong shape is an empty ledger and a problem. */
export async function readLedger(path: string): Promise<ParsedLedger> {
  if ((await isLink(path)) === true) return { ledger: emptyLedger(), problem: `The trust ledger ${path} is a link: it is refused.` }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ledger: emptyLedger(), problem: undefined }
    return { ledger: emptyLedger(), problem: `The trust ledger cannot be read: ${(error as Error).message}` }
  }
  return parseLedger(text)
}

/** Writes through a temp file in the same folder and a rename. Refuses when the file or its folder is a link. */
export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  const folder = dirname(path)
  if ((await isLink(folder)) === true) throw new Error(`The trust ledger folder ${folder} is a link: refused.`)
  await mkdir(folder, { recursive: true })
  if ((await isLink(folder)) === true) throw new Error(`The trust ledger folder ${folder} is a link: refused.`)
  if ((await isLink(path)) === true) throw new Error(`The trust ledger ${path} is a link: refused.`)
  const temp = join(folder, `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, serializeLedger(ledger), { flag: 'wx', mode: 0o600 })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}
