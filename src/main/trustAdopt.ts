// Adopting what was trusted before the ledger existed (specs/trust-ledger.md, ticket 5). Main lists the files of the
// root's trusted/ and dictionaries/ that the ledger does not cover, with their text and hashes; the user looks at each
// group and adopts it. Adopting records the hashes shown and nothing else: no copy, no git, no write into the root.
// No Electron here.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { DICTIONARIES, PROPOSAL_NAME, TRUSTED } from '../core/calculations.ts'
import { unadoptedGroups } from '../core/trustAdopt.ts'
import type { AdoptGroup, TrustAdoptResult, TrustUnadoptedResult, UnadoptedGroup } from '../core/trustAdopt.ts'
import { changedSince } from '../core/trustApprove.ts'
import type { TrustApproveInput } from '../core/trustApprove.ts'
import { addEntry } from '../core/trustLedger.ts'
import type { Ledger } from '../core/trustLedger.ts'
import { isProposalFile } from '../core/trustNames.ts'
import { messageOf } from './fsAccess.ts'
import { inOrder, readRegular, sha256, typeOf } from './trustApprove.ts'
import { readLedger, writeLedger } from './trustLedger.ts'

type Read = { name: string; sha256: string; text: string | undefined }

/** The regular files of one shared folder, by basename; a link or a non-file is skipped, a missing folder is empty. */
async function readFolder(root: string, folder: string): Promise<Read[] | { message: string }> {
  const path = join(root, folder)
  const type = await typeOf(path)
  if (type === 'missing') return []
  if (type !== 'other') return { message: `${folder}/ is ${type === 'link' ? 'a link' : 'not a folder'}: it is refused.` }
  const reads: Read[] = []
  for (const name of (await readdir(path).catch(() => [])).toSorted((a, b) => a.localeCompare(b, 'en'))) {
    if ((await typeOf(join(path, name))) !== 'file') continue
    const bytes = await readRegular(join(path, name))
    if (!bytes) continue
    let text: string | undefined
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      text = undefined
    }
    reads.push({ name, sha256: sha256(bytes), text })
  }
  return reads
}

const folderOf = (kind: AdoptGroup['kind']): string => (kind === 'calculation' ? TRUSTED : DICTIONARIES)

/** A group with the text of each file; a file that is not UTF-8 text cannot be looked at, so the group cannot be adopted. */
function withText(group: AdoptGroup, reads: readonly Read[]): UnadoptedGroup {
  const unreadable = group.files.filter(file => reads.find(read => read.name === file.name && read.sha256 === file.sha256)?.text === undefined).map(file => file.name)
  const files = group.files.map(file => ({ name: file.name, sha256: file.sha256, text: reads.find(read => read.name === file.name)?.text ?? '' }))
  return { name: group.name, kind: group.kind, files, ...(unreadable.length > 0 ? { problem: `${unreadable.join(', ')} in ${folderOf(group.kind)}/ is not UTF-8 text: it cannot be shown, so it cannot be adopted.` } : {}) }
}

/** Only groups whose name and every file name are the proposal's own: nothing else can be adopted. */
const isOwn = (group: AdoptGroup): boolean => PROPOSAL_NAME.test(group.name) && group.files.every(file => isProposalFile(group.kind, group.name, file.name))

async function scan(root: string, ledger: Ledger): Promise<{ groups: UnadoptedGroup[] } | { message: string }> {
  const trusted = await readFolder(root, TRUSTED)
  const dictionaries = await readFolder(root, DICTIONARIES)
  if ('message' in trusted) return trusted
  if ('message' in dictionaries) return dictionaries
  const listing = { trusted, dictionaries }
  const groups = unadoptedGroups(listing, ledger).filter(isOwn)
  return { groups: groups.map(group => withText(group, group.kind === 'calculation' ? trusted : dictionaries)) }
}

/** The groups of the root's trusted/ and dictionaries/ the ledger does not cover, as they are on disk now. */
export async function listUnadopted(root: string, ledgerFile: string): Promise<TrustUnadoptedResult> {
  const { ledger } = await readLedger(ledgerFile)
  const found = await scan(root, ledger)
  return 'message' in found ? { ok: false, message: found.message } : { ok: true, groups: found.groups }
}

export type AdoptArgs = { root: string; ledgerFile: string; input: TrustApproveInput; now?: () => Date }

async function adoptNow(args: AdoptArgs): Promise<TrustAdoptResult> {
  const { root, ledgerFile, input } = args
  const { name, kind } = input
  const folder = folderOf(kind)
  for (const file of Object.keys(input.hashes)) {
    if ((await typeOf(join(root, folder, file))) === 'link') return { ok: false, message: `${JSON.stringify(file)} is a link: it is refused.` }
  }
  const { ledger } = await readLedger(ledgerFile)
  const found = await scan(root, ledger)
  if ('message' in found) return { ok: false, message: found.message }
  const group = found.groups.find(each => each.name === name && each.kind === kind)
  if (!group) return { ok: false, message: `Nothing to adopt for ${name}: it is already approved or its files are gone.` }
  if (group.problem !== undefined) return { ok: false, message: group.problem }
  const changed = changedSince(input.hashes, group.files)
  if (changed !== undefined) return { ok: false, message: changed.replace(/then Trust\.$/, 'then Adopt.') }
  const files = Object.fromEntries(group.files.map(file => [`${folder}/${file.name}`, file.sha256]))
  const entry = { files, approvedAt: (args.now?.() ?? new Date()).toISOString(), commit: '' }
  try {
    await writeLedger(ledgerFile, addEntry(ledger, name, kind === 'calculation' ? { ...entry, kind: 'calculation' } : { ...entry, kind: 'dictionary' }))
  } catch (error) {
    return { ok: false, message: `The approval could not be recorded: ${messageOf(error)}. ${name} is not trusted.` }
  }
  return { ok: true, message: `Adopted ${name}: it is trusted as it is now.` }
}

/**
 * Adopt: re-reads the group, refuses when any file or hash differs from what the user was shown or a file is a link,
 * and records the hashes in the ledger. Nothing is copied, committed or written into the root. It shares the approval queue, so a ledger
 * is never read by two writers at once.
 */
export const adoptGroup = (args: AdoptArgs): Promise<TrustAdoptResult> => inOrder(() => adoptNow(args))
