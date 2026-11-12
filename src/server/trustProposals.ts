// The proposals in an analysis: calculations drafted in lib/trusted/, dictionary entries in lib/dictionaries/.
import { DRAFT_DICTIONARIES, DRAFT_TRUSTED } from '../core/calculations.ts'
import type { Proposal } from '../core/requests.ts'
import type { Assay } from './assay.ts'
import { byCodeUnit } from './codeUnitOrder.ts'

export type FoundProposal = Proposal & { ext: string }

/** The drafted calculations (not their test_ helpers), then the drafted dictionary entries, each by file name. */
export async function listProposals(assay: Assay): Promise<FoundProposal[]> {
  const found: FoundProposal[] = []
  for (const name of (await assay.names(DRAFT_TRUSTED)).toSorted(byCodeUnit)) {
    const match = /^([a-z][a-z0-9_]*)\.(?:sql|py)$/.exec(name)
    if (match?.[1] && !match[1].startsWith('test_')) found.push({ name: match[1], kind: 'calculation', folder: DRAFT_TRUSTED, ext: name.endsWith('.py') ? 'py' : 'sql' })
  }
  for (const name of (await assay.names(DRAFT_DICTIONARIES)).toSorted(byCodeUnit)) {
    const match = /^([^.]+\.[^.]+\.[^.]+)\.yaml$/.exec(name)
    if (match?.[1]) found.push({ name: match[1].toLowerCase(), kind: 'dictionary', folder: DRAFT_DICTIONARIES, ext: 'yaml' })
  }
  return found
}
