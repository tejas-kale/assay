import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { RUNNING, shutdownOn } from './shutdown.ts'
import type { Shutdown, ShutdownEvent } from './shutdown.ts'

/** The state after these events, from a running app, and the last event's action. */
function after(...events: ShutdownEvent[]) {
  let state: Shutdown = RUNNING
  let action = 'none'
  for (const event of events) ({ state, action } = shutdownOn(state, event))
  return { state, action }
}

test('Cmd+Q with no live session lets the quit through at once', () => {
  expect(after({ type: 'quit', live: false })).toEqual({ state: { phase: 'finishing', then: 'quit' }, action: 'allow-quit' })
})

test('Cmd+Q with live sessions holds the quit, closes every analysis, and quits when the last one has exited', () => {
  expect(after({ type: 'quit', live: true })).toEqual({ state: { phase: 'closing', then: 'quit' }, action: 'close-all' })
  expect(after({ type: 'quit', live: true }, { type: 'closed', live: true }).action).toBe('none')
  expect(after({ type: 'quit', live: true }, { type: 'closed', live: false }).action).toBe('quit')
  expect(after({ type: 'quit', live: true }, { type: 'closed', live: false }, { type: 'quit', live: false }).action).toBe('allow-quit')
})

test('a second Cmd+Q while closing holds the quit again and starts nothing new', () => {
  expect(after({ type: 'quit', live: true }, { type: 'quit', live: true })).toEqual({ state: { phase: 'closing', then: 'quit' }, action: 'none' })
})

test('Restart closes every analysis, then installs instead of quitting', () => {
  expect(after({ type: 'restart', live: true })).toEqual({ state: { phase: 'closing', then: 'install' }, action: 'close-all' })
  expect(after({ type: 'restart', live: true }, { type: 'closed', live: false }).action).toBe('install')
  expect(after({ type: 'restart', live: false }).action).toBe('install')
  // The installer quits the app itself.
  expect(after({ type: 'restart', live: false }, { type: 'quit', live: false }).action).toBe('allow-quit')
})

test('Cmd+Q during a restart quits instead, and Restart during a quit installs instead', () => {
  expect(after({ type: 'restart', live: true }, { type: 'quit', live: true }, { type: 'closed', live: false }).action).toBe('quit')
  expect(after({ type: 'quit', live: true }, { type: 'restart', live: true }, { type: 'closed', live: false }).action).toBe('install')
})

test('an install that never quits the app reopens the analyses', () => {
  expect(after({ type: 'restart', live: false }, { type: 'install-failed' })).toEqual({ state: RUNNING, action: 'reopen' })
  expect(after({ type: 'quit', live: false }, { type: 'install-failed' }).action).toBe('none')
})

test('analyses closing while nothing is shutting down change nothing', () => {
  expect(after({ type: 'closed', live: false })).toEqual({ state: RUNNING, action: 'none' })
})
