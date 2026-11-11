// A SQL run's lineage and steps (docs/slice-9.md, slice 9c): `analysis_sql lineage` and `steps` plan them; each step's
// preview and counts run on the run's engine, saved beside the run in queries/. Steps are not runs: they claim no
// number and leave `.assay/runs.json` alone.
import { rm } from 'node:fs/promises'

import { POSTGRES_MARK } from '../core/engines.ts'
import type { LineageFile } from '../core/lineage.ts'
import { queryLabel, toCsv } from '../core/pythonRuns.ts'
import type { Engine } from '../core/runs.ts'
import { codeBody, parseRunHeader, parseRuns } from '../core/runs.ts'
import { stepChecks, stepFiles, stepNoticeLine, stepSlug } from '../core/steps.ts'
import type { PlannedJoin, Step, StepsFile } from '../core/steps.ts'
import { message, QUERIES, STEP_NOTICES } from './assay.ts'
import type { Assay } from './assay.ts'
import { expandedFile, queryFile } from './sqlRun.ts'

const HELPER_MS = 30_000
const BLOCKS_LINE = /^-- blocks: (\S+)\s*$/m
const TRUSTED_STEPS_NOTE = "Steps run only SQL written in the run: a trusted calculation's arguments are not replayed."

/** One step of what `python -m analysis_sql steps` prints. */
type Planned = { k: number; name: string; node: number; preview: string | null; counts: string; grain?: string[]; joins?: PlannedJoin[]; block?: string }

/** What `python -m analysis_sql steps` prints. */
type StepPlan = { lineage: LineageFile; steps: Planned[]; note?: string }

/** The steps of one run as they run: the file rewritten at each change. */
type Stepping = { assay: Assay; number: number; engine: Engine; file: StepsFile; save: () => Promise<void> }

/**
 * Run `number`'s header and the body Steps reads; undefined when there is no such run. A run with includes reads as
 * its expanded SQL, with `blocks` (`sessions=client_entry_sessions,...`) naming the CTEs that hold a block.
 */
async function savedRun(assay: Assay, number: number) {
  const run = parseRuns(await assay.names(QUERIES)).find(each => each.number === number)
  if (run?.code === undefined) return undefined
  const isPython = run.language === 'python'
  const text = await assay.readText(`${QUERIES}/${run.code}`)
  const header = parseRunHeader(text, run.language)
  const expanded = isPython ? '' : await assay.readText(expandedFile(number))
  const language = isPython ? 'python' : 'sql'
  const body = expanded ? codeBody(expanded.replace(BLOCKS_LINE, ''), 'sql').replace(/^\n/, '') : codeBody(text, language)
  const blocks = BLOCKS_LINE.exec(expanded)?.[1]
  // A trusted run whose body is `-- python:` is a Python calculation.
  return { header, body, ...(blocks ? { blocks } : {}), python: isPython || (header.trusted !== undefined && /^-- python:/m.test(body)) }
}

const lineagePath = (number: number) => `${QUERIES}/${queryLabel(number)}.lineage.json`
const stepsPath = (number: number) => `${QUERIES}/${queryLabel(number)}.steps.json`
const writeLineage = (assay: Assay, number: number, answer: LineageFile | { error: string }) =>
  assay.writeAtomic(lineagePath(number), `${JSON.stringify(answer)}\n`)

/**
 * Writes `queries/NNN.lineage.json` for SQL run `number`: the CTE graph from `analysis_sql lineage`, or `{error}` when
 * there is none. Undefined on success, else why the run has no file to write for.
 */
export async function lineage(assay: Assay, number: number): Promise<string | undefined> {
  const saved = await savedRun(assay, number)
  if (!saved) return `No run ${queryLabel(number)}.`
  if (saved.python) {
    await writeLineage(assay, number, { error: 'Steps reads SQL runs.' })
    return undefined
  }
  // A trusted run's body is the template, with its `:name` parameters.
  const args = ['lineage', saved.header.engine, ...(saved.header.trusted ? ['--template'] : []), ...(saved.blocks ? ['--blocks', saved.blocks] : [])]
  await writeLineage(assay, number, await assay.helper<LineageFile>(args, HELPER_MS, 'analysis_sql', saved.body))
  return undefined
}

/**
 * Runs SQL run `number` one CTE at a time: each step's preview (50 rows, saved as a .csv) and counts, with
 * `queries/NNN.steps.json` rewritten as each step starts and ends. Undefined on success, else why there is nothing to run.
 */
export async function runSteps(assay: Assay, number: number): Promise<string | undefined> {
  const saved = await savedRun(assay, number)
  if (!saved) return `No run ${queryLabel(number)}.`
  await clearSteps(assay, number)
  if (saved.python) return lineage(assay, number)
  const save = (file: StepsFile) => assay.writeAtomic(stepsPath(number), `${JSON.stringify(file)}\n`)
  if (saved.header.trusted) {
    const failed = await lineage(assay, number)
    if (!failed) await save({ run: number, status: 'done', note: TRUSTED_STEPS_NOTE, steps: [] })
    return failed
  }
  const engine = saved.header.engine
  const plan = await assay.helper<StepPlan>(['steps', engine, ...(saved.blocks ? ['--blocks', saved.blocks] : [])], HELPER_MS, 'analysis_sql', saved.body)
  if ('error' in plan) {
    await writeLineage(assay, number, { error: plan.error })
    await save({ run: number, status: 'error', note: plan.error, steps: [] })
    return undefined
  }
  await writeLineage(assay, number, plan.lineage)
  const pairs = plan.steps.map(planned => ({ planned, step: pendingStep(planned) }))
  const file: StepsFile = { run: number, status: pairs.length > 0 ? 'running' : 'done', ...(plan.note ? { note: plan.note } : {}), steps: pairs.map(pair => pair.step) }
  await save(file)
  await runPlanned({ assay, number, engine, file, save: () => save(file) }, pairs)
  return undefined
}

/** A request always re-runs: the earlier files go first. */
async function clearSteps(assay: Assay, number: number) {
  for (const old of stepFiles(await assay.names(QUERIES), number)) {
    for (const name of [old.sql, old.csv, old.counts]) if (name) await rm(assay.at(`${QUERIES}/${name}`), { force: true })
  }
  await rm(assay.at(stepsPath(number)), { force: true })
}

function pendingStep({ k, name, node, grain, joins, block }: Planned): Step {
  return { k, name, node, status: 'pending', ...(grain ? { grain } : {}), ...(joins ? { joins } : {}), ...(block ? { block } : {}) }
}

/** Each step in turn; after a failed one, the rest are skipped. */
async function runPlanned(stepping: Stepping, pairs: { planned: Planned; step: Step }[]) {
  let failed = false
  for (const { planned, step } of pairs) {
    if (failed) {
      step.status = 'skipped'
      await stepping.save()
      continue
    }
    step.status = 'running'
    await stepping.save()
    const error = await runStep(stepping, planned, step)
    if (error !== undefined) {
      step.status = 'error'
      step.error = error
      failed = true
    }
    await stepping.save()
  }
  stepping.file.status = failed ? 'error' : 'done'
  await stepping.save()
}

/** One step's preview, then its counts; why it failed, if it did. */
async function runStep(stepping: Stepping, planned: Planned, step: Step): Promise<string | undefined> {
  const { assay, engine } = stepping
  const mark = engine === 'postgres' ? `${POSTGRES_MARK}\n` : ''
  const base = `${QUERIES}/${queryLabel(stepping.number)}.${String(planned.k)}_${stepSlug(planned.name)}`
  if (planned.preview !== null) {
    await assay.write(`${base}.sql`, `${mark}${planned.preview}\n`)
    const rows = await queryFile(assay, engine, `${base}.sql`).catch((error: unknown) => ({ error: message(error) }))
    if ('error' in rows) return rows.error
    await assay.write(`${base}.csv`, toCsv(rows.columns, rows.rows))
  }
  await assay.write(`${base}.counts.sql`, `${mark}${planned.counts}\n`)
  const counted = await queryFile(assay, engine, `${base}.counts.sql`).catch((error: unknown) => ({ error: message(error) }))
  if ('error' in counted) return counted.error
  const row = counted.rows[0]
  if (!row) return 'The counts query returned no row.'
  await count(stepping, step, Object.fromEntries(counted.columns.map((column, c) => [column.toLowerCase(), row[c] ?? ''])))
  return undefined
}

/** A step's counts and the checks on them; each failed check is a notice for the next prompt. */
async function count(stepping: Stepping, step: Step, counts: Record<string, string>) {
  step.counts = counts
  // An empty cell is no count, not 0 rows.
  const rowCount = counts.assay_rows ?? ''
  if (/^\d+$/.test(rowCount)) step.rows = Number(rowCount)
  step.status = 'ok'
  // Saved as each step finishes: a server stopped mid-run keeps the notices of the steps that already failed.
  step.checks = stepChecks(step, counts)
  for (const check of step.checks) if (!check.ok) await stepping.assay.append(STEP_NOTICES, stepNoticeLine(stepping.number, step, check))
}
