// The Trust tab's calls, bound to what the window's Claude session was launched with (specs/trust-ledger.md): its
// analysis, its root and that root's ledger. The settings root can change while a session runs; approving or adopting
// from that session must still write the ledger Claude was told about, never the new root's. A window whose session
// never started has no launch and is refused. No Electron here, so the tests run it on temp folders.
import { parseAdoptInput } from '../core/trustAdopt.ts'
import { parseApproveInput, parseProposalRef } from '../core/trustApprove.ts'
import type { RequestResult, RunRequest, TrustAdoptResult, TrustApproveResult, TrustFilesResult, TrustUnadoptedResult } from '../shared/ipc.ts'
import { adoptGroup, listUnadopted } from './trustAdopt.ts'
import { approveProposal, readDraft } from './trustApprove.ts'

/** What the session was started with: its analysis folder, the root, and the root's ledger file. */
export type TrustLaunch = { analysisPath: string; root: string; ledgerFile: string }

/** Binds the Trust calls to the launch only once the session has started: a spawn that throws leaves them refused. */
export function startTrusted<T>(holder: { trustLaunch?: TrustLaunch }, launch: TrustLaunch, start: () => T): T {
  const started = start()
  holder.trustLaunch = launch
  return started
}

/** The session ended: the Trust calls are refused until another one starts. */
export function endTrusted(holder: { trustLaunch?: TrustLaunch }): void {
  holder.trustLaunch = undefined
}

const NO_SESSION = 'The analysis has no Claude session yet: start it before using the Trust tab.'

export function trustFilesFor(launch: TrustLaunch | undefined, proposal: unknown): Promise<TrustFilesResult> | TrustFilesResult {
  const ref = parseProposalRef(proposal)
  if (!launch) return { ok: false, message: NO_SESSION }
  if ('error' in ref) return { ok: false, message: 'Invalid proposal' }
  return readDraft(launch.analysisPath, ref.kind, ref.name)
}

/** Tells the session's server the review is over: the app's `trust-done`, written to the launched analysis. */
export type TellServer = (analysisPath: string, request: RunRequest) => Promise<RequestResult>

export async function trustApproveFor(launch: TrustLaunch | undefined, raw: unknown, tellServer: TellServer): Promise<TrustApproveResult> {
  const input = parseApproveInput(raw)
  if (!launch) return { ok: false, message: NO_SESSION }
  if ('error' in input) return { ok: false, message: input.error }
  const result = await approveProposal({ analysisPath: launch.analysisPath, ledgerFile: launch.ledgerFile, input })
  if (!result.ok) return result
  const told = await tellServer(launch.analysisPath, { kind: 'trust-done', name: input.name, outcome: result.outcome, message: result.message })
  if (told.ok) return result
  // The ledger has the entry, so pressing Trust again finds it unchanged and sends `trust-done` again.
  return { ok: false, message: `Your approval is recorded; Claude's side was not told (${told.message}), press Trust again to retry.` }
}

export function trustUnadoptedFor(launch: TrustLaunch | undefined): Promise<TrustUnadoptedResult> | TrustUnadoptedResult {
  return launch ? listUnadopted(launch.root, launch.ledgerFile) : { ok: false, message: NO_SESSION }
}

export async function trustAdoptFor(launch: TrustLaunch | undefined, raw: unknown): Promise<TrustAdoptResult> {
  const input = parseAdoptInput(raw)
  if (!launch) return { ok: false, message: NO_SESSION }
  if ('error' in input) return { ok: false, message: input.error }
  return adoptGroup({ root: launch.root, ledgerFile: launch.ledgerFile, input })
}
