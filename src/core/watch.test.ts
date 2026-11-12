import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pollFiles, pollSignature, statSignature } from './watch.ts'
import type { WatchStat } from './watch.ts'

function setup() {
  const files = new Map<string, WatchStat>()
  const failing = new Set<string>()
  let tick: () => void = () => {}
  let interval = 0
  let stopped = false
  const port = {
    stat: (path: string) => (failing.has(path) ? Promise.reject(new Error('EACCES')) : Promise.resolve(files.get(path))),
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
  return { files, failing, port, run, get interval() { return interval }, get stopped() { return stopped } }
}

test('defaults to 500 ms', () => {
  const s = setup()
  pollFiles(s.port, ['/a'], () => {})
  assert.equal(s.interval, 500)
  const t = setup()
  pollFiles(t.port, ['/a'], () => {}, 120)
  assert.equal(t.interval, 120)
  const u = setup()
  pollSignature(u.port, () => Promise.resolve('a'), () => {})
  assert.equal(u.interval, 500)
})

test('a signature is mtime and size, or missing', () => {
  assert.equal(statSignature({ mtimeMs: 12.5, size: 3 }), '12.5:3')
  assert.equal(statSignature(undefined), 'missing')
})

test('fires on a change of mtime, of size, and of existence, not on no change', async () => {
  const s = setup()
  s.files.set('/a', { mtimeMs: 1, size: 10 })
  const changed: string[] = []
  pollFiles(s.port, ['/a', '/b'], path => {
    changed.push(path)
  })
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

test('a file that cannot be read counts as missing', async () => {
  const s = setup()
  s.files.set('/a', { mtimeMs: 1, size: 1 })
  const changed: string[] = []
  pollFiles(s.port, ['/a'], path => {
    changed.push(path)
  })
  await s.run()
  s.failing.add('/a')
  await s.run()
  assert.deepEqual(changed, ['/a'])
  await s.run()
  assert.deepEqual(changed, ['/a'])
})

test('a rename-over save (new mtime, same size) is seen', async () => {
  const s = setup()
  s.files.set('/n', { mtimeMs: 1, size: 4 })
  const changed: string[] = []
  pollFiles(s.port, ['/n'], path => {
    changed.push(path)
  })
  await s.run()
  s.files.set('/n', { mtimeMs: 9, size: 4 })
  await s.run()
  assert.deepEqual(changed, ['/n'])
})

test('stop ends the timer and silences later results', async () => {
  const s = setup()
  const changed: string[] = []
  const stop = pollFiles(s.port, ['/a'], path => {
    changed.push(path)
  })
  await s.run()
  stop()
  assert.equal(s.stopped, true)
  s.files.set('/a', { mtimeMs: 3, size: 1 })
  await s.run()
  assert.deepEqual(changed, [])
})

test('a poll that is still looking is not started twice, and one stopped meanwhile reports nothing', async () => {
  const s = setup()
  let release = () => {}
  let stats = 0
  const slow = {
    ...s.port,
    stat: async (path: string) => {
      stats++
      if (stats > 1) await new Promise<void>(resolve => (release = resolve))
      return s.port.stat(path)
    },
  }
  const changed: string[] = []
  const stop = pollFiles(slow, ['/a'], path => {
    changed.push(path)
  })
  await s.run()
  s.files.set('/a', { mtimeMs: 2, size: 1 })
  const first = s.run()
  await s.run()
  assert.equal(stats, 2)
  stop()
  release()
  await first
  assert.deepEqual(changed, [])
})

test('a change callback that throws is an unhandled rejection, and the next poll still runs', async () => {
  const s = setup()
  s.files.set('/a', { mtimeMs: 1, size: 1 })
  const seen: string[] = []
  const listeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  const rejection = new Promise<unknown>(resolve => process.once('unhandledRejection', resolve))
  try {
    pollFiles(s.port, ['/a'], path => {
      seen.push(path)
      if (seen.length === 1) throw new Error('callback failed')
    })
    await s.run()
    s.files.set('/a', { mtimeMs: 2, size: 1 })
    await s.run()
    assert.match(String(await rejection), /callback failed/)
  } finally {
    for (const listener of listeners) process.on('unhandledRejection', listener)
  }
  s.files.set('/a', { mtimeMs: 3, size: 1 })
  await s.run()
  assert.deepEqual(seen, ['/a', '/a'])
})

test('pollSignature takes the first read as the baseline and reports changes once', async () => {
  const s = setup()
  let value = 'a'
  let changes = 0
  pollSignature(s.port, () => Promise.resolve(value), () => {
    changes++
  })
  await s.run()
  assert.equal(changes, 0)
  value = 'b'
  await s.run()
  assert.equal(changes, 1)
  await s.run()
  assert.equal(changes, 1)
})

test('pollSignature ignores a failed read, does not overlap reads and stops', async () => {
  const s = setup()
  let fail = false
  let reads = 0
  let release = () => {}
  let hold = false
  let changes = 0
  const answer = () => {
    if (fail) return 'z'
    return hold ? 'b' : 'a'
  }
  const stop = pollSignature(
    s.port,
    async () => {
      reads++
      if (fail) throw new Error('x')
      if (hold) await new Promise<void>(r => (release = r))
      return answer()
    },
    () => {
      changes++
    },
  )
  await s.run()
  fail = true
  await s.run()
  assert.equal(changes, 0)
  fail = false
  hold = true
  const before = reads
  const first = s.run()
  await s.run()
  assert.equal(reads, before + 1)
  release()
  await first
  await new Promise(r => setImmediate(r))
  assert.equal(changes, 1)
  stop()
  assert.equal(s.stopped, true)
})

test('pollSignature reports nothing for a read that finishes after stop', async () => {
  const s = setup()
  let release = () => {}
  let reads = 0
  let changes = 0
  const stop = pollSignature(
    s.port,
    async () => {
      reads++
      if (reads > 1) await new Promise<void>(r => (release = r))
      return String(reads)
    },
    () => {
      changes++
    },
  )
  await s.run()
  const second = s.run()
  await Promise.resolve()
  stop()
  release()
  await second
  assert.equal(changes, 0)
})
