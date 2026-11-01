import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pollFiles } from './watch.ts'
import type { WatchStat } from './watch.ts'

function setup() {
  const files = new Map<string, WatchStat>()
  let tick: () => Promise<void> | void = () => {}
  let interval = 0
  let stopped = false
  const stats: string[] = []
  const port = {
    stat: async (path: string) => {
      stats.push(path)
      return files.get(path)
    },
    setInterval: (cb: () => void, ms: number) => {
      tick = cb
      interval = ms
      return () => {
        stopped = true
      }
    },
  }
  // Lets the async tick settle.
  const run = async () => {
    tick()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise(r => setImmediate(r))
  }
  return { files, port, run, stats, get interval() { return interval }, get stopped() { return stopped } }
}

test('defaults to 500 ms', async () => {
  const s = setup()
  pollFiles(s.port, ['/a'], () => {})
  assert.equal(s.interval, 500)
  const t = setup()
  pollFiles(t.port, ['/a'], () => {}, 120)
  assert.equal(t.interval, 120)
})

test('fires on a change of mtime, of size, and of existence, not on no change', async () => {
  const s = setup()
  s.files.set('/a', { mtimeMs: 1, size: 10 })
  const changed: string[] = []
  pollFiles(s.port, ['/a', '/b'], path => void changed.push(path))
  await s.run()
  assert.deepEqual(changed, [])

  s.files.set('/a', { mtimeMs: 2, size: 10 })
  await s.run()
  assert.deepEqual(changed, ['/a'])

  await s.run()
  assert.deepEqual(changed, ['/a'])

  s.files.set('/a', { mtimeMs: 2, size: 11 })
  await s.run()
  s.files.delete('/a')
  await s.run()
  s.files.set('/b', { mtimeMs: 5, size: 1 })
  await s.run()
  assert.deepEqual(changed, ['/a', '/a', '/a', '/b'])
})

test('a rename-over save (new mtime, same size) is seen', async () => {
  const s = setup()
  s.files.set('/n', { mtimeMs: 1, size: 4 })
  const changed: string[] = []
  pollFiles(s.port, ['/n'], path => void changed.push(path))
  await s.run()
  s.files.set('/n', { mtimeMs: 9, size: 4 })
  await s.run()
  assert.deepEqual(changed, ['/n'])
})

test('stop ends the timer and silences later results', async () => {
  const s = setup()
  const changed: string[] = []
  const stop = pollFiles(s.port, ['/a'], path => void changed.push(path))
  await s.run()
  stop()
  assert.equal(s.stopped, true)
  s.files.set('/a', { mtimeMs: 3, size: 1 })
  await s.run()
  assert.deepEqual(changed, [])
})
