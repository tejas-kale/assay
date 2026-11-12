// The trust review, ported from the analysis mod's `/an trust` (hooks/register.tsx). The app starts it with a
// `trust-check` request and answers it with `trust-answer`; the server writes `.assay/trust/<name>.json` after every
// step. No tool of Claude's reaches here, so Claude can never promote.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { DRAFT_DICTIONARIES, DRAFT_TRUSTED, PROPOSAL_NAME, TRUST_TAB } from '../core/calculations.ts'
import type { CheckEvent } from '../core/calculations.ts'
import type { TrustAnswer } from '../core/requests.ts'
import type { TrustState } from '../core/trust.ts'
import { Assay } from './assay.ts'
import { listProposals } from './trustProposals.ts'
import type { FoundProposal } from './trustProposals.ts'
import { promote, removeDraft } from './trustPromote.ts'
import { applyEvent, describeProposal, draftOf, sharedOf, trustFile } from './trustReview.ts'
import type { Review } from './trustReview.ts'
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

  /** The user's answer to a review whose checks all passed; why not, if it is not waiting for one. */
  async answer(name: string, said: TrustAnswer): Promise<string | undefined> {
    const review = this.open
    if (!review || review.name !== name || review.state !== 'asking') {
      return review?.name === name ? `The review of ${name} is ${review.state}, not waiting for an answer.` : `No review of ${name} is waiting for an answer.`
    }
    const answer = review.answer
    if (said !== 'trust' || !answer) {
      this.finish(review, 'rejected', `Rejected ${name}; the proposal stays in ${draftOf(review.kind)}/.`)
      await this.writes
      return undefined
    }
    // Taken now, so a second answer while this one commits is refused.
    review.state = 'approved'
    const promoted = await promote(this.assay, review, answer)
    if ('failed' in promoted) {
      this.finish(review, 'error', promoted.failed)
      await this.writes
      return promoted.failed
    }
    this.assay.forgetCalculations()
    const kept = await removeDraft(this.assay, review, promoted.written)
    const state = promoted.isUnchanged ? 'unchanged' : 'approved'
    this.finish(review, state, approvalMessage(review, promoted.isUnchanged, kept))
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

/** The line the Trust tab shows once the review is over: trusted, or already trusted, and any draft that was kept. */
function approvalMessage(review: Review, isUnchanged: boolean, kept: readonly string[]): string {
  const keptNote = kept.length === 0 ? '' : ` Kept the draft ${kept.join(', ')}: it changed after the check.`
  const trusted = isUnchanged ? 'Already trusted: no changes.' : `Trusted ${review.name}: committed in ${sharedOf(review.kind)}/.`
  return `${trusted}${keptNote}`
}
