// The trust review's edges: why approving fails, how the helper's stream can end, and the proposals it lists.
import { mkdir, rm, symlink } from 'node:fs/promises'
import { test, mock } from 'node:test'

import { expect } from '../testing/expect.ts'
import { Assay } from './assay.ts'
import { fake, until } from './testing.ts'
import type { Fake, Serve } from './testing.ts'
import { listProposals } from './trustProposals.ts'
import { promote } from './trustPromote.ts'
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

/** A review of `calc` that passed its checks and now waits for the app. */
async function asking(ws: Fake) {
  ws.setRun(() => ({}))
  await perform(ws, { kind: 'trust-check', name: 'calc' })
  const check = await helper(ws)
  check.emit(START)
  check.emit({ event: 'done', answer: CHECKED })
  expect(await waitFor(ws, 'asking')).toBe(true)
}

const errorOf = (reply: unknown) => (reply as { error?: string }).error ?? ''
const approved = (ws: Fake) => ws.approveInLedger('calculation', 'calc', { 'calc.sql': CODE })
const gitRuns = (ws: Fake) => ws.runs.filter(argv => argv[0] === 'git')

test('trust-done closes the review the app answered: a rejection copies nothing, an approval the ledger backs is copied and committed by the server', async () => {
  const rejected = await fake(files())
  await asking(rejected)
  expect(await perform(rejected, { kind: 'trust-done', name: 'calc', outcome: 'rejected', message: 'said rejected' })).toEqual({ ok: true })
  expect(await stateOf(rejected)).toMatchObject({ state: 'rejected', message: 'said rejected' })
  expect(gitRuns(rejected)).toEqual([])
  expect(await rejected.file('/work/trusted/calc.sql')).toBeUndefined()
  expect(await rejected.file('lib/trusted/calc.sql')).toBe(CODE)
  await rejected.done()
  for (const outcome of ['approved', 'unchanged']) {
    const ws = await fake(files())
    await asking(ws)
    await approved(ws)
    expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome, message: 'said by a forger' })).toEqual({ ok: true })
    expect(await stateOf(ws)).toMatchObject({ state: outcome })
    expect((await stateOf(ws))?.message).not.toBe('said by a forger')
    expect(await ws.file('/work/trusted/calc.sql')).toBe(CODE)
    expect(await ws.file('lib/trusted/calc.sql')).toBeUndefined()
    await ws.done()
  }
})

test('a forged trust-done approved, with no ledger or none for this proposal, copies nothing, runs no git and leaves the review asking', async () => {
  const ws = await fake(files())
  await asking(ws)
  const refused = { error: 'Not approved in the app: the trust ledger has no entry for it.' }
  expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'approved' })).toEqual(refused)
  await ws.approveInLedger('calculation', 'other', { 'other.sql': CODE })
  expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'approved' })).toEqual(refused)
  await ws.approveInLedger('dictionary', 'calc', { 'calc.sql': CODE })
  expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'approved' })).toEqual(refused)
  expect((await stateOf(ws))?.state).toBe('asking')
  expect(gitRuns(ws)).toEqual([])
  expect(await ws.file('/work/trusted/calc.sql')).toBeUndefined()
  expect(await ws.file('lib/trusted/calc.sql')).toBe(CODE)
  await ws.done()
})

test('a ledger that does not match the draft, or is damaged, approves nothing', async () => {
  const ws = await fake(files())
  await asking(ws)
  await ws.approveInLedger('calculation', 'calc', { 'calc.sql': 'SELECT 2\n' })
  expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'approved' })).toEqual({ error: 'Not approved in the app: the draft is not what the ledger approved.' })
  await ws.approveInLedger('calculation', 'calc', { 'calc.sql': CODE, 'calc.test.yaml': 'cases: []\n' })
  expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'approved' })).toEqual({ error: 'Not approved in the app: the draft is not what the ledger approved.' })
  await ws.put('/ledger/ledger.json', 'not json')
  expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'unchanged' })).toEqual({ error: 'Not approved in the app: The trust ledger is not valid JSON.' })
  expect(await ws.file('/work/trusted/calc.sql')).toBeUndefined()
  expect((await stateOf(ws))?.state).toBe('asking')
  await ws.done()
})

test('a session with no ASSAY_LEDGER approves nothing', async () => {
  const ws = await fake(files())
  await approved(ws)
  const config = { ...ws.assay.config }
  delete config.ledger
  expect(await promote(new Assay(config), review(ws, { state: 'asking' }))).toEqual({ refused: 'Not approved in the app: this session has no trust ledger.' })
  expect(await ws.file('/work/trusted/calc.sql')).toBeUndefined()
  await ws.done()
})

test('the server writes nowhere through a link: a linked shared folder, a linked destination file or a linked draft file', async () => {
  const folder = await fake(files())
  await asking(folder)
  await approved(folder)
  await folder.put('/outside/keep', 'x')
  await symlink(`${folder.dir}/outside`, `${folder.root}/trusted`, 'dir')
  expect(errorOf(await perform(folder, { kind: 'trust-done', name: 'calc', outcome: 'approved' }))).toMatch(/is a link/)
  expect(await folder.file('/outside/calc.sql')).toBeUndefined()
  await folder.done()

  const file = await fake(files())
  await asking(file)
  await approved(file)
  await file.put('/outside/secret.sql', 'outside\n')
  await mkdir(`${file.root}/trusted`, { recursive: true })
  await symlink(`${file.dir}/outside/secret.sql`, `${file.root}/trusted/calc.sql`)
  expect(errorOf(await perform(file, { kind: 'trust-done', name: 'calc', outcome: 'approved' }))).toMatch(/is a link/)
  expect(await file.file('/outside/secret.sql')).toBe('outside\n')
  await file.done()

  const draft = await fake(files())
  await asking(draft)
  await approved(draft)
  await draft.put('/outside/other.sql', CODE)
  await rm(`${draft.analysis}/lib/trusted/calc.sql`)
  await symlink(`${draft.dir}/outside/other.sql`, `${draft.analysis}/lib/trusted/calc.sql`)
  expect(errorOf(await perform(draft, { kind: 'trust-done', name: 'calc', outcome: 'approved' }))).toMatch(/not a regular file/)
  expect(await draft.file('/work/trusted/calc.sql')).toBeUndefined()
  await draft.done()
})

test('a git that cannot run, add or commit still leaves the approved files copied, and the message says why', async () => {
  const cases: [string, (argv: readonly string[]) => object | Promise<object>, RegExp][] = [
    ['no repository', argv => (argv.includes('rev-parse') ? { exitCode: 128 } : {}), /is not in a git repository\.$/],
    ['add fails', argv => (argv.includes('add') ? { exitCode: 1, stderr: 'fatal: bad index\n' } : {}), /git add failed: fatal: bad index$/],
    ['commit fails', argv => (argv.includes('commit') ? { exitCode: 1, stderr: 'hook said no\nfatal: aborted\n' } : { exitCode: argv.includes('diff') ? 1 : 0 }), /git commit failed: fatal: aborted$/],
    ['git throws', () => Promise.reject(new Error('no git')), /is not in a git repository\.$/],
  ]
  for (const [, run, message] of cases) {
    const ws = await fake(files())
    await asking(ws)
    await approved(ws)
    ws.setRun(run)
    expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'approved' })).toEqual({ ok: true })
    expect((await stateOf(ws))?.message).toMatch(message)
    expect((await stateOf(ws))?.message).toMatch(/^Trusted calc: recorded in the app, copied to trusted\/\. Git history not written: /)
    expect(await ws.file('/work/trusted/calc.sql')).toBe(CODE)
    await ws.done()
  }
})

test('every git call has a timeout, and a git that timed out still settles the approval and reports the history problem', async () => {
  const ws = await fake(files())
  await asking(ws)
  await approved(ws)
  const timeouts: unknown[] = []
  ws.setRun((argv, options) => {
    if (argv[0] !== 'git') return {}
    timeouts.push(options?.timeoutMs)
    return argv.includes('add') ? { exitCode: 124, stderr: 'Timed out after 30 s.' } : {}
  })
  expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'approved' })).toEqual({ ok: true })
  expect(timeouts.length).toBeGreaterThan(0)
  expect(timeouts.every(each => each === 30_000)).toBe(true)
  expect((await stateOf(ws))?.state).not.toBe('asking')
  expect((await stateOf(ws))?.message).toMatch(/Git history not written: git add failed: Timed out after 30 s\./)
  expect(await ws.file('/work/trusted/calc.sql')).toBe(CODE)
  await ws.done()
})

test('an approval that changes nothing still reports a git failure', async () => {
  const ws = await fake(files())
  await asking(ws)
  await approved(ws)
  ws.setRun(argv => (argv.includes('rev-parse') ? { exitCode: 128 } : {}))
  expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'unchanged' })).toEqual({ ok: true })
  expect((await stateOf(ws))?.message).toMatch(/^Git history not written: .*is not in a git repository\. Already trusted: no changes\./)
  await ws.done()
})

test('a draft edited while the server commits is kept, not removed; a shared file already equal is not rewritten', async () => {
  const ws = await fake(files())
  await asking(ws)
  await approved(ws)
  await ws.put('/work/trusted/calc.sql', CODE)
  ws.setRun(async argv => {
    if (argv.includes('rev-parse')) await ws.put('lib/trusted/calc.sql', 'SELECT edited\n')
    return {}
  })
  expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'unchanged' })).toEqual({ ok: true })
  expect((await stateOf(ws))?.message).toBe('Already trusted: no changes. Kept the draft calc.sql: it changed after the approval.')
  expect(await ws.file('lib/trusted/calc.sql')).toBe('SELECT edited\n')
  expect(await ws.file('/work/trusted/calc.sql')).toBe(CODE)
  await ws.done()
})

test('a linked ledger, a linked draft folder or a shared folder that cannot be made approves nothing', async () => {
  const ledger = await fake(files())
  await asking(ledger)
  await ledger.put('/outside/ledger.json', '{}')
  await mkdir(`${ledger.dir}/ledger`, { recursive: true })
  await symlink(`${ledger.dir}/outside/ledger.json`, `${ledger.dir}/ledger/ledger.json`)
  expect(errorOf(await perform(ledger, { kind: 'trust-done', name: 'calc', outcome: 'approved' }))).toMatch(/no entry/)
  await ledger.done()

  const folder = await fake(files())
  await asking(folder)
  await approved(folder)
  await folder.put('/elsewhere/calc.sql', CODE)
  await rm(`${folder.analysis}/lib/trusted`, { recursive: true })
  await symlink(`${folder.dir}/elsewhere`, `${folder.analysis}/lib/trusted`, 'dir')
  expect(errorOf(await perform(folder, { kind: 'trust-done', name: 'calc', outcome: 'approved' }))).toMatch(/is a link\./)
  await folder.done()

  const blocked = await fake(files({ 'unrelated': '' }))
  await asking(blocked)
  await approved(blocked)
  await blocked.put('/work/trusted', 'a file, not a folder')
  expect(errorOf(await perform(blocked, { kind: 'trust-done', name: 'calc', outcome: 'approved' }))).toMatch(/^Could not copy calc into trusted\//)
  await blocked.done()
})

test('trust-done for a review that is still checking, or for another name, is refused', async () => {
  const ws = await fake(files())
  ws.setRun(() => ({}))
  await perform(ws, { kind: 'trust-check', name: 'calc' })
  await helper(ws)
  expect(await waitFor(ws, 'checking')).toBe(true)
  expect(await perform(ws, { kind: 'trust-done', name: 'calc', outcome: 'approved' })).toEqual({ error: 'The review of calc is checking, not waiting for an answer.' })
  expect(await perform(ws, { kind: 'trust-done', name: 'other', outcome: 'approved' })).toEqual({ error: 'No review of other is waiting for an answer.' })
  expect((await stateOf(ws))?.state).toBe('checking')
  await ws.done()
})

test('a trust-answer request file is refused: only the app approves, in main', async () => {
  const ws = await fake(files())
  await asking(ws)
  await ws.put('.assay/requests/1-a.json', JSON.stringify({ kind: 'trust-answer', name: 'calc', answer: 'trust' }))
  await ws.requests.poll()
  expect(JSON.parse((await ws.file('.assay/replies/1-a.json')) ?? '{}')).toMatchObject({ error: 'Unknown request kind: trust-answer.' })
  expect((await stateOf(ws))?.state).toBe('asking')
  expect(await ws.file('/work/trusted/calc.sql')).toBeUndefined()
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

const STEP = { event: 'step', step: STEPS[0] }
const DONE = { event: 'done', answer: CHECKED }

test('events out of order fail the check: a second start, a start after a step, a second done, or anything after done', async () => {
  const cases: object[][] = [
    [START, START, DONE],
    [STEP, START, DONE],
    [START, DONE, DONE],
    [START, DONE, STEP],
  ]
  for (const events of cases) {
    const ws = await fake(files())
    await perform(ws, { kind: 'trust-check', name: 'calc' })
    const check = await helper(ws)
    // One write, as a helper that forged its own done would print.
    check.print(events.map(event => `${JSON.stringify(event)}\n`).join(''))
    check.end(0)
    expect(await waitFor(ws, 'error')).toBe(true)
    expect((await stateOf(ws))?.message).toMatch(/out of order/)
    await ws.done()
  }
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
  expect(serve.argv.slice(5)).toEqual(['check-entry', `${ws.analysis}/lib/dictionaries/a.b.c.yaml`, ws.analysis, '--stream'])
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
