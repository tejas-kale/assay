// Approving a proposal: the only place anything becomes trusted (specs/trust-ledger.md). Main reads the draft's files
// from disk, the Trust tab shows them with their hashes, and Trust comes back here with those hashes: the ledger
// records the bytes that were shown. Main writes the ledger and nothing else: it never writes into the root, where
// Claude's side can plant links, and it never runs git there, where Claude's side can plant hooks. The server, inside
// Claude's environment, copies the draft into trusted/ or dictionaries/ afterwards (server/trustPromote.ts).
// No Electron here, so the tests run it on a temp folder.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

import { DICTIONARIES, DRAFT_DICTIONARIES, DRAFT_TRUSTED, TRUSTED } from '../core/calculations.ts'
import type { Proposal } from '../core/requests.ts'
import { approvalMessage, changedSince } from '../core/trustApprove.ts'
import type { DraftFile, TrustApproveInput, TrustApproveResult, TrustFilesResult } from '../core/trustApprove.ts'
import { addEntry, entryKey } from '../core/trustLedger.ts'
import type { Ledger } from '../core/trustLedger.ts'
import { allowedNames } from '../core/trustNames.ts'
import { messageOf } from './fsAccess.ts'
import { readLedger, writeLedger } from './trustLedger.ts'

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const draftFolder = (kind: Proposal['kind']): string => (kind === 'calculation' ? DRAFT_TRUSTED : DRAFT_DICTIONARIES)
const sharedFolder = (kind: Proposal['kind']): string => (kind === 'calculation' ? TRUSTED : DICTIONARIES)

export const typeOf = async (path: string): Promise<'missing' | 'link' | 'file' | 'other'> => {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return 'link'
    return stat.isFile() ? 'file' : 'other'
  } catch {
    return 'missing'
  }
}

const isFolderLink = async (path: string): Promise<boolean> => (await typeOf(path)) === 'link'

/** Reads one file without following a link, whatever happens to the name between the check and the read. */
export async function readRegular(path: string): Promise<Buffer | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined)
  if (!handle) return undefined
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : undefined
  } finally {
    await handle.close()
  }
}

/** The proposal's own files in the draft folder, as bytes, or why the draft cannot be shown or approved. */
async function readDraftBytes(analysisPath: string, kind: Proposal['kind'], name: string): Promise<{ files: DraftFile[] } | { message: string }> {
  const folder = join(analysisPath, draftFolder(kind))
  if ((await isFolderLink(join(analysisPath, 'lib'))) || (await isFolderLink(folder))) return { message: `${draftFolder(kind)}/ is a link: it is refused.` }
  const files: DraftFile[] = []
  for (const file of allowedNames(kind, name)) {
    const path = join(folder, file)
    const type = await typeOf(path)
    if (type === 'missing') continue
    if (type !== 'file') return { message: `${JSON.stringify(file)} in ${draftFolder(kind)}/ is a ${type === 'link' ? 'link' : 'not a regular file'}: it is refused.` }
    const bytes = await readRegular(path)
    if (!bytes) return { message: `${JSON.stringify(file)} in ${draftFolder(kind)}/ cannot be read as a regular file.` }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { message: `${JSON.stringify(file)} in ${draftFolder(kind)}/ is not UTF-8 text.` }
    }
    files.push({ name: file, text, sha256: sha256(bytes) })
  }
  return { files }
}

/** What the Trust tab shows for a proposal: its files as they are on disk now, each with its sha256. */
export async function readDraft(analysisPath: string, kind: Proposal['kind'], name: string): Promise<TrustFilesResult> {
  const read = await readDraftBytes(analysisPath, kind, name)
  if ('message' in read) return { ok: false, message: read.message }
  if (read.files.length === 0) return { ok: false, message: `No files of ${name} in ${draftFolder(kind)}/.` }
  return { ok: true, files: read.files.map(({ name: file, text, sha256: hash }) => ({ name: file, text, sha256: hash })) }
}

/** Whether the ledger already holds exactly these files for this proposal, so approving again changes nothing. */
function isRecorded(ledger: Ledger, kind: Proposal['kind'], name: string, files: Readonly<Record<string, string>>): boolean {
  const entry = ledger.entries[entryKey(kind, name)]
  if (!entry || !Object.hasOwn(ledger.entries, entryKey(kind, name))) return false
  const have = Object.entries(entry.files)
  return have.length === Object.keys(files).length && have.every(([path, hash]) => Object.hasOwn(files, path) && files[path] === hash)
}

// Ledger writes go one at a time, so two approvals cannot read the same ledger.
let queue: Promise<unknown> = Promise.resolve()
export const inOrder = <T>(job: () => Promise<T>): Promise<T> => {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
}

export type ApproveArgs = {
  /** The open analysis's folder, as its Claude session was launched with it. */
  analysisPath: string
  /** The ledger file of the root that session was launched with (ledgerPath). */
  ledgerFile: string
  input: TrustApproveInput
  now?: () => Date
}

async function approveNow(args: ApproveArgs): Promise<TrustApproveResult> {
  const { analysisPath, ledgerFile, input } = args
  const { name, kind } = input
  const draft = await readDraftBytes(analysisPath, kind, name)
  if ('message' in draft) return { ok: false, message: draft.message }
  const changed = changedSince(input.hashes, draft.files)
  if (changed !== undefined) return { ok: false, message: changed }
  const { ledger, problem } = await readLedger(ledgerFile)
  const folder = sharedFolder(kind)
  const entryFiles = Object.fromEntries(draft.files.map(file => [`${folder}/${file.name}`, file.sha256]))
  if (problem === undefined && isRecorded(ledger, kind, name, entryFiles)) return { ok: true, outcome: 'unchanged', message: approvalMessage({ name, folder, outcome: 'unchanged' }) }
  try {
    const entry = { kind, files: entryFiles, approvedAt: (args.now?.() ?? new Date()).toISOString(), commit: '' }
    await writeLedger(ledgerFile, addEntry(ledger, name, kind === 'calculation' ? { ...entry, kind: 'calculation' } : { ...entry, kind: 'dictionary' }))
  } catch (error) {
    return { ok: false, message: `The approval could not be recorded: ${messageOf(error)}. ${name} is not trusted.` }
  }
  return { ok: true, outcome: 'approved', message: approvalMessage({ name, folder, outcome: 'approved' }) }
}

/**
 * Trust: re-reads the draft, refuses when its files or any hash differ from what the user was shown, and records the
 * hashes in the ledger. Nothing is trusted until the entry is written, so a failure leaves nothing trusted. Copying
 * into the root is the server's (after it checks this ledger entry).
 */
export const approveProposal = (args: ApproveArgs): Promise<TrustApproveResult> => inOrder(() => approveNow(args))
