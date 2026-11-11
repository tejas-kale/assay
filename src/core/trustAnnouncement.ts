// What Claude's session is told when a Trust tab review ends. The review is the user's to answer (only the tab's
// buttons start or answer one), so the answer reaches Claude as if the user typed it.
import { failedMessage, justAnswered, justFailed } from './trust.ts'
import type { TrustReview } from './trust.ts'

export type TrustSeen = {
  /** The latest review the view was sent before this one (null: none yet; undefined: no look yet). */
  before: TrustReview | null | undefined
  review: TrustReview | undefined
  /** The startedAt of the review already told to Claude, so a late poll cannot say it twice. */
  announcedAt: number | undefined
}

/**
 * The text to type into the session: `trusted` or `rejected` once the user answers, the failed steps when a check
 * fails. Undefined when there is nothing new to say.
 */
export function trustAnnouncement({ before, review, announcedAt }: TrustSeen): string | undefined {
  if (!review || announcedAt === review.startedAt) return undefined
  const answer = justAnswered(before ?? undefined, review)
  if (answer) return `${answer}\r`
  return justFailed(before, review) ? failedMessage(review) : undefined
}
