// What the Trust tab's keys mean and when it may act; the component only draws and sends.
import { canAnswer, canCheck, isActive } from './trust.ts'
import type { TrustReview } from './trust.ts'

export type TrustTabKey = 'down' | 'up' | 'top' | 'bottom' | 'next' | 'previous' | 'check' | 'trust' | 'reject' | 'list'

const TRUST_KEYS: Record<string, TrustTabKey> = {
  j: 'down',
  k: 'up',
  g: 'top',
  G: 'bottom',
  J: 'next',
  ArrowDown: 'next',
  K: 'previous',
  ArrowUp: 'previous',
  c: 'check',
  Enter: 'check',
  t: 'trust',
  r: 'reject',
  l: 'list',
}

export function trustTabKey(key: string): TrustTabKey | undefined {
  return Object.hasOwn(TRUST_KEYS, key) ? TRUST_KEYS[key] : undefined
}

/** The proposal selected after moving `delta` places, kept inside the list (`count` is unknown while it loads). */
export function movedProposal(selected: number, delta: 1 | -1, count: number | undefined): number {
  return delta === 1 ? Math.min((count ?? 1) - 1, selected + 1) : Math.max(0, selected - 1)
}

/** Check on the chosen proposal: go ahead, or say why not while another review is active. */
export type CheckPlan = { do: 'check' } | { do: 'wait'; message: string } | { do: 'nothing' }

export function checkPlan(review: TrustReview | undefined, isSending: boolean): CheckPlan {
  if (!canCheck(review)) return { do: 'wait', message: `Wait for the review of ${review?.name ?? 'the other proposal'} to finish.` }
  return isSending ? { do: 'nothing' } : { do: 'check' }
}

/** Trust or Reject is offered once every check passed, and not while a request is on its way. */
export const mayAnswer = (review: TrustReview | undefined, isSending: boolean): boolean => canAnswer(review) && !isSending

/** Changes when a review settles (an approval removes its draft), which is when the proposals are listed again. */
export function settledKey(review: TrustReview | undefined): string {
  if (!review || isActive(review.state)) return ''
  return `${review.name}:${review.state}:${String(review.startedAt)}`
}
