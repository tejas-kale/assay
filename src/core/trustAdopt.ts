// Adopting what was trusted before the ledger (specs/trust-ledger.md, ticket 5): the groups of files in a root's
// trusted/ and dictionaries/ that the ledger does not cover, so the Trust tab can show each for review.
import { DICTIONARIES, TRUSTED } from './calculations.ts'
import { parseApproveInput } from './trustApprove.ts'
import type { DraftFile } from './trustApprove.ts'
import type { TrustApproveInput } from './trustApprove.ts'
import { isTrustedFile } from './trustLedger.ts'
import type { Ledger } from './trustLedger.ts'
import { allowedNames } from './trustNames.ts'

export type ListedFile = { name: string; sha256: string }
/** The root's shared folders as main lists them: basenames and sha256 of regular files. */
export type RootListing = { trusted: readonly ListedFile[]; dictionaries: readonly ListedFile[] }
export type AdoptGroup = { name: string; kind: 'calculation' | 'dictionary'; files: ListedFile[] }

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'en')

/** The name a file would be the primary of, when it is one: `calc.sql`, `calc.py`, `orders.yaml`. */
function stemOf(kind: AdoptGroup['kind'], file: string): string | undefined {
  const match = (kind === 'calculation' ? /^(.+)\.(?:sql|py)$/ : /^(.+)\.yaml$/).exec(file)
  return match?.[1]
}

/** The name a companion belongs to when its primary is missing: strip the companion's own marker. */
function orphanName(kind: AdoptGroup['kind'], file: string): string | undefined {
  const patterns = kind === 'calculation' ? [/^test_(.+)\.py$/, /^(.+)\.test\.yaml$/, /^(.+)\.rebuild\.sql$/] : [/^(.+)\.test\.yaml$/]
  for (const pattern of patterns) {
    const name = pattern.exec(file)?.[1]
    if (name !== undefined) return name
  }
  return undefined
}

/** Files grouped by the name that owns them: a primary owns its companions, and a companion with no primary names its own group. */
function groupFiles(kind: AdoptGroup['kind'], files: readonly ListedFile[]): AdoptGroup[] {
  const owns = (name: string, file: string): boolean => allowedNames(kind, name).includes(file)
  // A file shaped like a companion is never a primary, so a lone one names its own group.
  const stems = new Set(files.flatMap(file => (orphanName(kind, file.name) === undefined ? (stemOf(kind, file.name) ?? []) : [])))
  // Longest first, so `a.b` takes `a.b.test.yaml` before `a` could.
  const primaries = [...stems].sort((a, b) => b.length - a.length)
  const groups = new Map<string, ListedFile[]>()
  for (const file of files) {
    const owner = primaries.find(name => owns(name, file.name)) ?? orphanName(kind, file.name)
    if (owner !== undefined) groups.set(owner, [...(groups.get(owner) ?? []), file])
  }
  return [...groups].map(([name, own]) => ({ name, kind, files: own.toSorted(byName) }))
}

/** The groups with at least one file the ledger does not list with that exact hash, sorted by kind then name. */
export function unadoptedGroups(listing: RootListing, ledger: Ledger): AdoptGroup[] {
  const covered = (folder: string, file: ListedFile): boolean => isTrustedFile(ledger, `${folder}/${file.name}`, file.sha256)
  const calculations = groupFiles('calculation', listing.trusted).filter(group => !group.files.every(file => covered(TRUSTED, file)))
  const dictionaries = groupFiles('dictionary', listing.dictionaries).filter(group => !group.files.every(file => covered(DICTIONARIES, file)))
  return [...calculations.toSorted(byName), ...dictionaries.toSorted(byName)]
}

/** What `trust:adopt` takes: the same shape as approving, since adopting also names a group and the hashes shown. */
export const parseAdoptInput = (raw: unknown): TrustApproveInput | { error: string } => parseApproveInput(raw)

/** A group as main read it from disk: each file's text and sha256, and why it cannot be adopted when it cannot. */
export type UnadoptedGroup = { name: string; kind: AdoptGroup['kind']; files: DraftFile[]; problem?: string }
export type TrustUnadoptedResult = { ok: true; groups: UnadoptedGroup[] } | { ok: false; message: string }
export type TrustAdoptResult = { ok: true; message: string } | { ok: false; message: string }
