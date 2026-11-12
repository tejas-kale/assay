// The trust review, ported from the analysis mod's `/an trust` (hooks/register.tsx). The app starts it with a
// `trust-check` request; the server writes `.assay/trust/<name>.json` after every step. Trusting is not here: the app
// records it in the ledger (main/trustApprove.ts). A `trust-done` request closes the review, and only when the ledger
// backs it does the server copy the draft into the shared folder and commit it (trustPromote.ts).
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { DRAFT_DICTIONARIES, DRAFT_TRUSTED, PROPOSAL_NAME, TRUST_TAB } from '../core/calculations.ts'
import type { CheckEvent } from '../core/calculations.ts'
import type { TrustOutcome } from '../core/requests.ts'
import type { TrustState } from '../core/trust.ts'
import { Assay } from './assay.ts'
import { listProposals } from './trustProposals.ts'
import type { FoundProposal } from './trustProposals.ts'
import { applyEvent, describeProposal, draftOf, sharedOf, trustFile } from './trustReview.ts'
import type { Review } from './trustReview.ts'
import { promote, promotedMessage } from './trustPromote.ts'
import { streamChecks } from './trustStream.ts'

const TRUST_DIR = '.assay/trust'

export class TrustReviews {
  private readonly assay: Assay
  /** The review that is checking or waiting for its answer: only one at a time. */
  private open: Review | undefined
  /** The name of a review being set up: claimed before the first await so two requests cannot both start. */
  private starting: string | undefined
  private writes: Promise<unknown> = Promise.resolve()
  /** Settles when the current review's checks are over; tests wait on it. */
  checked: Promise<void> = Promise.resolve()

  constructor(assay: Assay) {
    this.assay = assay
  }

  /** The proposals in this analysis: calculations in lib/trusted/, drafted entries in lib/dictionaries/. */
  proposals(): Promise<FoundProposal[]> {
    return listProposals(this.assay)
  }

  /** Starts checking one proposal; why not, if it cannot. The checks go on after this returns. */
  async check(name: string): Promise<string | undefined> {
    const busy = this.open?.name ?? this.starting
    if (busy) return `A review of ${busy} is in progress: answer it first.`
    this.starting = name
    try {
      const found = await this.proposals()
      const proposal = PROPOSAL_NAME.test(name) ? found.find(each => each.name === name) : undefined
      if (!proposal) return `No proposal ${name} in ${DRAFT_TRUSTED}/ or ${DRAFT_DICTIONARIES}/.`
      const review = await this.newReview(proposal)
      this.open = review
      this.checked = this.runChecks(review)
      return undefined
    } finally {
      this.starting = undefined
    }
  }

  private async newReview(proposal: FoundProposal): Promise<Review> {
    const dest = join(this.assay.config.root, sharedOf(proposal.kind))
    const kept = await readdir(dest).catch(() => [] as string[])
    const { name, kind } = proposal
    return {
      name,
      kind,
      folder: this.assay.at(draftOf(kind)),
      dest,
      ...describeProposal(kind, proposal.ext),
      replaces: kept.some(file => file === `${name}.sql` || file === `${name}.py` || file === `${name}.yaml`),
      startedAt: Date.now(),
      state: 'checking',
    }
  }

  /**
   * The app says the review is over. Only closes the open review that is waiting for an answer; why not, if there is
   * none. An approval is believed only when the ledger holds the draft's exact hashes: then the server copies the
   * draft into the shared folder, commits it and tidies the draft. A rejection records and copies nothing.
   */
  async done({ name, outcome, message }: { name: string; outcome: TrustOutcome; message?: string }): Promise<string | undefined> {
    const review = this.open
    if (!review || review.name !== name || review.state !== 'asking') {
      return review?.name === name ? `The review of ${name} is ${review.state}, not waiting for an answer.` : `No review of ${name} is waiting for an answer.`
    }
    if (outcome === 'rejected') this.finish(review, outcome, message ?? doneMessage(review))
    else {
      const promoted = await promote(this.assay, review)
      if ('refused' in promoted) return promoted.refused
      if (!isAsking(review)) return `No review of ${name} is waiting for an answer.`
      this.assay.forgetCalculations()
      this.finish(review, outcome, promotedMessage(review, outcome, promoted))
    }
    await this.writes
    return undefined
  }

  /** `.assay/trust/<name>.json`, written to a temp file and renamed into place; writes go in order, so the last state wins. */
  private changed(review: Review) {
    const text = `${JSON.stringify(trustFile(review), null, 2)}\n`
    this.writes = this.writes.then(() => this.assay.writeAtomic(`${TRUST_DIR}/${review.name}.json`, text)).catch(() => undefined)
  }

  private finish(review: Review, state: TrustState, message: string) {
    review.state = state
    review.message = message
    review.endedAt = Date.now()
    if (this.open === review) this.open = undefined
    this.changed(review)
  }

  /** Takes one streamed event into the review. Returns the helper's error when it ended with one. */
  private take(review: Review, event: CheckEvent): string | undefined {
    const failure = applyEvent(review, event)
    this.changed(review)
    return failure
  }

  /** The checks, then `asking` when every check passed (the app shows Trust and Reject), else `failed` or `error`. */
  private async runChecks(review: Review) {
    this.changed(review)
    const failure = await streamChecks(this.assay, review, event => this.take(review, event)).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    if (failure !== undefined) this.finish(review, 'error', failure)
    else if (!review.answer?.ok) this.finish(review, 'failed', `Not approvable: fix the proposal, then check ${review.name} again in ${TRUST_TAB}.`)
    else {
      review.state = 'asking'
      this.changed(review)
    }
    await this.writes
  }
}

/** Whether the review still waits for its answer: another `trust-done` may have closed it while this one copied. */
const isAsking = (review: Review): boolean => review.state === 'asking'

/** The line the Trust tab shows when the app did not say more about a rejection. */
const doneMessage = (review: Review): string => `Rejected ${review.name}; the proposal stays in ${draftOf(review.kind)}/.`
