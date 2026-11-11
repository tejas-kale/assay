import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { checkToken, initialUpdate, isCheckDue, nextCheckAt, updateBanner, updateOn, updateText } from './update.ts'

test('without a token the updater is off, and Settings says how to turn it on', () => {
  const state = initialUpdate({ current: '0.1.0', hasToken: false })
  expect(state.status).toBe('off')
  expect(updateText(state)).toBe('Updates are off: paste a GitHub token below.')
})

const on = (...events: Parameters<typeof updateOn>[1][]) => events.reduce(updateOn, initialUpdate({ current: '0.1.0', hasToken: true }))

test('a finished download is ready, and the banner names its version', () => {
  const state = on({ type: 'checking', at: 1000 }, { type: 'available', version: '0.1.1' }, { type: 'downloaded', version: '0.1.1' })
  expect(state.status).toBe('ready')
  expect(updateBanner(state)).toBe('Assay 0.1.1 is ready.')
  expect(updateBanner(on())).toBe(undefined)
})

test('an error after a download keeps the update ready and shows the error in Settings', () => {
  const ready = on({ type: 'checking', at: 1000 }, { type: 'available', version: '0.1.1' }, { type: 'downloaded', version: '0.1.1' })
  const state = updateOn(ready, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })
  expect(state.status).toBe('ready')
  expect(updateBanner(state)).toBe('Assay 0.1.1 is ready.')
  expect(state.error).toBe('net::ERR_INTERNET_DISCONNECTED')
})

test('an error before any download is the state, and a later good check clears it', () => {
  const failed = on({ type: 'checking', at: 1000 }, { type: 'error', message: 'HttpError: 404' })
  expect(failed.status).toBe('error')
  expect(failed.error).toBe('HttpError: 404')
  expect(updateOn(updateOn(failed, { type: 'checking', at: 2000 }), { type: 'not-available' }).error).toBe(undefined)
})

const HOUR = 60 * 60 * 1000

test('the first check is 10 seconds after launch, and each next one an hour after the last', () => {
  expect(nextCheckAt(on(), { launchedAt: 5000 })).toBe(15_000)
  expect(nextCheckAt(on({ type: 'checking', at: 20_000 }, { type: 'not-available' }), { launchedAt: 5000 })).toBe(20_000 + HOUR)
})

test('a check is due only when its time has come and nothing is checking, downloading or waiting to install', () => {
  const idle = on({ type: 'checking', at: 0 }, { type: 'not-available' })
  expect(isCheckDue(idle, { launchedAt: 0, now: HOUR - 1 })).toBe(false)
  expect(isCheckDue(idle, { launchedAt: 0, now: HOUR })).toBe(true)
  const late = { launchedAt: 0, now: 10 * HOUR }
  expect(isCheckDue(on({ type: 'checking', at: 0 }, { type: 'error', message: 'x' }), late)).toBe(true)
  expect(isCheckDue(on({ type: 'checking', at: 0 }), late)).toBe(false)
  expect(isCheckDue(on({ type: 'checking', at: 0 }, { type: 'available', version: '0.1.1' }), late)).toBe(false)
  expect(isCheckDue(on({ type: 'checking', at: 0 }, { type: 'downloaded', version: '0.1.1' }), late)).toBe(false)
  expect(isCheckDue(initialUpdate({ current: '0.1.0', hasToken: false }), late)).toBe(false)
})

test('pasting a token turns the updater on, and clearing it turns it off', () => {
  const off = initialUpdate({ current: '0.1.0', hasToken: false })
  const onAgain = updateOn(off, { type: 'token', isSet: true })
  expect(onAgain.status).toBe('idle')
  expect(updateOn(onAgain, { type: 'token', isSet: false }).status).toBe('off')
})

test('Settings says what the updater is doing', () => {
  expect(updateText(on())).toBe('Up to date.')
  expect(updateText(on({ type: 'checking', at: 0 }))).toBe('Checking for updates...')
  expect(updateText(on({ type: 'checking', at: 0 }, { type: 'available', version: '0.1.1' }))).toBe('Downloading Assay 0.1.1...')
  expect(updateText(on({ type: 'checking', at: 0 }, { type: 'downloaded', version: '0.1.1' }))).toBe('Assay 0.1.1 installs when you restart or quit.')
  expect(updateText(on({ type: 'checking', at: 0 }, { type: 'error', message: 'HttpError: 401' }))).toBe('The last check failed.')
})

test('only a fine-grained GitHub token is accepted, trimmed', () => {
  expect(checkToken('  github_pat_11ABCDEF0_abcXYZ123\n')).toEqual({ ok: true, token: 'github_pat_11ABCDEF0_abcXYZ123' })
  expect(checkToken('ghp_classicToken123')).toEqual({ ok: false, message: 'Paste a fine-grained token: it starts with github_pat_.' })
  expect(checkToken('github_pat_has space')).toEqual({ ok: false, message: 'Paste a fine-grained token: it starts with github_pat_.' })
})
