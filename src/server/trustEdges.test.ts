// The trust review's edges: why approving fails, how the helper's stream can end, and the proposals it lists.
import { test, mock } from 'node:test'

import { expect } from '../testing/expect.ts'
import { fake, until } from './testing.ts'
import type { Fake, Run, Serve } from './testing.ts'
import { removeDraft } from './trustPromote.ts'
import { listProposals } from './trustProposals.ts'
import { applyEvent, describeProposal } from './trustReview.ts'
import type { Review } from './trustReview.ts'
import { streamChecks } from './trustStream.ts'

const CODE = 'SELECT 1\n'
const STEPS = [{ step: 'form', ok: true, text: 'SQL template' }]
const START = { event: 'start', name: 'calc', kind: 'sql', file: 'calc.sql', description: 'A calculation.', code: CODE, files: ['calc.sql'], texts: { 'calc.sql': CODE } }
const CHECKED = { name: 'calc', ok: true, kind: 'sql', file: 'calc.sql', code: CODE, files: ['calc.sql'], texts: { 'calc.sql': CODE }, steps: STEPS }
const files = (extra: Record<string, string> = {}) => ({ 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay/bin/python': '', 'lib/trusted/calc.sql': CODE, ...extra })

const isCheck = (argv: readonly string[]) => argv.includes('--stream')
const perform = (ws: Fake, request: object) => ws.requests.perform(request as never)
const stateOf = async (ws: Fake) => (JSON.parse((await ws.file('.assay/trust/calc.json')) ?? 'null') as { state?: string; message?: string } | null)
const waitFor = (ws: Fake, state: string) => until(async () => (await stateOf(ws))?.state === state)

/** The helper process of the review, once the server started it. */
async function helper(ws: Fake): Promise<Serve> {
  expect(await until(() => ws.serves.some(serve => isCheck(serve.argv)))).toBe(true)
  const serve = ws.serves.find(each => isCheck(each.argv))
  if (!serve) throw new Error('The review started no helper.')
  return serve
}

/** A review of `calc` that passed its checks, and the answer: the git commands answer by `git`. */
async function approve(ws: Fake, git: (argv: readonly string[]) => { exitCode?: number; stdout?: string; stderr?: string }, answer: object = CHECKED) {
  const run: Run = argv => (argv[0] === 'git' ? git(argv) : {})
  ws.setRun(run)
  await perform(ws, { kind: 'trust-check', name: 'calc' })
  const check = await helper(ws)
  check.emit(START)
  check.emit({ event: 'done', answer })
  expect(await waitFor(ws, 'asking')).toBe(true)
  return perform(ws, { kind: 'trust-answer', name: 'calc', answer: 'trust' })
}

const ok = (argv: readonly string[]) => ({ stdout: argv.includes('rev-parse') ? '/work' : '', exitCode: argv.includes('diff') ? 1 : 0 })
const failing = (command: string, result: { stdout?: string; stderr?: string }) => (argv: readonly string[]) => (argv.includes(command) ? { exitCode: 1, ...result } : ok(argv))

test('approving outside a git repository ends the review in error, and nothing is copied', async () => {
  const ws = await fake(files())
  const reply = await approve(ws, argv => (argv.includes('rev-parse') ? { exitCode: 128 } : ok(argv)))
  expect(reply).toEqual({ error: `${ws.root} is not in a git repository: approving commits there.` })
  expect((await stateOf(ws))?.state).toBe('error')
  expect(await ws.file('/work/trusted/calc.sql')).toBeUndefined()
  await ws.done()
})

test('a git that cannot start is the same as one that fails', async () => {
  const ws = await fake(files())
  const reply = await approve(ws, () => {
    throw new Error('spawn git ENOENT')
  })
  expect(reply).toEqual({ error: `${ws.root} is not in a git repository: approving commits there.` })
  await ws.done()
})

test('approving says when the trusted folder cannot be made or a proposal file has no checked copy', async () => {
  const blocked = await fake(files({ '/work/trusted': 'a file where the folder should be' }))
  expect(await approve(blocked, ok)).toEqual({ error: `Cannot make ${blocked.root}/trusted.` })
  await blocked.done()
  const missing = await fake(files())
  const reply = await approve(missing, ok, { ...CHECKED, files: ['calc.sql', 'calc.test.yaml'] })
  expect(reply).toEqual({ error: 'No checked copy of calc.test.yaml.' })
  expect((await stateOf(missing))?.message).toBe('No checked copy of calc.test.yaml.')
  await missing.done()
})

test('git add and git commit failures are the review error, with the last line of what git said', async () => {
  const added = await fake(files())
  expect(await approve(added, failing('add', { stderr: ' fatal: no pathspec \n' }))).toEqual({ error: 'git add failed: fatal: no pathspec' })
  await added.done()
  const committed = await fake(files())
  expect(await approve(committed, failing('commit', { stderr: 'hint: one\nerror: hook failed\n' }))).toEqual({ error: 'git commit failed: error: hook failed' })
  await committed.done()
  const quiet = await fake(files())
  expect(await approve(quiet, failing('commit', { stdout: 'nothing to say\n' }))).toEqual({ error: 'git commit failed: nothing to say' })
  expect((await stateOf(quiet))?.state).toBe('error')
  await quiet.done()
})

test('a review whose answer is not trust, or has no answer, is rejected', async () => {
  const ws = await fake(files())
  ws.setRun(() => ({}))
  await perform(ws, { kind: 'trust-check', name: 'calc' })
  const check = await helper(ws)
  check.emit({ event: 'done', answer: CHECKED })
  expect(await waitFor(ws, 'asking')).toBe(true)
  expect(await perform(ws, { kind: 'trust-answer', name: 'calc', answer: 'reject' })).toEqual({ ok: true })
  expect((await stateOf(ws))?.state).toBe('rejected')
  await ws.done()
})

test('a done event that is an error ends the review as an error with the helper message', async () => {
  const ws = await fake(files())
  await perform(ws, { kind: 'trust-check', name: 'calc' })
  const check = await helper(ws)
  check.emit({ event: 'done', answer: { error: 'ParseError: bad' } })
  expect(await waitFor(ws, 'error')).toBe(true)
  expect((await stateOf(ws))?.message).toBe('ParseError: bad')
  await ws.done()
})

test('a helper whose last line has no newline still gets that line read; output after done is ignored', async () => {
  const ws = await fake(files())
  await perform(ws, { kind: 'trust-check', name: 'calc' })
  const check = await helper(ws)
  check.emit(START)
  check.print(JSON.stringify({ event: 'done', answer: CHECKED }))
  check.end(0)
  expect(await waitFor(ws, 'asking')).toBe(true)
  await ws.done()
})

test('a helper that exits silently, or by a signal, says how it exited', async () => {
  const silent = await fake(files())
  await perform(silent, { kind: 'trust-check', name: 'calc' })
  ;(await helper(silent)).end(3)
  expect(await waitFor(silent, 'error')).toBe(true)
  expect((await stateOf(silent))?.message).toBe('analysis_trust exited with 3')
  await silent.done()
  const killed = await fake(files())
  await perform(killed, { kind: 'trust-check', name: 'calc' })
  const check = await helper(killed)
  check.print('one\ntwo\nthree\nfour\n', 'stderr')
  check.end(null)
  expect(await waitFor(killed, 'error')).toBe(true)
  expect((await stateOf(killed))?.message).toBe('two three four')
  await killed.done()
})

const review = (ws: Fake, overrides: Partial<Review> = {}): Review => ({
  name: 'calc',
  kind: 'calculation',
  folder: `${ws.analysis}/lib/trusted`,
  dest: `${ws.root}/trusted`,
  what: 'SQL template',
  language: 'sql',
  replaces: false,
  startedAt: 0,
  state: 'checking',
  ...overrides,
})

test('checks that run past ten minutes are stopped, and the review says so', async () => {
  const ws = await fake(files())
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const streamed = streamChecks(ws.assay, review(ws), () => undefined)
    // The helper starts after the server looked for its python: real I/O, not a timer.
    while (ws.serves.length === 0) await new Promise(resolve => setImmediate(resolve))
    mock.timers.tick(600_000)
    expect(await streamed).toBe('The checks took more than 10 minutes and were stopped.')
  } finally {
    mock.timers.reset()
  }
  await ws.done()
})

test('streaming without a python says how to build the venv; a dictionary entry is checked by its file', async () => {
  const bare = await fake({ 'analysis.yaml': 'title: Feature\n' })
  expect(await streamChecks(bare.assay, review(bare), () => undefined)).toMatch(/not built/)
  await bare.done()
  const ws = await fake(files())
  const streamed = streamChecks(ws.assay, review(ws, { kind: 'dictionary', name: 'a.b.c', folder: `${ws.analysis}/lib/dictionaries` }), () => undefined)
  const serve = await helper(ws)
  expect(serve.argv.slice(3)).toEqual(['check-entry', `${ws.analysis}/lib/dictionaries/a.b.c.yaml`, ws.analysis, '--stream'])
  serve.end(0)
  expect(await streamed).toBe('analysis_trust exited with 0')
  await ws.done()
})

test('the proposals are the drafted calculations and dictionary entries, skipping tests and other files', async () => {
  const ws = await fake(
    files({
      'lib/trusted/zeta.py': '',
      'lib/trusted/test_zeta.py': '',
      'lib/trusted/Upper.sql': '',
      'lib/trusted/notes.md': '',
      'lib/trusted/B.sql': '',
      'lib/dictionaries/Main.Panel.Sites.yaml': '',
      'lib/dictionaries/two.parts.yaml': '',
    }),
  )
  expect(await listProposals(ws.assay)).toEqual([
    { name: 'calc', kind: 'calculation', folder: 'lib/trusted', ext: 'sql' },
    { name: 'zeta', kind: 'calculation', folder: 'lib/trusted', ext: 'py' },
    { name: 'main.panel.sites', kind: 'dictionary', folder: 'lib/dictionaries', ext: 'yaml' },
  ])
  await ws.done()
})

test('a proposal is a SQL template, a Python function or a dictionary entry by kind and extension', () => {
  expect(describeProposal('calculation', 'sql')).toEqual({ what: 'SQL template', language: 'sql' })
  expect(describeProposal('calculation', 'py')).toEqual({ what: 'Python function', language: 'python' })
  expect(describeProposal('dictionary', 'yaml')).toEqual({ what: 'dictionary entry', language: 'yaml' })
})

test('the helper events build the review: a step before start makes the answer, start says what the proposal is', async () => {
  const ws = await fake(files())
  const open = review(ws)
  expect(applyEvent(open, { event: 'step', step: STEPS[0] as never })).toBeUndefined()
  expect(open.answer).toEqual({ name: 'calc', ok: false, steps: STEPS })
  expect(applyEvent(open, { event: 'start', name: 'calc', kind: 'python' })).toBeUndefined()
  expect([open.what, open.language, open.answer?.steps]).toEqual(['Python function', 'python', []])
  applyEvent(open, { event: 'start', name: 'calc', kind: 'sql', block: { grain: ['a'], columns: ['b'] } })
  expect([open.what, open.language]).toEqual(['SQL block', 'sql'])
  applyEvent(open, { event: 'start', name: 'calc', kind: 'sql' })
  expect(open.what).toBe('SQL template')
  applyEvent(open, { event: 'start', name: 'calc', kind: 'other' })
  expect(open.what).toBe('SQL template')
  await ws.done()
})

test('removing the draft leaves a draft that vanished, and does nothing when the draft folder is the destination', async () => {
  const ws = await fake(files())
  const open = review(ws)
  expect(await removeDraft(ws.assay, open, [{ file: 'gone.sql', text: 'x' }, { file: 'calc.sql', text: 'changed' }, { file: 'other.sql', text: 'x' }])).toEqual(['lib/trusted/calc.sql'])
  expect(await removeDraft(ws.assay, review(ws, { dest: `${ws.analysis}/lib/trusted` }), [{ file: 'calc.sql', text: CODE }])).toEqual([])
  expect(await ws.file('lib/trusted/calc.sql')).toBe(CODE)
  await ws.done()
})
