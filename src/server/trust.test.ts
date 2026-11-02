// The analysis mod's trusted-calculation and trust-review tests (config b2f7df2, claude/analysis/tests/trust.test.tsx
// and dictionary.test.ts), ported. The review is started and answered by the app's requests now, never by a tool:
// `/an trust` and its question dialog are gone, so "text under Other" and "a dismissed dialog" have no counterpart;
// an answer outside `asking` is refused instead.
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { citationLabel } from '../core/citationLabels.ts'
import { VENV_ASSAY_HINT } from '../core/rules.ts'
import { answering, fake, until } from './testing.ts'
import type { Fake, Run, Serve } from './testing.ts'

/** The label a citation of run `number` in the scratch analysis gets, from its files on disk. */
const labelOf = (ws: Fake, number: number, currentCommit?: (name: string) => Promise<string | undefined>) =>
  citationLabel({ fs: { readdir: path => readdir(path), readFile: path => readFile(path, 'utf8') }, root: ws.root, ...(currentCommit ? { currentCommit } : {}) }, { analysis: 'feature', number })

const COMPLETES = {
  name: 'completes_by_site',
  kind: 'sql',
  file: 'completes_by_site.sql',
  description: 'Completes per site between two days.',
  parameters: [
    { name: 'start', type: 'date', required: true },
    { name: 'status', type: 'string', required: false },
  ],
  sql: 'SELECT site_id, count(*) AS completes FROM main.panel.surveys WHERE day >= :start AND status = :status GROUP BY site_id',
  commit: 'abc123def456',
  dirty: false,
}
const TOP = { name: 'top_sites', kind: 'python', file: 'top_sites.py', description: 'The busiest sites.', parameters: [], commit: '0123456789ab', dirty: false }

type Answers = { list?: object; run?: object; check?: object; dictionary?: object; render?: object }
const python = (ws: Fake) => `${ws.venv}/bin/python`

/** The helper answers by command, git succeeds, and the warehouse answers every query. */
function scripted(ws: Fake, answers: Answers, git: (readonly string[])[] = [], isUnchanged = false): Run {
  return argv => {
    if (argv[0] === python(ws)) {
      const command = argv[3] as keyof Answers
      return { stdout: JSON.stringify(answers[command] ?? { tables: [], glossary: {} }) }
    }
    if (argv[0] === 'git') {
      git.push(argv)
      // `git diff --cached --quiet` exits 1 when something is staged.
      if (argv.includes('diff')) return { exitCode: isUnchanged ? 0 : 1 }
      return { stdout: argv.includes('rev-parse') ? ws.root : '' }
    }
    return answering([['1']], ['n'])(argv)
  }
}

const files = (extra: Record<string, string> = {}) => ({ 'analysis.yaml': 'title: Feature\n', '/opt/venv-assay/bin/python': '', ...extra })

test('trusted runs a calculation by name: arguments checked, the run recorded with its commit, a citation of it is trusted, stale once its calculation has a newer commit', async () => {
  const ws = await fake(files())
  ws.setRun(scripted(ws, { list: { calculations: [COMPLETES, TOP], problems: [] }, run: { columns: ['site_id', 'completes'], rows: [['10', '2']] } }))
  const ran = await ws.call('trusted', { name: 'completes_by_site', args: { start: '2026-01-01' } })
  expect(ran).toBe('Query 001 (trusted completes_by_site): 1 row. Columns: site_id, completes\nsite_id  completes\n10       2')
  expect(ws.runs.find(argv => argv[3] === 'run')).toEqual([python(ws), '-m', 'analysis_trust', 'run', ws.root, 'completes_by_site', '{"start":"2026-01-01"}', ws.analysis])
  expect(await ws.file('queries/001_completes-by-site.sql')).toBe(`-- trusted: completes_by_site\n-- args: {"start":"2026-01-01"}\n-- commit: abc123def456\n${COMPLETES.sql}\n`)
  expect(await ws.file('queries/001_completes-by-site.csv')).toBe('site_id,completes\n10,2\n')
  expect(await labelOf(ws, 1)).toBe('trusted')
  expect(await labelOf(ws, 1, async () => 'ffffffffffff')).toBe('stale')
  await ws.call('sql', { sql: 'SELECT 1 AS n', slug: 'own' })
  expect(await labelOf(ws, 2)).toBe('queried')
  expect(await ws.call('trusted', { name: 'top_sites' })).toMatch(/^Query 003 \(trusted top_sites\)/)
  expect(await ws.file('queries/003_top-sites.sql')).toBe('-- trusted: top_sites\n-- args: {}\n-- commit: 0123456789ab\n-- python: trusted/top_sites.py\n')
  await ws.done()
})

test('trusted refuses bad arguments, unknown names and a calculation changed since its commit', async () => {
  const ws = await fake(files())
  ws.setRun(scripted(ws, { list: { calculations: [COMPLETES, { ...TOP, dirty: true }], problems: [] } }))
  const call = (name: string, args?: object) => ws.call('trusted', { name, ...(args ? { args } : {}) })
  expect(await call('completes_by_site')).toBe('Missing argument: start (date). completes_by_site(start: date, status?: string)')
  expect(await call('completes_by_site', { start: 'Jan 1' })).toMatch(/^Argument start must be a date as YYYY-MM-DD\./)
  expect(await call('completes_by_site', { start: '2026-01-01', status: 1 })).toMatch(/^Argument status must be a string\./)
  expect(await call('completes_by_site', { start: '2026-01-01', site: 'x' })).toMatch(/^Unknown arguments: site\. It takes start, status\./)
  expect(await call('nope')).toBe('No trusted calculation nope. There are: completes_by_site, top_sites.')
  expect(await call('top_sites')).toBe('trusted/top_sites.py differs from its last commit, or was never committed: it is not trusted until the user approves it again in the Trust tab in Assay. Write your own SQL instead, and say why.')
  expect(await call(' ')).toBe('Give the trusted calculation by name.')
  expect(ws.runs.some(argv => argv[3] === 'run')).toBe(false)
  expect(await ws.list('queries')).toEqual([])
  await ws.done()
})

test('trusted without venv-assay built says how to build it, even with a project .venv', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', '.venv/bin/python': '' })
  expect(await ws.call('trusted', { name: 'completes_by_site' })).toBe(`Cannot list the trusted calculations: ${VENV_ASSAY_HINT}`)
  expect(ws.runs.some(argv => argv[2] === 'analysis_trust')).toBe(false)
  await ws.done()
})

test('a dictionary definition runs as <table>:<name>: names checked by the helper, the query it built recorded', async () => {
  const definition = {
    name: 'main.panel.surveys:completes',
    kind: 'definition',
    file: 'main.panel.surveys.yaml',
    path: 'dictionaries/main.panel.surveys.yaml',
    description: 'metric on main.panel.surveys: Surveys finished.',
    parameters: [
      { name: 'by', type: 'list', required: false },
      { name: 'filters', type: 'list', required: false },
    ],
    commit: 'fedcba987654',
    dirty: false,
  }
  const sql = "SELECT `site_id`, count_if(status = 'C') AS `completes` FROM `main`.`panel`.`surveys` GROUP BY `site_id`"
  const ws = await fake(files())
  ws.setRun(scripted(ws, { list: { calculations: [definition], problems: [] }, render: { sql }, run: { columns: ['site_id', 'completes'], rows: [['10', '1']] } }))
  expect(await ws.call('trusted', { name: definition.name, args: { by: 'site_id' } })).toBe('Argument by must be a list of names. main.panel.surveys:completes(by?: list, filters?: list)')
  expect(await ws.call('trusted', { name: definition.name, args: { by: ['site_id'] } })).toMatch(/^Query 001 \(trusted main\.panel\.surveys:completes\): 1 row\./)
  expect(ws.runs.find(argv => argv[3] === 'render')).toEqual([python(ws), '-m', 'analysis_trust', 'render', ws.root, definition.name, '{"by":["site_id"]}'])
  expect(await ws.file('queries/001_main-panel-surveys-completes.sql')).toBe(`-- trusted: main.panel.surveys:completes\n-- args: {"by":["site_id"]}\n-- commit: fedcba987654\n${sql}\n`)
  expect(await labelOf(ws, 1)).toBe('trusted')
  ws.setRun(scripted(ws, { list: { calculations: [{ ...definition, dirty: true }], problems: [] } }))
  expect(await ws.call('trusted', { name: definition.name })).toMatch(/^dictionaries\/main\.panel\.surveys\.yaml differs from its last commit/)
  await ws.done()
})

// ---------------------------------------------------------------------------
// The data dictionary on a query's first touch of a table.

const SURVEYS = 'description: One row per survey.\ncolumns:\n  - name: id\n    type: bigint\n'
const dictionary = (tables: object[], glossary: Record<string, string> = {}) => ({ tables, glossary })

test('the first query touching a table gets its dictionary entry and glossary terms; the next does not', async () => {
  const ws = await fake(files())
  ws.setRun(scripted(ws, { dictionary: dictionary([{ name: 'surveys', entry: 'main.panel.surveys', text: SURVEYS, terms: ['complete'] }], { complete: 'A finished survey.' }) }))
  const first = await ws.call('sql', { sql: 'SELECT count(*) AS n FROM surveys', slug: 'count' })
  expect(ws.runs.at(-1)).toEqual([python(ws), '-m', 'analysis_trust', 'dictionary', ws.root, `${ws.analysis}/queries/001_count.sql`])
  expect(first).toBe(['Query 001: 1 row. Columns: n', 'n', '1', '', 'Data dictionary (first use this session):', '## main.panel.surveys', SURVEYS.trimEnd(), 'Glossary:', '- complete: A finished survey.'].join('\n'))
  expect(await ws.call('sql', { sql: 'SELECT 1 AS n FROM surveys', slug: 'again' })).toBe('Query 002: 1 row. Columns: n\nn\n1')
  await ws.done()
})

test('a table without an entry gets the drafting rule once; a short name is asked to be qualified', async () => {
  const ws = await fake(files())
  ws.setRun(scripted(ws, { dictionary: dictionary([{ name: 'main.panel.sites' }, { name: 'quotas' }]) }))
  const first = await ws.call('sql', { sql: 'SELECT 1 AS n', slug: 'a' })
  expect(first).toContain('No data dictionary entry for main.panel.sites. Draft one in lib/dictionaries/main.panel.sites.yaml')
  expect(first).toContain('when the user approves it in the Trust tab in Assay')
  expect(first).toContain('No data dictionary entry for quotas. To draft one, find its catalog and schema')
  expect(await ws.call('sql', { sql: 'SELECT 1 AS n', slug: 'b' })).not.toContain('dictionary')
  await ws.done()
})

test('a postgres query, or a helper that fails, adds nothing', async () => {
  const ws = await fake(files())
  ws.setRun(argv => (argv[0] === python(ws) ? { exitCode: 1, stdout: '{"error": "ParseError: bad"}' } : { stdout: 'n\n1\n' }))
  expect(await ws.call('sql', { sql: 'SELECT 1 AS n', slug: 'pg', engine: 'postgres' })).toBe('Query 001: 1 row. Columns: n\nn\n1')
  expect(ws.runs.some(argv => argv[0] === python(ws))).toBe(false)
  ws.setRun(argv => (argv[0] === python(ws) ? { exitCode: 1, stdout: '{"error": "ParseError: bad"}' } : answering([['1']], ['n'])(argv)))
  expect(await ws.call('sql', { sql: 'SELECT 1 AS n', slug: 'db' })).toBe('Query 002: 1 row. Columns: n\nn\n1')
  await ws.done()
})

test('the helper always runs under venv-assay, never a project .venv', async () => {
  const ws = await fake(files({ '/work/.venv/bin/python': '' }))
  ws.setRun(scripted(ws, { dictionary: dictionary([{ name: 'surveys', entry: 'main.panel.surveys', text: SURVEYS, terms: [] }]) }))
  await ws.call('sql', { sql: 'SELECT count(*) AS n FROM surveys', slug: 'count' })
  expect(ws.runs.some(argv => argv[0] === python(ws) && argv[2] === 'analysis_trust')).toBe(true)
  expect(ws.runs.some(argv => argv[0] === `${ws.root}/.venv/bin/python`)).toBe(false)
  await ws.done()
})

// ---------------------------------------------------------------------------
// The trust review, through the app's requests.

const CODE = '/*---\ndescription: Completes per site between two days.\n---*/\nSELECT 1\n'
const STEPS = [
  { step: 'form', ok: true, text: 'SQL template, 2 parameters' },
  { step: 'transpile', ok: true, text: 'SELECT 1' },
  { step: 'test', ok: true, text: 'PASSED', name: 'case 1' },
  { step: 'live', ok: true, text: '2 rows with {}' },
]
const SAMPLE = { columns: ['site_id', 'completes'], rows: [['10', '2'], ['11', '1']], total: 2 }
const START = {
  event: 'start',
  name: 'completes_by_site',
  kind: 'sql',
  file: 'completes_by_site.sql',
  description: 'Completes per site between two days.',
  code: CODE,
  files: ['completes_by_site.sql', 'completes_by_site.test.yaml'],
}
const CHECKED = { ...START, ok: true, steps: STEPS, sample: SAMPLE }
const PROPOSAL = {
  'lib/trusted/completes_by_site.sql': CODE,
  'lib/trusted/completes_by_site.test.yaml': 'cases: []\n',
  'lib/trusted/test_helpers.py': '',
  'lib/dictionaries/main.panel.sites.yaml': 'description: Sites.\n',
}

const isCheck = (argv: readonly string[]) => argv.includes('--stream')
const checks = (ws: Fake) => ws.serves.filter(serve => isCheck(serve.argv))
/** The helper process of the review, once the server started it. */
async function checking(ws: Fake): Promise<Serve> {
  expect(await until(() => checks(ws).length > 0)).toBe(true)
  return checks(ws).at(-1)!
}
const stored = async (ws: Fake, name = 'completes_by_site') => JSON.parse((await ws.file(`.assay/trust/${name}.json`)) ?? 'null') as Record<string, unknown> | null
const stateOf = async (ws: Fake, name?: string) => (await stored(ws, name))?.state
/** Feeds a whole passing run of the helper. */
const passing = (check: Serve) => {
  check.emit(START)
  for (const step of STEPS) check.emit({ event: 'step', step })
  check.emit({ event: 'done', answer: CHECKED })
}
const perform = (ws: Fake, request: object) => ws.requests.perform(request as never)

test('trust-list lists the proposals; trust-check starts the streamed checks', async () => {
  const ws = await fake(files(PROPOSAL))
  expect(await perform(ws, { kind: 'trust-list' })).toEqual({
    proposals: [
      { name: 'completes_by_site', kind: 'calculation', folder: 'lib/trusted' },
      { name: 'main.panel.sites', kind: 'dictionary', folder: 'lib/dictionaries' },
    ],
  })
  expect(await perform(ws, { kind: 'trust-check', name: 'gone' })).toEqual({ error: 'No proposal gone in lib/trusted/ or lib/dictionaries/.' })
  expect(await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })).toEqual({ ok: true })
  const check = await checking(ws)
  expect(check.argv).toEqual([python(ws), '-m', 'analysis_trust', 'check', `${ws.analysis}/lib/trusted`, 'completes_by_site', ws.analysis, '--stream'])
  expect(check.cwd).toBe(ws.analysis)
  await ws.done()
})

test('the review is the trust file through every state; trust-answer trust approves: committed, the unchanged draft removed', async () => {
  const git: (readonly string[])[] = []
  const ws = await fake(files(PROPOSAL))
  ws.setRun(scripted(ws, {}, git))
  await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })
  const check = await checking(ws)
  expect(await until(async () => (await stateOf(ws)) === 'checking')).toBe(true)
  expect(await stored(ws)).toMatchObject({ name: 'completes_by_site', kind: 'calculation', what: 'SQL template', language: 'sql', replaces: false, steps: [] })
  expect(typeof (await stored(ws))?.startedAt).toBe('number')

  check.emit(START)
  expect(await until(async () => (await stored(ws))?.code === CODE)).toBe(true)
  expect(await stored(ws)).toMatchObject({ state: 'checking', description: 'Completes per site between two days.' })
  check.emit({ event: 'step', step: STEPS[0] })
  check.emit({ event: 'step', step: STEPS[1] })
  expect(await until(async () => ((await stored(ws))?.steps as unknown[]).length === 2)).toBe(true)
  // Asked to answer while checking: refused.
  expect(await perform(ws, { kind: 'trust-answer', name: 'completes_by_site', answer: 'trust' })).toEqual({ error: 'The review of completes_by_site is checking, not waiting for an answer.' })
  for (const step of STEPS.slice(2)) check.emit({ event: 'step', step })
  check.emit({ event: 'done', answer: CHECKED })

  expect(await until(async () => (await stateOf(ws)) === 'asking')).toBe(true)
  expect(await stored(ws)).toMatchObject({ state: 'asking', steps: STEPS, sample: SAMPLE })
  // Claude changes the proposal after the check: what was checked is what lands.
  await ws.put('lib/trusted/completes_by_site.sql', 'SELECT 2\n')
  expect(await perform(ws, { kind: 'trust-answer', name: 'completes_by_site', answer: 'trust' })).toEqual({ ok: true })

  expect(await stateOf(ws)).toBe('approved')
  expect(await stored(ws)).toMatchObject({ message: 'Trusted completes_by_site: committed in trusted/. Kept the draft lib/trusted/completes_by_site.sql: it changed after the check.' })
  expect(typeof (await stored(ws))?.endedAt).toBe('number')
  expect(await ws.file('lib/trusted/completes_by_site.test.yaml')).toBeUndefined()
  expect(await ws.file('lib/trusted/completes_by_site.sql')).toBe('SELECT 2\n')
  expect(await ws.file('lib/trusted/test_helpers.py')).toBe('')
  expect(await ws.file('/work/trusted/completes_by_site.sql')).toBe(CODE)
  expect(await ws.file('/work/trusted/completes_by_site.test.yaml')).toBe('cases: []\n')
  const paths = [`${ws.root}/trusted/completes_by_site.sql`, `${ws.root}/trusted/completes_by_site.test.yaml`]
  expect(git).toEqual([
    ['git', '-C', ws.root, 'rev-parse', '--show-toplevel'],
    ['git', '-C', ws.root, 'add', '--', ...paths],
    ['git', '-C', ws.root, 'diff', '--cached', '--quiet', '--', ...paths],
    ['git', '-C', ws.root, 'commit', '-q', '-m', 'trusted: approve completes_by_site', '-m', "Approved by the user in Assay's Trust tab.", '--', ...paths],
  ])
  // Answered once: a second answer is refused.
  expect(await perform(ws, { kind: 'trust-answer', name: 'completes_by_site', answer: 'trust' })).toEqual({ error: 'No review of completes_by_site is waiting for an answer.' })
  await ws.done()
})

test('a review that fails a check is "failed" and cannot be answered', async () => {
  const ws = await fake(files(PROPOSAL))
  await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })
  const check = await checking(ws)
  const bad = { step: 'test', ok: false, text: 'FAILED rows [] != expected []', name: 'case 1', diff: '  a\n- 1\n+ 2' }
  check.emit(START)
  check.emit({ event: 'step', step: STEPS[0] })
  check.emit({ event: 'step', step: bad })
  check.emit({ event: 'done', answer: { ...START, ok: false, steps: [STEPS[0], bad] } })
  expect(await until(async () => (await stateOf(ws)) === 'failed')).toBe(true)
  expect(await stored(ws)).toMatchObject({ message: 'Not approvable: fix the proposal, then check completes_by_site again in the Trust tab in Assay.', steps: [STEPS[0], bad] })
  expect(await perform(ws, { kind: 'trust-answer', name: 'completes_by_site', answer: 'trust' })).toEqual({ error: 'No review of completes_by_site is waiting for an answer.' })
  expect(await ws.file('/work/trusted/completes_by_site.sql')).toBeUndefined()
  await ws.done()
})

test('reject: nothing is copied or committed, and the proposal stays', async () => {
  const git: (readonly string[])[] = []
  const ws = await fake(files(PROPOSAL))
  ws.setRun(scripted(ws, {}, git))
  await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })
  passing(await checking(ws))
  expect(await until(async () => (await stateOf(ws)) === 'asking')).toBe(true)
  expect(await perform(ws, { kind: 'trust-answer', name: 'completes_by_site', answer: 'reject' })).toEqual({ ok: true })
  expect(await stored(ws)).toMatchObject({ state: 'rejected', message: 'Rejected completes_by_site; the proposal stays in lib/trusted/.' })
  expect(git).toEqual([])
  expect(await ws.file('/work/trusted/completes_by_site.sql')).toBeUndefined()
  expect(await ws.file('lib/trusted/completes_by_site.sql')).toBe(CODE)
  await ws.done()
})

test('an answer for another name, or with no review at all, is refused', async () => {
  const ws = await fake(files(PROPOSAL))
  expect(await perform(ws, { kind: 'trust-answer', name: 'completes_by_site', answer: 'trust' })).toEqual({ error: 'No review of completes_by_site is waiting for an answer.' })
  await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })
  passing(await checking(ws))
  expect(await until(async () => (await stateOf(ws)) === 'asking')).toBe(true)
  expect(await perform(ws, { kind: 'trust-answer', name: 'main.panel.sites', answer: 'trust' })).toEqual({ error: 'No review of main.panel.sites is waiting for an answer.' })
  await ws.done()
})

test('files equal to the trusted version end "unchanged" with no commit', async () => {
  const git: (readonly string[])[] = []
  const ws = await fake(files(PROPOSAL))
  ws.setRun(scripted(ws, {}, git, true))
  await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })
  passing(await checking(ws))
  expect(await until(async () => (await stateOf(ws)) === 'asking')).toBe(true)
  await perform(ws, { kind: 'trust-answer', name: 'completes_by_site', answer: 'trust' })
  expect(await stored(ws)).toMatchObject({ state: 'unchanged', message: 'Already trusted: no changes.' })
  expect(git.some(argv => argv.includes('commit'))).toBe(false)
  // Equal to the trusted version, the draft is a stale copy: removed.
  expect(await ws.file('lib/trusted/completes_by_site.sql')).toBeUndefined()
  expect(await ws.file('lib/trusted/completes_by_site.test.yaml')).toBeUndefined()
  await ws.done()
})

test('two reviews started together: the second is refused', async () => {
  const ws = await fake(files(PROPOSAL))
  const answers = await Promise.all([perform(ws, { kind: 'trust-check', name: 'completes_by_site' }), perform(ws, { kind: 'trust-check', name: 'completes_by_site' })])
  expect(answers.filter(each => JSON.stringify(each) === JSON.stringify({ error: 'A review of completes_by_site is in progress: answer it first.' }))).toHaveLength(1)
  expect(await until(() => checks(ws).length === 1)).toBe(true)
  await ws.done()
})

test('a second review is refused while one is checking or asking, and allowed after', async () => {
  const ws = await fake(files(PROPOSAL))
  ws.setRun(scripted(ws, {}))
  await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })
  const check = await checking(ws)
  const busy = { error: 'A review of completes_by_site is in progress: answer it first.' }
  expect(await perform(ws, { kind: 'trust-check', name: 'main.panel.sites' })).toEqual(busy)
  expect(checks(ws)).toHaveLength(1)
  passing(check)
  expect(await until(async () => (await stateOf(ws)) === 'asking')).toBe(true)
  expect(await perform(ws, { kind: 'trust-check', name: 'main.panel.sites' })).toEqual(busy)
  await perform(ws, { kind: 'trust-answer', name: 'completes_by_site', answer: 'reject' })
  expect(await perform(ws, { kind: 'trust-check', name: 'main.panel.sites' })).toEqual({ ok: true })
  await ws.done()
})

test('a drafted dictionary entry is checked with check-entry and approved into dictionaries/', async () => {
  const git: (readonly string[])[] = []
  const ws = await fake(files(PROPOSAL))
  ws.setRun(scripted(ws, {}, git))
  // Names arrive lower-cased from the request parser, as /an trust lower-cased them.
  await ws.put('.assay/requests/1-a.json', JSON.stringify({ kind: 'trust-check', name: 'Main.Panel.Sites' }))
  await ws.requests.poll()
  const check = await checking(ws)
  expect(check.argv).toEqual([python(ws), '-m', 'analysis_trust', 'check-entry', `${ws.analysis}/lib/dictionaries/main.panel.sites.yaml`, ws.analysis, '--stream'])
  const entry = { name: 'main.panel.sites', ok: true, kind: 'dictionary', file: 'main.panel.sites.yaml', code: 'description: Sites.\n', files: ['main.panel.sites.yaml'], steps: [{ step: 'form', ok: true, text: '0 columns' }] }
  check.emit({ event: 'start', ...entry, ok: undefined, steps: undefined })
  check.emit({ event: 'step', step: entry.steps[0] })
  check.emit({ event: 'done', answer: entry })
  expect(await until(async () => (await stateOf(ws, 'main.panel.sites')) === 'asking')).toBe(true)
  expect(await stored(ws, 'main.panel.sites')).toMatchObject({ kind: 'dictionary', what: 'dictionary entry', language: 'yaml' })
  await perform(ws, { kind: 'trust-answer', name: 'main.panel.sites', answer: 'trust' })
  expect(await ws.file('/work/dictionaries/main.panel.sites.yaml')).toBe('description: Sites.\n')
  expect(await stateOf(ws, 'main.panel.sites')).toBe('approved')
  expect(git.at(-1)?.slice(0, 7)).toEqual(['git', '-C', ws.root, 'commit', '-q', '-m', 'trusted: approve main.panel.sites'])
  expect(await stored(ws, 'main.panel.sites')).toMatchObject({ message: 'Trusted main.panel.sites: committed in dictionaries/.' })
  expect(await ws.file('lib/dictionaries/main.panel.sites.yaml')).toBeUndefined()
  await ws.done()
})

test('a helper that cannot run ends the review as an error', async () => {
  const ws = await fake(files(PROPOSAL))
  await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })
  const check = await checking(ws)
  check.print('Traceback: no module named analysis_trust\n', 'stderr')
  check.end(1)
  expect(await until(async () => (await stateOf(ws)) === 'error')).toBe(true)
  expect(await stored(ws)).toMatchObject({ message: 'Traceback: no module named analysis_trust' })
  await ws.done()
})

test('without venv-assay the review ends as an error saying how to build it', async () => {
  const ws = await fake({ 'analysis.yaml': 'title: Feature\n', ...PROPOSAL })
  await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })
  expect(await until(async () => (await stateOf(ws)) === 'error')).toBe(true)
  expect(await stored(ws)).toMatchObject({ message: VENV_ASSAY_HINT })
  await ws.done()
})

test("a new review overwrites that name's file", async () => {
  const ws = await fake(files({ ...PROPOSAL, '.assay/trust/completes_by_site.json': '{"state":"approved"}' }))
  await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })
  expect(await until(async () => (await stateOf(ws)) === 'checking')).toBe(true)
  await ws.done()
})

test('a replaced trusted version is said so', async () => {
  const ws = await fake(files({ ...PROPOSAL, '/work/trusted/completes_by_site.sql': 'SELECT 0\n' }))
  await perform(ws, { kind: 'trust-check', name: 'completes_by_site' })
  expect(await until(async () => (await stored(ws))?.replaces === true)).toBe(true)
  await ws.done()
})

test('no tool of Claude starts or answers a review', async () => {
  const { TOOLS } = await import('./tools.ts')
  expect(TOOLS.map(tool => tool.name).filter(name => /trust/.test(name))).toEqual(['trusted'])
  const ws = await fake(files(PROPOSAL))
  expect(await ws.call('trust-check', { name: 'completes_by_site' })).toBe('Unknown tool: trust-check.')
  expect(checks(ws)).toEqual([])
  await ws.done()
})
