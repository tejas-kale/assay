import assert from 'node:assert/strict'
import { test } from 'node:test'

import { afterLastView, closeAction } from './windowClose.ts'

test('a view with no live session closes at once; a running one starts its graceful close; a closing one asks', () => {
  assert.equal(closeAction(undefined), 'close-now')
  assert.equal(closeAction('exited'), 'close-now')
  assert.equal(closeAction('running'), 'start-close')
  assert.equal(closeAction('closing'), 'ask-force')
})

test('the window ends after the last view when closing all or when a picker was the last, else the picker shows', () => {
  assert.equal(afterLastView(true, false), 'end-window')
  assert.equal(afterLastView(false, true), 'end-window')
  assert.equal(afterLastView(true, true), 'end-window')
  assert.equal(afterLastView(false, false), 'show-picker')
})
