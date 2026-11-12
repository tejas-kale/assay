// Approving a proposal, as the app's main process records it (main/trustApprove.ts, specs/trust-ledger.md). This module is
// the part that needs no files: what the renderer may send, how the draft's files compare with what was shown, and
// the words the Trust tab shows afterwards.
import { PROPOSAL_NAME } from './calculations.ts'
import type { Proposal } from './requests.ts'
import { isProposalFile } from './trustNames.ts'

/** A draft file as main read it: the text the Trust tab shows and the sha256 of its bytes. */
export type DraftFile = { name: string; text: string; sha256: string }
export type TrustFilesResult = { ok: true; files: DraftFile[] } | { ok: false; message: string }

/** What Trust sends: the proposal and the hash of each file the user was shown. */
export type TrustApproveInput = { name: string; kind: Proposal['kind']; hashes: Record<string, string> }
export type TrustApproveResult =
  | { ok: true; outcome: 'approved' | 'unchanged'; message: string }
  | { ok: false; message: string }

const SHA256 = /^[0-9a-f]{64}$/
const MAX_FILES = 8
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The proposal's name and kind, as `trust:files` takes them. */
export function parseProposalRef(raw: unknown): { name: string; kind: Proposal['kind'] } | { error: string } {
  if (!isRecord(raw)) return { error: 'Invalid proposal' }
  const { name, kind } = raw
  if (typeof name !== 'string' || !PROPOSAL_NAME.test(name)) return { error: 'Invalid proposal' }
  if (kind !== 'calculation' && kind !== 'dictionary') return { error: 'Invalid proposal' }
  return { name, kind }
}

/** What the renderer sent to approve, or why it is refused: every file name must be the proposal's own. */
export function parseApproveInput(raw: unknown): TrustApproveInput | { error: string } {
  const ref = parseProposalRef(raw)
  if ('error' in ref) return ref
  const hashes = isRecord(raw) ? raw['hashes'] : undefined
  if (!isRecord(hashes)) return { error: 'Invalid hashes' }
  const entries = Object.entries(hashes)
  if (entries.length === 0 || entries.length > MAX_FILES) return { error: 'Invalid hashes' }
  const clean: Record<string, string> = {}
  for (const [file, hash] of entries) {
    if (typeof hash !== 'string' || !SHA256.test(hash)) return { error: 'Invalid hashes' }
    if (!isProposalFile(ref.kind, ref.name, file)) return { error: `${JSON.stringify(file)} is not a file this proposal may have.` }
    Object.defineProperty(clean, file, { value: hash, enumerable: true, writable: true, configurable: true })
  }
  return { ...ref, hashes: clean }
}

/** The hashes Trust sends: one per file the user was shown. */
export const hashesOf = (files: readonly DraftFile[]): Record<string, string> => Object.fromEntries(files.map(file => [file.name, file.sha256]))

/** Why the draft no longer is what was shown, or undefined when the files and every hash are the same. */
export function changedSince(shown: Readonly<Record<string, string>>, now: readonly { name: string; sha256: string }[]): string | undefined {
  const names = now.map(file => file.name)
  const same = names.length === Object.keys(shown).length && now.every(file => Object.hasOwn(shown, file.name) && shown[file.name] === file.sha256)
  if (same) return undefined
  return `The draft changed since you looked at it (${names.length === 0 ? 'no files now' : names.join(', ')}). Look at it again, then Trust.`
}

/** The line the Trust tab shows once the app has recorded the approval; the server says the rest when it has copied the files. */
export function approvalMessage(args: { name: string; folder: string; outcome: 'approved' | 'unchanged' }): string {
  const { name, folder, outcome } = args
  if (outcome === 'unchanged') return 'Already trusted: no changes.'
  return `Trusted ${name}: approved in the app; Claude's side now copies it to ${folder}/.`
}
