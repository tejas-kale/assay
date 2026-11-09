import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EMPTY_SET, MAX_ANALYSES, closeAnalysis, closeCurrent, openAnalysisIn, restoreSet, switchTo } from './analysisSet.ts'

const open = (...paths: string[]) => {
  let set = EMPTY_SET
  for (const path of paths) {
    const result = openAnalysisIn(set, path)
    assert.ok(result.ok)
    set = result.set
  }
  return set
}

test('opening analyses numbers them in opening order and shows the newest', () => {
  const set = open('/a', '/b', '/c')
  assert.deepEqual(set.paths, ['/a', '/b', '/c'])
  assert.equal(set.current, '/c')
})

test('opening an analysis already in the set shows it without adding it again', () => {
  const result = openAnalysisIn(open('/a', '/b'), '/a')
  assert.ok(result.ok)
  assert.deepEqual(result.set.paths, ['/a', '/b'])
  assert.equal(result.set.current, '/a')
})

test('a tenth analysis is refused and the set is unchanged', () => {
  assert.equal(MAX_ANALYSES, 9)
  const full = open('/1', '/2', '/3', '/4', '/5', '/6', '/7', '/8', '/9')
  const result = openAnalysisIn(full, '/10')
  assert.deepEqual(result, { ok: false, reason: 'full' })
})

test('switching by number shows that analysis; a number with no analysis changes nothing', () => {
  const set = open('/a', '/b', '/c')
  assert.equal(switchTo(set, 1).current, '/a')
  assert.equal(switchTo(set, 2).current, '/b')
  assert.equal(switchTo(set, 7), set)
})

test('closing the shown analysis renumbers the rest and shows the one that took its number', () => {
  const set = closeCurrent(switchTo(open('/a', '/b', '/c'), 2))
  assert.deepEqual(set.paths, ['/a', '/c'])
  assert.equal(set.current, '/c')
})

test('closing the last-numbered analysis shows the one before it; closing the only one leaves none', () => {
  assert.equal(closeCurrent(open('/a', '/b')).current, '/a')
  assert.deepEqual(closeCurrent(open('/a')), EMPTY_SET)
})

test('a saved set is restored in order, dropping duplicates and anything past nine; a missing current falls to the first', () => {
  const saved = { paths: ['/a', '/b', '/a', '/c', '/d', '/e', '/f', '/g', '/h', '/i', '/j'], current: '/zzz' }
  const set = restoreSet(saved)
  assert.deepEqual(set.paths, ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i'])
  assert.equal(set.current, '/a')
  assert.equal(restoreSet({ paths: ['/a', '/b'], current: '/b' }).current, '/b')
  assert.deepEqual(restoreSet({ paths: [], current: undefined }), EMPTY_SET)
})

test('closing an analysis that is not shown renumbers the rest and keeps the shown one; an unknown path changes nothing', () => {
  const set = switchTo(open('/a', '/b', '/c'), 3)
  const closed = closeAnalysis(set, '/a')
  assert.deepEqual(closed.paths, ['/b', '/c'])
  assert.equal(closed.current, '/c')
  assert.deepEqual(closeAnalysis(set, '/c'), closeCurrent(set))
  assert.equal(closeAnalysis(set, '/zzz'), set)
})
