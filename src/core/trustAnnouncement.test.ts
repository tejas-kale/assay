import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TrustReview } from './trust.ts'
import { trustAnnouncement } from './trustAnnouncement.ts'

const review = (state: TrustReview['state'], startedAt = 100): TrustReview => ({ name: 'churn', kind: 'calculation', what: 'SQL template', replaces: false, state, startedAt, steps: [] })

test('no review says nothing', () => {
  assert.equal(trustAnnouncement({ before: null, review: undefined, announcedAt: undefined }), undefined)
})

test('the user approving or rejecting is typed as trusted or rejected', () => {
  assert.equal(trustAnnouncement({ before: review('asking'), review: review('approved'), announcedAt: undefined }), 'trusted\r')
  assert.equal(trustAnnouncement({ before: review('asking'), review: review('rejected'), announcedAt: undefined }), 'rejected\r')
})

test('a failing check tells Claude which steps failed, once', () => {
  const failed = review('failed')
  const text = trustAnnouncement({ before: review('checking'), review: failed, announcedAt: undefined })
  assert.match(text ?? '', /^The Trust tab check of churn failed: /)
  assert.equal(trustAnnouncement({ before: review('checking'), review: failed, announcedAt: 100 }), undefined)
})

test('a first look at an already failed review is not announced, a first look after an empty one is', () => {
  assert.equal(trustAnnouncement({ before: undefined, review: review('failed'), announcedAt: undefined }), undefined)
  assert.notEqual(trustAnnouncement({ before: null, review: review('error'), announcedAt: undefined }), undefined)
})

test('a review still in progress says nothing', () => {
  assert.equal(trustAnnouncement({ before: review('checking'), review: review('checking'), announcedAt: undefined }), undefined)
})
