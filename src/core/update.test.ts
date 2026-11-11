import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import type { UpdateEvent } from './update.ts'
import { checkToken, initialUpdate, isCheckDue, nextCheckAt, updateBanner, updateOn, updateText } from './update.ts'

test('without a token the updater is off, and Settings says how to turn it on', () => {
  const state = initialUpdate({ current: '0.1.0', hasToken: false })
  expect(state.status).toBe('off')
  expect(updateText(state)).toBe('Updates are off: paste a GitHub token below.')
})

/** The state of an updater with a token, after these events. */
const stateAfter = (...events: UpdateEvent[]) => events.reduce(updateOn, initialUpdate({ current: '0.1.0', hasToken: true }))

test('a download is ready once macOS\'s updater has it too, and the banner names its version', () => {
  const state = stateAfter({ type: 'checking', at: 1000 }, { type: 'available', version: '0.1.1' }, { type: 'downloaded' })
  expect(state.status).toBe('ready')
  expect(updateBanner(state)).toBe('Assay 0.1.1 is ready.')
  expect(updateBanner(stateAfter())).toBe(undefined)
})

test('an error after a download keeps the update ready and shows the error in Settings', () => {
  const ready = stateAfter({ type: 'checking', at: 1000 }, { type: 'available', version: '0.1.1' }, { type: 'downloaded' })
  const state = updateOn(ready, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })
  expect(state.status).toBe('ready')
  expect(updateBanner(state)).toBe('Assay 0.1.1 is ready.')
  expect(state.error).toBe('net::ERR_INTERNET_DISCONNECTED')
})

test('an error before any download is the state, and a later good check clears it', () => {
  const failed = stateAfter({ type: 'checking', at: 1000 }, { type: 'error', message: 'HttpError: 404' })
  expect(failed.status).toBe('error')
  expect(failed.error).toBe('HttpError: 404')
  expect(updateOn(updateOn(failed, { type: 'checking', at: 2000 }), { type: 'not-available' }).error).toBe(undefined)
})

const HOUR = 60 * 60 * 1000

test('the first check is 10 seconds after launch, and each next one an hour after the last', () => {
  expect(nextCheckAt(stateAfter(), { launchedAt: 5000 })).toBe(15_000)
  expect(nextCheckAt(stateAfter({ type: 'checking', at: 20_000 }, { type: 'not-available' }), { launchedAt: 5000 })).toBe(20_000 + HOUR)
})

test('a check is due only when its time has come and nothing is checking, downloading or waiting to install', () => {
  const idle = stateAfter({ type: 'checking', at: 0 }, { type: 'not-available' })
  expect(isCheckDue(idle, { launchedAt: 0, now: HOUR - 1 })).toBe(false)
  expect(isCheckDue(idle, { launchedAt: 0, now: HOUR })).toBe(true)
  const late = { launchedAt: 0, now: 10 * HOUR }
  expect(isCheckDue(stateAfter({ type: 'checking', at: 0 }, { type: 'error', message: 'x' }), late)).toBe(true)
  expect(isCheckDue(stateAfter({ type: 'checking', at: 0 }), late)).toBe(false)
  expect(isCheckDue(stateAfter({ type: 'checking', at: 0 }, { type: 'available', version: '0.1.1' }), late)).toBe(false)
  expect(isCheckDue(stateAfter({ type: 'checking', at: 0 }, { type: 'available', version: '0.1.1' }, { type: 'downloaded' }), late)).toBe(false)
  expect(isCheckDue(initialUpdate({ current: '0.1.0', hasToken: false }), late)).toBe(false)
})

test('pasting a token turns the updater on, and clearing it turns it off', () => {
  const off = initialUpdate({ current: '0.1.0', hasToken: false })
  const onAgain = updateOn(off, { type: 'token', isSet: true })
  expect(onAgain.status).toBe('idle')
  expect(updateOn(onAgain, { type: 'token', isSet: false }).status).toBe('off')
})

test('Settings says what the updater is doing', () => {
  expect(updateText(stateAfter())).toBe('Up to date.')
  expect(updateText(stateAfter({ type: 'checking', at: 0 }))).toBe('Checking for updates...')
  expect(updateText(stateAfter({ type: 'checking', at: 0 }, { type: 'available', version: '0.1.1' }))).toBe('Downloading Assay 0.1.1...')
  expect(updateText(stateAfter({ type: 'checking', at: 0 }, { type: 'available', version: '0.1.1' }, { type: 'downloaded' }))).toBe('Assay 0.1.1 installs when you restart or quit.')
  expect(updateText(stateAfter({ type: 'checking', at: 0 }, { type: 'error', message: 'HttpError: 401' }))).toBe('The last check failed.')
})

test('only a fine-grained GitHub token is accepted, trimmed', () => {
  expect(checkToken('  github_pat_11ABCDEF0_abcXYZ123\n')).toEqual({ ok: true, token: 'github_pat_11ABCDEF0_abcXYZ123' })
  expect(checkToken('ghp_classicToken123')).toEqual({ ok: false, message: 'Paste a fine-grained token: it starts with github_pat_.' })
  expect(checkToken('github_pat_has space')).toEqual({ ok: false, message: 'Paste a fine-grained token: it starts with github_pat_.' })
})

test('an error before macOS\'s updater has the download is a failure, not a ready update', () => {
  const state = stateAfter({ type: 'checking', at: 0 }, { type: 'available', version: '0.1.1' }, { type: 'error', message: 'Code signature did not match' })
  expect(state.status).toBe('error')
  expect(updateBanner(state)).toBe(undefined)
})

test('with the token forgotten mid-check, the updater stays off whatever the check reports', () => {
  const forgotten = updateOn(stateAfter({ type: 'checking', at: 0 }), { type: 'token', isSet: false })
  expect(updateOn(forgotten, { type: 'not-available' }).status).toBe('off')
  expect(updateOn(forgotten, { type: 'error', message: 'HttpError: 401' }).status).toBe('off')
  expect(updateOn(forgotten, { type: 'available', version: '0.1.1' }).status).toBe('off')
})

test('a token that cannot be read leaves the updater off and says why', () => {
  const state = updateOn(initialUpdate({ current: '0.1.0', hasToken: false }), { type: 'token', isSet: false, error: 'The saved token could not be decrypted.' })
  expect(state.status).toBe('off')
  expect(state.error).toBe('The saved token could not be decrypted.')
})

test('an install that does not quit the app drops the ready update and says so', () => {
  const ready = stateAfter({ type: 'checking', at: 0 }, { type: 'available', version: '0.1.1' }, { type: 'downloaded' })
  const state = updateOn(ready, { type: 'install-failed' })
  expect(state.status).toBe('error')
  expect(updateBanner(state)).toBe(undefined)
  expect(state.error).toBe('Assay 0.1.1 did not install. The next check downloads it again.')
})
