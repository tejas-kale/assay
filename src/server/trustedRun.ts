// Claude's `trusted` call: a trusted calculation run by name, its arguments checked, bound and run by
// `analysis_trust`, and the run recorded like a query.
import { checkArgs, runHeader, signature, TRUST_TAB, TRUSTED } from '../core/calculations.ts'
import type { Calculation } from '../core/calculations.ts'
import type { Table } from '../core/engines.ts'
import { runSlug } from '../core/pythonRuns.ts'
import type { Assay } from './assay.ts'
import { QUERY_TIMEOUT_MS } from './sqlRun.ts'

export async function runTrusted(assay: Assay, name: string, given: unknown): Promise<string> {
  const list = await assay.calculations(true)
  if ('error' in list) return `Cannot list the trusted calculations: ${list.error}`
  const calc = list.calculations.find(each => each.name === name)
  if (!calc) return unknown(name, list.calculations.map(each => each.name))
  if (calc.dirty) {
    const path = calc.path ?? `${TRUSTED}/${calc.file}`
    return `${path} is not approved in the app, or changed after it was approved: it is not trusted until the user approves it in ${TRUST_TAB}. Write your own SQL instead, and say why.`
  }
  const checked = checkArgs(calc.parameters, given)
  if ('error' in checked) return `${checked.error} ${signature(calc)}`
  const body = await bodyOf(assay, calc, checked.args)
  if ('error' in body) return `${body.error} ${signature(calc)}`
  const { root, analysis } = assay.config
  const args = JSON.stringify(checked.args)
  return assay.runQuery({
    slug: runSlug(calc.name),
    saved: `${runHeader({ name: calc.name, args: checked.args, commit: calc.commit })}\n${body.sql}\n`,
    hasTables: calc.kind !== 'python',
    named: ` (trusted ${calc.name})`,
    run: async () => {
      const ran = await assay.helper<Table>(['run', root, calc.name, args, analysis], QUERY_TIMEOUT_MS)
      return 'error' in ran ? ran : { columns: ran.columns.map(String), rows: ran.rows.map(row => row.map(String)) }
    },
  })
}

function unknown(name: string, names: string[]) {
  const there = names.length > 0 ? `There are: ${names.join(', ')}.` : 'There are none yet.'
  return `No trusted calculation ${name}. ${there}`
}

/** What the run saves under its header: the template, the Python file it runs, or a definition's query. */
async function bodyOf(assay: Assay, calc: Calculation, args: Record<string, unknown>): Promise<{ sql: string } | { error: string }> {
  if (calc.kind === 'python') return { sql: `-- python: ${TRUSTED}/${calc.file}` }
  if (calc.kind !== 'definition') return { sql: (calc.sql ?? '').trim() }
  // The query a definition's run sends, built (and its names checked) by the helper.
  return assay.helper<{ sql: string }>(['render', assay.config.root, calc.name, JSON.stringify(args)])
}
